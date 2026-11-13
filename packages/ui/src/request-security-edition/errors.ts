export const REQUEST_VERIFICATION_REJECTED_MESSAGE = "";
const VERIFICATION_MESSAGE_KEYWORDS = [
  "captcha verify failed",
  "captcha verification failed",
  "captcha_verify_failed",
  "request verification",
  "人机验证",
  "验证码",
];
export function resolveRequestVerificationBusinessCode(
  _code: string | undefined,
  message: string | undefined,
): "3007" | undefined {
  if (!message) return undefined;
  const normalized = message.toLowerCase();
  return VERIFICATION_MESSAGE_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  )
    ? "3007"
    : undefined;
}
export function isRequestVerificationTerminalError(
  _error: { code?: string; message?: string } | null | undefined,
): boolean {
  return false;
}
export function isRequestVerificationRejectedMessage(_message: string | undefined): boolean {
  return false;
}
export const requestVerificationRecoveryAction = null;
export type RequestVerificationRecoveryAction = never;
export const requestVerificationActionMessages = {};
export const requestVerificationErrorAttribution = {};
export const requestVerificationClaimFailureMessageId = "manualClaimPlan.claim.failure.verification";
export const additionalRequestModalSelectors: readonly string[] = [];

export function resolveRequestSecurityErrorMessageId(_error: {
  code?: string;
  message?: string;
}): string | undefined {
  return undefined;
}
export function isRequestVerificationConfigNetworkError(
  _error: { code?: string; message?: string } | null | undefined,
): boolean {
  return false;
}
