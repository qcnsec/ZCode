import { useEffect, useRef, useState } from "react";
import { type ZCodeApiRetryStatus, type QcTrkErrorReport } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 重试徽标与错误面板。
 *
 * 复用既有 model.request.status → apiRetry 状态链路（与 ChatApiRetryStatus 同源），
 * 在 renderer 本地维护「本轮逐次重试明细」列表并展示，不新增 IPC、不污染遥测主链路。
 * 任务级失败统计来自 qctrk-errors IPC（getErrors），请求级逐次重试来自 zcode session store 的 apiRetry。
 */
const RETRY_PANEL_REFRESH_MS = 5_000;
/** 与 qctrk recent 一致，最多保留最近 60 条逐次重试明细。 */
const MAX_RETRY_DETAILS = 60;

interface RetryAttemptDetail {
  /** 第几次请求（1 起）。与 apiRetry.attempt 对齐。 */
  attempt: number;
  /** 本轮最大重试上限。 */
  maxRetries: number;
  /** 该次失败对应的 HTTP 状态码，网络层失败时为 null。 */
  errorStatus: number | null;
  /** 该次失败的文案（failure.message）。 */
  error: string;
  /** 进入明细列表的本地时间戳，用于按时序展示。 */
  at: number;
}

export function QcTrkRetryBadge({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const platform = useOptionalPlatform();
  const qctrk = platform?.qctrk;
  const [report, setReport] = useState<QcTrkErrorReport | null>(null);
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<RetryAttemptDetail[]>([]);

  // 复用既有状态链路：当前激活 task 的 apiRetry 已由 CLI 的 model.request.status 事件
  // （model_request_failed / model_retry_scheduled）经协议层驱动更新，无需新增通道。
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspacePath]?.activeTaskId ?? null,
  );
  const apiRetry = useZCodeSessionStore((state) => {
    const ws = state.workspaces[workspacePath];
    if (!ws?.activeTaskId) return null;
    return ws.taskRuntimeByTaskId[ws.activeTaskId]?.apiRetry ?? null;
  });

  // 以 activeTaskId 切换作为「新一轮」边界，重新累积本轮的逐次重试明细；
  // 同一 attempt 的状态刷新（如 model_retry_scheduled 覆盖同次失败）只更新末条，不新增条目。
  const runKeyRef = useRef<string | null>(null);
  const lastAttemptRef = useRef<number | null>(null);
  const detailsRef = useRef<RetryAttemptDetail[]>([]);

  useEffect(() => {
    const runKey = activeTaskId ?? "draft";
    if (runKeyRef.current !== runKey) {
      runKeyRef.current = runKey;
      lastAttemptRef.current = null;
      detailsRef.current = [];
      setDetails([]);
      return;
    }
    if (!apiRetry) return;
    if (lastAttemptRef.current === apiRetry.attempt) {
      // 同一次重试的状态刷新：原地更新末条，避免重复计数。
      const next = detailsRef.current.slice();
      if (next.length > 0) next[next.length - 1] = toDetail(apiRetry);
      detailsRef.current = next;
      setDetails(next);
      return;
    }
    lastAttemptRef.current = apiRetry.attempt;
    const next = [...detailsRef.current, toDetail(apiRetry)].slice(-MAX_RETRY_DETAILS);
    detailsRef.current = next;
    setDetails(next);
  }, [activeTaskId, apiRetry]);

  useEffect(() => {
    if (!qctrk) return;
    let disposed = false;
    const load = () => {
      void qctrk.getErrors().then((next) => {
        if (!disposed) setReport(next);
      });
    };
    load();
    const timer = window.setInterval(load, RETRY_PANEL_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [qctrk]);

  if (!qctrk || !report) return null;
  const { currentRetries, todayFailures, byCode, recent } = report;
  const codeEntries = Object.entries(byCode);
  if (
    currentRetries === 0 &&
    todayFailures === 0 &&
    recent.length === 0 &&
    details.length === 0
  ) {
    return null;
  }

  const dotColor = currentRetries > 0 ? "#e0a24a" : todayFailures > 0 ? "#c98a8a" : "#8b8b8b";

  return (
    <span className="relative ml-1.5 inline-flex select-none items-center" data-qctrk-retry-badge="">
      <button
        type="button"
        className="inline-flex h-[18px] cursor-pointer items-center gap-1 rounded-md border border-border/60 bg-foreground/[0.04] px-1.5 text-[9px] leading-none whitespace-nowrap tabular-nums opacity-90"
        aria-expanded={open}
        aria-label={t("settings.qctrk.retry.title")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <span className="size-1 flex-none rounded-full" style={{ background: dotColor }} />
        <span>
          {t("settings.qctrk.retry.badge")} {currentRetries}
        </span>
      </button>
      {open ? (
        <div
          data-qctrk-retry-panel=""
          className="absolute bottom-full left-0 z-50 mb-2 max-h-[40vh] min-w-[340px] max-w-[min(680px,92vw)] overflow-auto rounded-[10px] border border-border bg-popover px-3 py-2.5 text-[12px] leading-relaxed text-popover-foreground shadow-2xl"
        >
          <div className="mb-1 font-semibold">{t("settings.qctrk.retry.title")}</div>
          <div className="mb-2 flex flex-wrap gap-4">
            <span>
              {t("settings.qctrk.retry.current")} <b>{currentRetries}</b>
            </span>
            <span>
              {t("settings.qctrk.retry.todayFailures")} <b>{todayFailures}</b>
            </span>
          </div>
          {codeEntries.length > 0 ? (
            <div className="mb-2">
              <div className="mb-1 text-foreground-subtle">{t("settings.qctrk.retry.byCode")}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {codeEntries.map(([code, count]) => (
                  <span key={code} className="tabular-nums">
                    <code className="rounded bg-foreground/10 px-1">{code}</code> × {count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {/* 本轮逐次重试明细：复用既有 model.request.status → apiRetry 链路，renderer 本地累积。 */}
          <div className="mb-1 text-foreground-subtle">
            {t("settings.qctrk.retry.attemptDetails")}（{details.length}）
          </div>
          {details.length === 0 ? (
            <div className="mb-2 text-foreground-subtle">
              {t("settings.qctrk.retry.attemptNoDetails")}
            </div>
          ) : (
            <div className="mb-2 space-y-0.5">
              {details.map((entry, index) => (
                <div key={`${entry.attempt}-${index}`} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-foreground-subtle">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                  <code className="shrink-0 rounded bg-foreground/10 px-1">
                    {t("settings.qctrk.retry.attemptItem", {
                      attempt: entry.attempt,
                      maxRetries: entry.maxRetries,
                    })}
                  </code>
                  {entry.errorStatus != null ? (
                    <code className="shrink-0 rounded bg-foreground/10 px-1">
                      HTTP {entry.errorStatus}
                    </code>
                  ) : null}
                  <span className="min-w-0 truncate" title={entry.error}>
                    {entry.error}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mb-1 text-foreground-subtle">
            {t("settings.qctrk.retry.recent")}（{recent.length}）
          </div>
          {recent.length === 0 ? (
            <div className="text-foreground-subtle">{t("settings.qctrk.retry.noDetails")}</div>
          ) : (
            <div className="space-y-0.5">
              {recent.slice(-60).reverse().map((entry, index) => (
                <div key={`${entry.at}-${index}`} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-foreground-subtle">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                  <code className="shrink-0 rounded bg-foreground/10 px-1">{entry.code}</code>
                  <span className="min-w-0 truncate" title={entry.message}>
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </span>
  );
}

function toDetail(apiRetry: ZCodeApiRetryStatus): RetryAttemptDetail {
  return {
    attempt: apiRetry.attempt,
    maxRetries: apiRetry.maxRetries,
    errorStatus: apiRetry.errorStatus,
    error: apiRetry.error,
    at: Date.now(),
  };
}
