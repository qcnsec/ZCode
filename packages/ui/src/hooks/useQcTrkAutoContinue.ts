import { useEffect, useRef } from "react";
import type {
  IPlatformService,
  QcTrkAutocontConfig,
  QcTrkAutoContinueFailureLike,
} from "@zcode/shared";
import {
  createQcTrkAutoContinueTracker,
  evaluateQcTrkAutoContinue,
  qctrkAutoContinueFingerprint,
} from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

/**
 * 自动继续 hook。
 *
 * 产物 renderer 主 bundle 中的 t4e({store, identity, sessionId, readOnly, send})：
 * 订阅会话投影、只在 phase=error 且错误可恢复时发一条「继续」，
 * 连续次数上限取配置（默认 3，最大 50），成功一次清零，同一失败指纹去重，
 * 配置缓存 4 秒，取消/额度/鉴权/上下文超限等终局错误不触发。
 *
 * 源码层用 React 的 snapshot 变更驱动 effect 替代 store.subscribe，
 * 语义等价且不需要额外订阅；发送复用 SessionPane 的 handleSendText。
 */

/** 产物 Y0e=4e3：配置缓存 4 秒，避免每个失败帧都读一次 IPC。 */
const AUTO_CONTINUE_CONFIG_CACHE_MS = 4_000;

interface UseQcTrkAutoContinueParams {
  snapshot: ConversationSnapshot | null;
  sessionId: string | null | undefined;
  workspaceKey: string;
  readOnly: boolean;
  /** SessionPane.handleSendText：返回 "sent" / "blocked" / "confirmationRequired" 等 */
  send: (text: string) => Promise<unknown> | unknown;
  platform: IPlatformService | null | undefined;
}

function asFailure(value: unknown): QcTrkAutoContinueFailureLike | null {
  return value && typeof value === "object" ? (value as QcTrkAutoContinueFailureLike) : null;
}

export function useQcTrkAutoContinue({
  snapshot,
  sessionId,
  workspaceKey,
  readOnly,
  send,
  platform,
}: UseQcTrkAutoContinueParams): void {
  const trackerRef = useRef<ReturnType<typeof createQcTrkAutoContinueTracker> | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createQcTrkAutoContinueTracker();
  }
  const sendRef = useRef(send);
  sendRef.current = send;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const lastFingerprintRef = useRef("");
  const configCacheRef = useRef<{ value: QcTrkAutocontConfig | null; at: number }>({
    value: null,
    at: 0,
  });

  const key = `${workspaceKey}|${sessionId ?? ""}`;
  const control = snapshot && snapshot.sessionId === sessionId ? snapshot.control : null;
  const phase = typeof control?.phase === "string" ? control.phase : "";
  const failure = asFailure(control?.lastError);
  const fingerprint = qctrkAutoContinueFingerprint(failure);

  useEffect(() => {
    const tracker = trackerRef.current;
    const qctrk = platform?.qctrk;
    if (!sessionId || readOnly || !qctrk || !tracker) return;

    const normalizedPhase = phase.trim().toLowerCase();
    // 成功（或回到正常态）即清零，下一次失败重新计数。
    if (normalizedPhase === "completed" || normalizedPhase === "success") {
      tracker.reset(key);
      lastFingerprintRef.current = "";
      return;
    }
    if (normalizedPhase !== "error" || !failure) return;
    if (fingerprint === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fingerprint;

    const decision = evaluateQcTrkAutoContinue({ phase, lastError: failure });
    if (!decision.go) return;

    let disposed = false;
    void (async () => {
      const cached = configCacheRef.current;
      let config =
        cached.value && Date.now() - cached.at < AUTO_CONTINUE_CONFIG_CACHE_MS
          ? cached.value
          : null;
      if (!config) {
        try {
          config = await qctrk.getAutocontConfig();
        } catch {
          config = null;
        }
        configCacheRef.current = { value: config, at: Date.now() };
      }
      if (disposed || !config?.enabled || !config.forwardRemote) return;

      // 配置是异步读取的，发送前复核当前快照仍是同一个失败。
      const latest = snapshotRef.current;
      if (!latest || latest.sessionId !== sessionId) return;
      const latestControl = latest.control;
      if ((latestControl?.phase ?? "").trim().toLowerCase() !== "error") return;
      if (qctrkAutoContinueFingerprint(asFailure(latestControl?.lastError)) !== fingerprint) return;

      if (!tracker.shouldContinue(key, undefined, config, fingerprint)) return;
      try {
        const result = await sendRef.current(config.text);
        // 产物规则：只有 "sent"（或旧实现的 undefined）算发出；其余清去重键但保留连续次数。
        if (result === "sent" || result === undefined) return;
        tracker.recordSendFailure(key);
      } catch {
        tracker.recordSendFailure(key);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [snapshot, sessionId, key, readOnly, platform, phase, failure, fingerprint]);
}
