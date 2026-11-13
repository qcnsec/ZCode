/**
 * 「卡死自愈」看门狗。
 *
 * 监听 WebContents 的 `unresponsive` / `responsive` 事件，按阈值分级恢复渲染进程。
 *
 * 分级阈值（与功能页 / 产物常量 `V8=[45e3,3e4,4e4]`、`q8=2e3` 完全一致）。
 * ⚠️ 重要：实现中对三个阈值**各自独立**发起 `setTimeout(fn, 阈值)`，并非累计延迟——
 * 因此真实时序是从 `unresponsive` 起 **30s crash / 40s relaunch / 45s reload**（独立计时），
 * 功能页所述的「累计 45/75/115s」是误读，此处以实际实现为准。
 * 日志文案仍沿用累计毫秒（`u` = 45000/75000/115000）以保持一致：
 *   - 阈值 45e3（p=0）：`webContents.reload()`，日志「卡死 45000ms」
 *   - 阈值 3e4（p=1）：`webContents.forcefullyCrashRenderer()`，日志「卡死 75000ms」
 *   - 阈值 4e4（p=2）：`deps.relaunch()`（重启整个应用），日志「卡死 115000ms」
 *
 * 关键语义：
 *   - 每一步升级前都重新做 2s 有界探针（`isFrozen`）：若渲染进程已恢复则取消后续级别。
 *   - 每窗口每 1 小时重置自愈预算（`attempts`）；单个 freeze 事件三级全部升级即令
 *     `attempts` 达 3，使同窗口 1 小时内下一次 freeze 不再动作（防殴打，与产物一致）。
 *   - `runId` 自增用于让过期在飞的升级/探针失效，避免重复动作。
 *
 * 本模块仅 `import type { WebContents }`，运行时不依赖 electron，便于离线单测（探针与
 * relaunch 通过 deps 注入）。实际的 `app.relaunch()` 接线在主进程 `main/index.ts`。
 */

import type { WebContents } from "electron";

/** 分级阈值（毫秒），累计为 45s / 75s / 115s。 */
const QCTRK_HEAL_THRESHOLDS_MS = [45_000, 30_000, 40_000];
/** 有界探针超时（毫秒）。 */
const QCTRK_HEAL_PROBE_TIMEOUT_MS = 2_000;
/** 每窗口自愈预算重置窗口（毫秒）。 */
const QCTRK_HEAL_WINDOW_RESET_MS = 3_600_000;
/** 单窗口单小时内最大自愈次数，超过则停止继续动作。 */
const QCTRK_HEAL_MAX_ATTEMPTS = 3;

export interface QcTrkFreezeHealingDeps {
  /**
   * 主进程侧探针：返回 `true` 表示渲染进程已卡死（无响应）。
   * 实现是 `webContents.executeJavaScript("1", true)`：成功执行即未卡死、失败/挂起即卡死。
   */
  isFrozen: () => Promise<boolean>;
  /** 兜底：重启整个应用（`app.relaunch(); app.exit(0)`）。 */
  relaunch: () => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

interface QcTrkHealState {
  attempts: number;
  windowStartedAt: number;
  timers: ReturnType<typeof setTimeout>[];
  stage: number;
  runId: number;
  probe: Promise<boolean> | null;
}

const healStates = new Map<number, QcTrkHealState>();

export const QCTRK_HEAL_CONFIG = {
  thresholdsMs: QCTRK_HEAL_THRESHOLDS_MS,
  probeTimeoutMs: QCTRK_HEAL_PROBE_TIMEOUT_MS,
  windowResetMs: QCTRK_HEAL_WINDOW_RESET_MS,
  maxAttempts: QCTRK_HEAL_MAX_ATTEMPTS,
};

/** 清空一个窗口的待执行升级定时器。与产物 `clearTimers` 一致。 */
export function clearHealTimers(state: QcTrkHealState): void {
  for (const timer of state.timers) {
    try {
      clearTimeout(timer);
    } catch {
      /* ignore */
    }
  }
  state.timers = [];
}

export function ensureHealState(windowId: number): QcTrkHealState {
  const now = Date.now();
  let state = healStates.get(windowId);
  if (!state || now - state.windowStartedAt > QCTRK_HEAL_WINDOW_RESET_MS) {
    state = {
      attempts: 0,
      windowStartedAt: now,
      timers: [],
      stage: 0,
      runId: 0,
      probe: null,
    };
    healStates.set(windowId, state);
  }
  return state;
}

/**
 * 有界探针：把 `deps.isFrozen()` 与 2s 超时做 race。
 * 与产物一致 —— `isFrozen()` 决议后的值被忽略，仅「拒绝 / 超时」判定为卡死；
 * 这样只要渲染进程能在 2s 内响应一次 JS 执行即视为存活，避免误杀。
 */
export function runBoundedProbe(
  state: QcTrkHealState,
  deps: QcTrkFreezeHealingDeps,
): Promise<boolean> {
  if (state.probe) return state.probe;
  const probe: Promise<boolean> = Promise.race([
    Promise.resolve(deps.isFrozen()).then(
      () => false,
      () => true,
    ),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), QCTRK_HEAL_PROBE_TIMEOUT_MS),
    ),
  ]).finally(() => {
    if (state.probe === probe) state.probe = null;
  });
  state.probe = probe;
  return probe;
}

/**
 * 在给定 WebContents 上安装卡死自愈看门狗，返回清理函数。
 * 与产物 `installFreezeHealing` 语义一致。
 */
export function installFreezeHealing(
  webContents: WebContents,
  deps: QcTrkFreezeHealingDeps,
): () => void {
  const windowId = webContents.id;
  const logger = deps.logger;
  const logInfo = (message: string): void => logger?.info?.(message);
  const logWarn = (message: string): void => logger?.warn?.(message);

  const ensureState = (): QcTrkHealState => ensureHealState(windowId);

  const onUnresponsive = (): void => {
    try {
      const state = ensureState();
      clearHealTimers(state);
      state.probe = null;
      const runId = ++state.runId;
      const isCurrent = (): boolean =>
        state.runId === runId && !webContents.isDestroyed();
      if (state.attempts >= QCTRK_HEAL_MAX_ATTEMPTS) {
        logWarn(
          `[qctrk-heal] window ${windowId} 本小时已自愈 ${state.attempts} 次，停止继续动作（防殴打）`,
        );
        return;
      }
      let cumulative = 0;
      QCTRK_HEAL_THRESHOLDS_MS.forEach((threshold, stage) => {
        cumulative += threshold;
        const stageCumulative = cumulative;
        const timer = setTimeout(() => {
          void (async (): Promise<void> => {
            try {
              if (!isCurrent()) return;
              const frozen = await runBoundedProbe(state, deps);
              if (!isCurrent() || !frozen) {
                if (!frozen) {
                  logInfo(
                    `[qctrk-heal] window ${windowId} 已恢复，取消第 ${stage + 1} 级`,
                  );
                }
                return;
              }
              if (!isCurrent()) return;
              state.attempts += 1;
              state.stage = stage + 1;
              if (stage === 0) {
                logWarn(
                  `[qctrk-heal] window ${windowId} 卡死 ${stageCumulative}ms，reload`,
                );
                webContents.reload();
              } else if (stage === 1) {
                logWarn(
                  `[qctrk-heal] window ${windowId} 仍冻 ${stageCumulative}ms，forcefullyCrashRenderer`,
                );
                webContents.forcefullyCrashRenderer();
              } else {
                logWarn(`[qctrk-heal] window ${windowId} 兜底重启应用`);
                deps.relaunch();
              }
            } catch (error) {
              logWarn(
                `[qctrk-heal] window ${windowId} 第 ${stage + 1} 级失败: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          })();
        }, threshold);
        state.timers.push(timer);
      });
    } catch {
      /* ignore */
    }
  };

  const onResponsive = (): void => {
    try {
      const state = healStates.get(windowId);
      if (!state) return;
      state.runId += 1;
      state.probe = null;
      clearHealTimers(state);
      if (state.stage > 0) {
        logInfo(
          `[qctrk-heal] window ${windowId} 恢复正常（已执行到第 ${state.stage} 级）`,
        );
        state.stage = 0;
      }
    } catch {
      /* ignore */
    }
  };

  webContents.on("unresponsive", onUnresponsive);
  webContents.on("responsive", onResponsive);

  return (): void => {
    try {
      webContents.off("unresponsive", onUnresponsive);
      webContents.off("responsive", onResponsive);
    } catch {
      /* ignore */
    }
    const state = healStates.get(windowId);
    if (state) {
      state.runId += 1;
      state.probe = null;
      clearHealTimers(state);
    }
    healStates.delete(windowId);
  };
}

/**
 * 基于 `webContents.executeJavaScript("1", true)` 的探针：
 * 执行成功即未卡死，失败（含渲染进程无响应导致的挂起被外层超时兜底）即卡死。
 * 与产物 `isFrozen` 实现一致。
 */
export function createWebContentsFrozenProbe(
  webContents: WebContents,
): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    try {
      await webContents.executeJavaScript("1", true);
      return false;
    } catch {
      return true;
    }
  };
}
