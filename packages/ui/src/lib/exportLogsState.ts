import { useSyncExternalStore } from "react";

// 进程内共享的「日志导出进行中」状态。
// renderer 侧的所有导出入口（帮助菜单、Windows 标题栏菜单）以及 main 广播的
// 托盘/原生菜单进度都汇聚到这里，让菜单项能统一置灰，避免用户连点。
// 真正的并发兜底在 main 的 exportLogs() in-flight 锁，这里只负责 UI 反馈。

let busy = false;
const listeners = new Set<() => void>();

// 兜底超时：托盘/原生菜单的 end 广播若因窗口重载丢失，不能让菜单项永久置灰。
// 正常导出远小于该时长；main 的 end 广播会提前清除定时器。
const BUSY_SAFETY_TIMEOUT_MS = 3 * 60 * 1000;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

function clearSafetyTimer(): void {
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return busy;
}

export function setExportLogsBusy(next: boolean): void {
  clearSafetyTimer();
  if (next) {
    safetyTimer = setTimeout(() => {
      safetyTimer = null;
      if (busy) {
        busy = false;
        emit();
      }
    }, BUSY_SAFETY_TIMEOUT_MS);
  }
  if (busy === next) return;
  busy = next;
  emit();
}

/** 是否已有日志导出在进行；供导出动作入口提前短路。 */
export function isExportLogsBusy(): boolean {
  return busy;
}

/** 订阅「正在导出日志中」状态，用于菜单项禁用与文案切换。 */
export function useExportLogsBusy(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
