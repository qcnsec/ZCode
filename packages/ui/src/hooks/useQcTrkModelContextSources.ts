import { useEffect, useSyncExternalStore } from "react";
import type {
  QcTrkModelContextSourceInput,
  QcTrkModelContextSources,
  QcTrkModelContextSourcesResult,
  QcTrkPlatformApi,
} from "@zcode/shared";

/**
 * renderer 主 bundle 的 Iqn/Lqn/Rqn/zqn/Bqn。
 *
 * 全应用共享一份「模型上下文窗口来源」快照，懒加载一次（多个模型行同时挂载时
 * 只会发一次 IPC），用 useSyncExternalStore 让所有订阅者同步刷新。
 * 扫描到 值时通过 recordQcTrkUpstreamContextSources 合并写入并广播。
 */

type QcTrkModelContextApi = Pick<
  QcTrkPlatformApi,
  "getModelContextSources" | "setModelContextSources"
>;

let snapshot: QcTrkModelContextSources = {};
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QcTrkModelContextSources {
  return snapshot;
}

function merge(next: QcTrkModelContextSources): void {
  snapshot = { ...snapshot, ...next };
  loaded = true;
  notify();
}

function applyResult(result: QcTrkModelContextSourcesResult | undefined): void {
  if (result?.ok && result.sources && typeof result.sources === "object") {
    merge(result.sources);
  }
}

/** 加载一次；并发调用共用同一个 inFlight。 */
function ensureLoaded(qctrk: QcTrkModelContextApi | undefined): void {
  if (loaded || inFlight || !qctrk) return;
  inFlight = (async () => {
    const result = await qctrk.getModelContextSources();
    applyResult(result);
    loaded = true;
  })()
    .catch(() => {
      // 读取失败不阻断渲染；下次挂载会重试。
    })
    .finally(() => {
      inFlight = null;
    });
}

/**
 * 读取共享快照并触发懒加载。每个模型行 / 扫描器都可独立调用，
 * useSyncExternalStore 保证所有订阅者在来源更新时同步刷新。
 */
export function useQcTrkModelContextSources(
  qctrk: QcTrkModelContextApi | undefined,
): QcTrkModelContextSources {
  useEffect(() => {
    ensureLoaded(qctrk);
  }, [qctrk]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 合并写入 来源记录（扫描完成后调用）。 */
export async function recordQcTrkUpstreamContextSources(
  qctrk: QcTrkModelContextApi | undefined,
  entries: QcTrkModelContextSourceInput[],
): Promise<void> {
  if (!qctrk || entries.length === 0) return;
  const result = await qctrk.setModelContextSources({ entries });
  applyResult(result);
}
