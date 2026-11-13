/**
 * 自动继续策略。
 *
 * 产物依据：
 * - out/main/index.js：`var a8=50, eo={enabled:!0,maxAttempts:3,text:"继续",
 *   includeSubagents:!1,forwardRemote:!0}`，配置文件 ~/.zcode/v2/qctrk-autocont.json。
 * - out/renderer/assets/styles-*.js：错误码 → failureReason 映射表，
 *   按 taskId 记录连续次数、成功一次清零、同一失败去重、Map 上限 200。
 *
 * 规则：只有临时故障（网络/超时/流中断/服务端错误/限流/过载）自动发「继续」；
 * 取消、额度耗尽、欠费、鉴权失败、参数错误、上下文超限、模型不存在等不触发。
 */

/** 触发自动继续的临时故障类型。 */
export const QCTRK_AUTO_CONTINUE_RETRYABLE_REASONS = new Set([
  "network_error",
  "timeout",
  "stream_idle_timeout",
  "server_error",
  "provider_overloaded",
  "rate_limited",
  "upstream_unavailable",
  "stream_read_error",
  "gateway_stream_terminated",
]);

/** 明确不触发自动继续的终态/坏请求类型。 */
export const QCTRK_AUTO_CONTINUE_BLOCKED_REASONS = new Set([
  "cancelled",
  "quota_exhausted",
  "balance_insufficient",
  "auth_failed",
  "invalid_request",
  "invalid_input",
  "invalid_parameter_error",
  "context_exceeded",
  "model_not_found",
  "model_capability_not_supported",
  "plan_expired",
  "plan_access_denied",
  "tls_error",
  "provider_not_configured",
  "offpeak_ticket_expired",
  "cyber_policy",
  "request_too_large",
]);

/** 产物 J2e：终局 failureReason，命中即不继续。 */
const TERMINAL_FAILURE_REASONS = new Set([
  "quota_exhausted",
  "auth_failed",
  "invalid_request",
  "model_not_found",
  "context_exceeded",
  "plan_expired",
  "plan_access_denied",
  "offpeak_ticket_expired",
]);

/** 产物 Y2e：临时 failureReason，命中即可继续。 */
const TRANSIENT_FAILURE_REASONS = new Set([
  "rate_limited",
  "server_error",
  "provider_overloaded",
  "network_error",
  "timeout",
]);

/** 产物 X2e：这些 HTTP 状态码是确定性的坏请求。 */
const TERMINAL_HTTP_STATUSES = new Set([400, 401, 403, 422]);

/** 产物 Z2e：终局错误码（字符串与数字码混用）。 */
const TERMINAL_ERROR_CODES = new Set(
  "insufficient_quota.insufficient_quota_error.credit_balance_exhausted.organization_spend_limit_exceeded.project_spend_limit_exceeded.organization_usage_limit_exceeded.exceeded_current_quota_error.1005.1006.1008.1113.1261.1304.1308.1309.1310.1311.1313.1314.1315.1316.1317.1318.1319.1320.1321.2056.20097.3001.3006.3007.context_exceeded.model_context_exceeded.provider_not_configured.model_config_missing.provider_not_found.model_not_found.invalid_model_request.invalid_model_selection.model_request_auth_missing".split(
    ".",
  ),
);

/** 产物 Q2e：临时错误码。 */
const TRANSIENT_ERROR_CODES = new Set([
  "rate_limit_reached_error",
  "rate_limit_error",
  "engine_overloaded_error",
  "overloaded_error",
  "model_rate_limited",
  "model_request_timeout",
  "1120",
  "1230",
  "1234",
  "1302",
  "1303",
  "1305",
  "1312",
  "2007",
  "3002",
]);

/** 产物 o2e：provider 错误码 → failureReason。 */
const PROVIDER_CODE_REASON: Record<string, string> = {
  "1005": "quota_exhausted",
  "1006": "auth_failed",
  "1120": "server_error",
  "1210": "invalid_request",
  "1211": "model_not_found",
  "1213": "invalid_request",
  "1214": "model_not_found",
  "1230": "server_error",
  "1234": "network_error",
  "1261": "context_exceeded",
  "1301": "invalid_request",
  "1302": "rate_limited",
  "1303": "rate_limited",
  "1304": "quota_exhausted",
  "1305": "rate_limited",
  "1308": "quota_exhausted",
  "1309": "plan_expired",
  "1310": "quota_exhausted",
  "1311": "plan_access_denied",
  "1312": "provider_overloaded",
  "2007": "server_error",
  "3001": "invalid_request",
  "3002": "rate_limited",
  "3006": "model_not_found",
  "3007": "auth_failed",
  "3008": "rate_limited",
  "3009": "rate_limited",
  "3010": "rate_limited",
  "3012": "invalid_request",
  "429": "rate_limited",
};

export interface QcTrkAutoContinueFailureLike {
  recoverable?: boolean;
  source?: string;
  code?: string;
  at?: number;
  attribution?: {
    statusCode?: number;
    source?: string;
    retryable?: boolean;
    providerErrorCode?: string;
  };
}

export interface QcTrkAutoContinueSnapshotLike {
  phase?: string;
  lastError?: QcTrkAutoContinueFailureLike | null;
}

export interface QcTrkAutoContinueDecision {
  go: boolean;
  kind: string;
  reason: string;
}

/**
 * 复刻产物 $2e 的判定顺序：先排除所有终局条件，再按可重试标记、
 * HTTP 状态、错误来源、错误码决定是否可以自动继续。
 */
export function evaluateQcTrkAutoContinue(
  snapshot: QcTrkAutoContinueSnapshotLike | null | undefined,
): QcTrkAutoContinueDecision {
  const control = snapshot;
  if (!control || (control.phase ?? "").trim().toLowerCase() !== "error") {
    return { go: false, kind: "not-error", reason: "phase 不是 error" };
  }
  const lastError = control.lastError;
  if (!lastError) return { go: false, kind: "no-error", reason: "没有 lastError" };

  const attribution = lastError.attribution ?? {};
  const statusCode =
    typeof attribution.statusCode === "number" && Number.isFinite(attribution.statusCode)
      ? attribution.statusCode
      : null;
  const source = (attribution.source || lastError.source || "").trim().toLowerCase();
  if (lastError.recoverable === false) {
    return { go: false, kind: "deny:not-recoverable", reason: "投影标记为不可恢复" };
  }
  if (attribution.retryable === false) {
    return { go: false, kind: "deny:not-retryable", reason: "归因标记为不可重试" };
  }
  if (statusCode !== null && TERMINAL_HTTP_STATUSES.has(statusCode)) {
    return { go: false, kind: "deny:status", reason: `HTTP ${statusCode} 不可重试` };
  }

  const codes = [attribution.providerErrorCode, lastError.code]
    .map((value) => (value ?? "").trim().toLowerCase())
    .filter(Boolean);
  for (const code of codes) {
    if (TERMINAL_ERROR_CODES.has(code)) {
      return { go: false, kind: "deny:terminal-code", reason: `终局错误 ${code}` };
    }
    const mapped = PROVIDER_CODE_REASON[code];
    if (mapped && TERMINAL_FAILURE_REASONS.has(mapped)) {
      return { go: false, kind: "deny:terminal-code", reason: `终局错误 ${code} (${mapped})` };
    }
  }

  if (attribution.retryable === true) {
    return { go: true, kind: "retryable", reason: "归因标记为可重试" };
  }
  if (statusCode === 429) return { go: true, kind: "status-429", reason: "限流 429" };
  if (statusCode !== null && statusCode >= 500) {
    return { go: true, kind: "status-5xx", reason: `服务端 ${statusCode}` };
  }
  if (source === "network") return { go: true, kind: "network", reason: "网络故障" };
  for (const code of codes) {
    if (TRANSIENT_ERROR_CODES.has(code)) {
      return { go: true, kind: "transient-code", reason: `临时性故障 ${code}` };
    }
    const mapped = PROVIDER_CODE_REASON[code];
    if (mapped && TRANSIENT_FAILURE_REASONS.has(mapped)) {
      return { go: true, kind: `transient:${mapped}`, reason: `临时性故障 ${code} (${mapped})` };
    }
  }
  return { go: false, kind: "unclassified", reason: "未登记的错误" };
}

/** 产物 e4e：用错误时间戳 + 错误码生成失败指纹，用于去重。 */
export function qctrkAutoContinueFingerprint(
  failure: QcTrkAutoContinueFailureLike | null | undefined,
): string {
  if (!failure) return "";
  const attribution = failure.attribution ?? {};
  return [failure.at ?? "", failure.code ?? "", attribution.providerErrorCode ?? "", attribution.statusCode ?? ""].join("|");
}

export function isQcTrkAutoContinueFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.trim().toLowerCase();
  if (QCTRK_AUTO_CONTINUE_BLOCKED_REASONS.has(normalized)) return false;
  return QCTRK_AUTO_CONTINUE_RETRYABLE_REASONS.has(normalized);
}

export interface QcTrkAutoContinueConfigLike {
  enabled: boolean;
  maxAttempts: number;
}

export interface QcTrkAutoContinueTracker {
  /** 判断本次失败是否应自动发送「继续」；同时推进连续次数计数。 */
  shouldContinue(
    taskId: string,
    reason: string | undefined,
    config: QcTrkAutoContinueConfigLike,
    failureKey?: string,
  ): boolean;
  /** 任务成功（或用户主动取消）后清零，避免历史失败影响下一轮。 */
  recordTerminalSuccess(taskId: string): void;
  /** 发送未成功：只清除去重键、保留连续次数，允许下一次失败重新判定。 */
  recordSendFailure(taskId: string): void;
  reset(taskId: string): void;
}

const DEFAULT_MAX_TRACKED_TASKS = 200;

/**
 * 与产物一致的状态机：连续失败计数、成功清零、同一失败去重、按 LRU 限制 Map 大小。
 * 纯函数式状态容器，由调用方持有实例；不依赖 React / Electron。
 */
export function createQcTrkAutoContinueTracker(
  maxTrackedTasks = DEFAULT_MAX_TRACKED_TASKS,
): QcTrkAutoContinueTracker {
  const consecutive = new Map<string, number>();
  const lastFailure = new Map<string, string>();

  const trim = () => {
    while (consecutive.size > maxTrackedTasks) {
      const key = consecutive.keys().next().value;
      if (key === undefined) break;
      consecutive.delete(key);
    }
    while (lastFailure.size > maxTrackedTasks) {
      const key = lastFailure.keys().next().value;
      if (key === undefined) break;
      lastFailure.delete(key);
    }
  };

  const reset = (taskId: string) => {
    consecutive.delete(taskId);
    lastFailure.delete(taskId);
  };

  return {
    shouldContinue(taskId, reason, config, failureKey) {
      // reason 为 undefined 表示调用方已用 evaluateQcTrkAutoContinue 完成错误分类，
      // 这里只负责状态机（上限、去重、计数）。
      if (
        !config.enabled ||
        (reason !== undefined && !isQcTrkAutoContinueFailureReason(reason))
      ) {
        return false;
      }
      if (failureKey && lastFailure.get(taskId) === failureKey) return false;

      const limit = Math.max(1, Math.floor(config.maxAttempts));
      const next = (consecutive.get(taskId) ?? 0) + 1;
      if (next > limit) return false;

      // 重新插入以维护 Map 的插入顺序（最旧的先被淘汰）。
      consecutive.delete(taskId);
      consecutive.set(taskId, next);
      if (failureKey) {
        lastFailure.delete(taskId);
        lastFailure.set(taskId, failureKey);
      }
      trim();
      return true;
    },
    recordTerminalSuccess: reset,
    recordSendFailure(taskId) {
      lastFailure.delete(taskId);
    },
    reset,
  };
}
