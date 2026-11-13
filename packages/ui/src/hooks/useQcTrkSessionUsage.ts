import { useEffect, useRef, useState } from "react";
import type { QcTrkUsageSnapshot } from "@zcode/shared";
import type {
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";

/**
 * 用量数据源：与 完全对齐。
 *
 * 之前本 Fork 在 renderer 用 v4 usage.cumulative 实时估算「本次已用 / 本会话平均」，
 * 导致与 读数偏差。现改为：
 * - 会话级 / 累计值（今日 / 30 天 / 本会话 / 本次 / 本会话平均）直接来自 main 进程
 *   getQcTrkUsage 读 agent DB 的聚合结果（与 v_/b6/v6 同一份 SQL），每 3s 轮询一次；
 * - 只有「实时速度」仍由 renderer 按 v4 usage.cumulative 实时累计 token 估算
 *   （对齐 kQt 的 200ms 采样 + 1s 窗口平均），因为速度需要逐 token 的流式粒度，
 *   DB 行要等每轮请求落库才会有增量。
 *
 * 因此只要两个 app 读的是同一份 agent DB（只跑一个、另一个仅查看时正是如此），
 * 除实时速度外的所有读数都会与 1:1 一致。
 */

const EMPTY_SNAPSHOT: QcTrkUsageSnapshot = {
  tps: 0,
  sessionAverageTps: 0,
  turnUsed: 0,
  sessionUsed: 0,
  todayUsed: 0,
  last30DaysUsed: 0,
};

/** DB 聚合轮询间隔：对齐 kQt 的 EQt=3000。 */
const USAGE_POLL_MS = 3_000;
/** 实时速度采样间隔：对齐 kQt 的 DQt=200（zQt 命名别名）。 */
const SPEED_POLL_MS = 200;
/** 实时速度窗口：对齐 kQt 的 OQt=1000。 */
const SPEED_WINDOW_MS = 1_000;
/** 相邻两次 token 增量间隔超过该值视为非连续输出，不计入速度样本。 */
const ACTIVE_GAP_MS = 2_000;

export interface UseQcTrkSessionUsageParams {
  usage: SessionUsageState | null;
  sessionId: string | null;
  /** 预留： 同口径不依赖 phase 计算速度，这里保留以兼容调用方。 */
  phase?: SessionPhase | null;
}

export function useQcTrkSessionUsage({
  usage,
  sessionId,
}: UseQcTrkSessionUsageParams): QcTrkUsageSnapshot {
  const platform = useOptionalPlatform();
  const qctrk = platform?.qctrk;
  const [snapshot, setSnapshot] = useState<QcTrkUsageSnapshot>(EMPTY_SNAPSHOT);

  /** 最新 v4 实时累计 token，供速度轮询读取（避免依赖 effect 触发频率）。 */
  const usageTotalRef = useRef(0);
  /** DB 聚合快照（今日/30天/本会话/本次/平均），由 3s 轮询写入。 */
  const dbRef = useRef<QcTrkUsageSnapshot>(EMPTY_SNAPSHOT);
  /** 当前实时速度（由 200ms 轮询写入）。 */
  const tpsRef = useRef(0);

  // 维护最新累计 token。
  useEffect(() => {
    if (!usage) {
      usageTotalRef.current = 0;
      return;
    }
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage.cumulative;
    usageTotalRef.current =
      (inputTokens || 0) + (outputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0);
  }, [usage]);

  // DB 聚合：每 3s 轮询 main 的 getQcTrkUsage（读 agent DB，与 同源）。
  useEffect(() => {
    if (!qctrk) return;
    let disposed = false;
    const load = () => {
      void qctrk
        .getUsage(sessionId ?? undefined)
        .then((s) => {
          if (disposed || !s) return;
          dbRef.current = {
            tps: 0,
            sessionAverageTps: s.sessionAverageTps || 0,
            turnUsed: s.turnUsed || 0,
            sessionUsed: s.sessionUsed || 0,
            todayUsed: s.todayUsed || 0,
            last30DaysUsed: s.last30DaysUsed || 0,
          };
        })
        .catch(() => {
          // DB 暂不可用：保留上一次成功值，不把用量清零。
        });
    };
    load();
    const timer = window.setInterval(load, USAGE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [qctrk, sessionId]);

  // 实时速度：对齐 kQt 的 200ms 采样 + 1s 窗口平均，数据源为 v4 实时累计 token。
  // 每 200ms 读一次 usageTotalRef 与 dbRef，合并成最终快照；模型思考 / 等工具（无新 token）
  // 时窗口滑出后自然归零。
  useEffect(() => {
    let lastTotal = usageTotalRef.current;
    let lastAt = Date.now();
    const samples: Array<[number, number]> = [];
    tpsRef.current = 0;
    dbRef.current = EMPTY_SNAPSHOT;
    setSnapshot(EMPTY_SNAPSHOT);

    const id = window.setInterval(() => {
      const now = Date.now();
      const total = usageTotalRef.current;
      if (total > lastTotal && lastAt) {
        const gap = (now - lastAt) / 1_000;
        if (gap > 0 && gap < ACTIVE_GAP_MS / 1_000) {
          samples.push([now, (total - lastTotal) / gap]);
        }
      }
      lastAt = now;
      lastTotal = total;
      while (samples.length > 0) {
        const first = samples[0];
        if (first && now - first[0] > SPEED_WINDOW_MS) samples.shift();
        else break;
      }
      const tps = samples.length
        ? Math.round((samples.reduce((acc, p) => acc + p[1], 0) / samples.length) * 10) / 10
        : 0;
      tpsRef.current = tps;

      const db = dbRef.current;
      setSnapshot((cur) =>
        cur.tps === tps &&
        cur.sessionAverageTps === db.sessionAverageTps &&
        cur.turnUsed === db.turnUsed &&
        cur.sessionUsed === db.sessionUsed &&
        cur.todayUsed === db.todayUsed &&
        cur.last30DaysUsed === db.last30DaysUsed
          ? cur
          : {
              tps,
              sessionAverageTps: db.sessionAverageTps,
              turnUsed: db.turnUsed,
              sessionUsed: db.sessionUsed,
              todayUsed: db.todayUsed,
              last30DaysUsed: db.last30DaysUsed,
            },
      );
    }, SPEED_POLL_MS);
    return () => window.clearInterval(id);
    // 仅在切换会话时重建轮询与基线，避免跨会话 delta 尖峰。
  }, [sessionId]);

  return snapshot;
}
