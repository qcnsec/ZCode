// （resources/glm/zcode.cjs 中的
// isQcTrkTransientStreamMessage / isQcTrkRetryableInferenceInvalidMessage）。
// 目的： 流被中断、连接提前关闭、socket hang up 等临时故障自动接上；
// 中转站偶发的 400 / InvalidParameter「inference request is invalid」同样重试，
// 但上下文超限、参数错误、鉴权、欠费等真正的坏请求保持不可重试。

const TRANSIENT_STREAM_MESSAGE_PATTERN =
  /\b(stream idle|stream stalled|stream interrupted|upstream stream interrupted|stream terminated|premature close|socket hang up|connection reset|timeout|timed out|ECONNRESET|EPIPE|ETIMEDOUT)\b/i;

const RETRYABLE_INFERENCE_INVALID_PATTERN =
  /\binference\s+request\s+(?:is\s+)?invalid\b|\binvalid\s+inference\s+request\b|\binference\s+failed\s*:?\s*request\s+is\s+invalid\b/i;

// 命中这些词说明是确定性的坏请求，重试只会白白消耗额度，必须排除。
const NON_RETRYABLE_FAILURE_PATTERN =
  /\b(context|token|max_tokens|input|prompt|message)\b.*\b(exceed|limit|range|too long|above max|invalid)\b|string_above_max_length|\bstring too long\b|\bnot found\b|unsupported|authentication|unauthorized|forbidden|quota|insufficient/i;

export function isQcTrkRetryableInferenceInvalidMessage(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    RETRYABLE_INFERENCE_INVALID_PATTERN.test(normalized) &&
    !NON_RETRYABLE_FAILURE_PATTERN.test(normalized)
  );
}

export function isQcTrkTransientStreamMessage(message: string | undefined): boolean {
  if (!message) return false;
  return (
    TRANSIENT_STREAM_MESSAGE_PATTERN.test(message) ||
    isQcTrkRetryableInferenceInvalidMessage(message)
  );
}
