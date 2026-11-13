// 请求级人机验证策略（开源版补全）。
//
// 官方服务端对写入类操作（model-request / manual-claim）强制要求携带阿里云验证码
// （Aliyun Captcha v2）校验参数。开源发布版曾把整套验证子系统置空（headers 返回 {}、
// interactionAvailable=false、reasons 不含 manual-claim），导致「领取额度」等写操作
// 100% 被服务端以 "captcha verify failed" 拒绝。此处恢复官方实现，使开源版能够：
//   1. 从服务端 /api/v1/client/configs 读取验证码配置（sceneId / prefix / region）；
//   2. 在领取前弹出阿里云验证码，取得 verifyParam；
//   3. 通过 X-Aliyun-Captcha-Verify-Param / -Region 头把校验参数带给服务端。
//
// 验证码 SDK 由运行时从 https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
// 动态加载（公开资源），CaptchaAppId 由该 SDK 依据服务端下发的 prefix 解析，
// 因此无需在客户端硬编码任何密钥。

/** 校验参数回传头：阿里云验证码 verifyParam。 */
export const X_ALIYUN_CAPTCHA_VERIFY_PARAM = "X-Aliyun-Captcha-Verify-Param";
/** 校验参数回传头：验证码区域（默认 cn）。 */
export const X_ALIYUN_CAPTCHA_VERIFY_REGION = "X-Aliyun-Captcha-Verify-Region";

/**
 * 服务端下发的验证码配置（来自 /api/v1/client/configs 的 configs.requestVerification）。
 * enabled=false 表示服务端整体关闭人机校验（此时写操作不再要求验证码）。
 */
export type RequestVerificationConfig = {
  sceneId?: string;
  prefix?: string;
  region?: string;
  enabled?: boolean;
  skipModelRequest?: boolean;
  [key: string]: unknown;
};

/**
 * 一次验证产出的证明，最终经 requestVerificationClaimHeaders 转为请求头。
 * captchaVerifyParam 即阿里云验证码 success 回调拿到的 verifyParam 字符串。
 */
export type RequestVerificationProof = {
  captchaVerifyParam?: string;
  captchaRegion?: string;
};

/** 客户端配置里承载验证策略的子对象（与 RequestVerificationConfig 隔离，避免误用）。 */
export type RequestVerificationClientConfig = Record<never, never>;

/** 触发人机验证的动作原因；manual-claim 是「领取额度」写操作。 */
export const requestVerificationReasons = ["model-request", "manual-claim"] as const;
export type RequestVerificationReason = (typeof requestVerificationReasons)[number];

export const requestVerificationTimeoutMessage =
  "Provider runtime headers request timed out. Please send your message again.";

export const REQUEST_VERIFICATION_REQUIRED = "request_verification_unavailable";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 从 /api/v1/client/configs 返回的完整 configs 对象里抽取验证码子配置。
 *
 * 服务端字段名是 `captcha`（不是 requestVerification）。子字段同时兼容下划线写法，
 * 并补齐默认值：region=cn、enabled=true、skipModelRequest=false。
 * 为兼容不同服务端版本，按候选键名依次查找；若都未命中，再宽松扫描任意带
 * sceneId/prefix 的对象，避免字段名差异导致整套人机验证被静默跳过。
 */
export function readRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) return null;
  const bag = configs as Record<string, unknown>;

  let raw: Record<string, unknown> | null = null;
  for (const key of ["captcha", "requestVerification", "captchaConfig", "aliyunCaptcha"]) {
    const value = bag[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      raw = value as Record<string, unknown>;
      break;
    }
  }
  if (!raw) {
    for (const [key, value] of Object.entries(bag)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      const hasScene = asTrimmedString(candidate.sceneId ?? candidate.scene_id) !== "";
      const hasPrefix = asTrimmedString(candidate.prefix) !== "";
      if (hasScene && hasPrefix && /captcha|verif/i.test(key)) {
        raw = candidate;
        break;
      }
    }
  }
  if (!raw) return null;

  return {
    sceneId: asTrimmedString(raw.sceneId ?? raw.scene_id),
    prefix: asTrimmedString(raw.prefix),
    region: asTrimmedString(raw.region) || "cn",
    enabled: asBoolean(raw.enabled, true),
    skipModelRequest: asBoolean(
      raw.skipModelRequest ?? raw.skip_model_request,
      false,
    ),
  };
}

/**
 * 校验后的验证配置：必须启用且同时具备 sceneId 与 prefix，否则视为无效。
 * 调用方拿到 null 时会取消本次写操作，不能按「跳过校验」放行。
 */
export function readValidatedRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  const config = readRequestVerificationConfig(configs);
  if (!config || !config.enabled || !config.sceneId || !config.prefix) return null;
  return config;
}

/**
 * 把一次验证证明转为领取/写操作请求头。
 * 无 captchaVerifyParam 时返回空对象（调用方按「未验证」处理）。
 */
export function requestVerificationClaimHeaders(
  proof: RequestVerificationProof,
): Record<string, string> {
  const param = typeof proof?.captchaVerifyParam === "string" ? proof.captchaVerifyParam.trim() : "";
  if (!param) return {};
  const region =
    typeof proof?.captchaRegion === "string" && proof.captchaRegion.trim()
      ? proof.captchaRegion.trim()
      : "cn";
  return {
    [X_ALIYUN_CAPTCHA_VERIFY_PARAM]: param,
    [X_ALIYUN_CAPTCHA_VERIFY_REGION]: region,
  };
}

/** 透传已携带的验证头（默认实现不剥离任何字段）。 */
export function withoutRequestVerificationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return { ...headers };
}

const KNOWN_CAPTCHA_HEADERS = [
  X_ALIYUN_CAPTCHA_VERIFY_PARAM.toLowerCase(),
  X_ALIYUN_CAPTCHA_VERIFY_REGION.toLowerCase(),
];

/** 仅放行已知的验证码头，防止把无关字段当验证参数透传。 */
export function allowRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (KNOWN_CAPTCHA_HEADERS.includes(key.toLowerCase())) result[key] = value;
  }
  return result;
}

/**
 * 是否需要对某次访问做人机验证。
 * 规则（与官方一致）：交互不可用、或配置显式关闭（enabled=false / skipModelRequest=true）
 * 时不要求；否则 start-plan 模式要求验证。
 */
export function requiresRequestVerification(
  access: { mode: string } | undefined,
  config?: RequestVerificationConfig | null,
): boolean {
  if (!requestVerificationInteractionAvailable) return false;
  if (config?.enabled === false) return false;
  if (config?.skipModelRequest === true) return false;
  return access?.mode === "start-plan";
}

const VERIFICATION_MESSAGE_KEYWORDS = [
  "captcha verify failed",
  "captcha verification failed",
  "captcha_verify_failed",
  "request verification",
  "人机验证",
  "验证码",
];

/** 判断服务端返回文案是否为验证失败（用于把通用错误归一到人机验证提示）。 */
export function isRequestVerificationMessage(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return VERIFICATION_MESSAGE_KEYWORDS.some((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
}

export function summarizeRequestVerificationHeaders(
  _headers: Record<string, string>,
): Record<string, unknown> {
  return {};
}

export function requestVerificationDiagnostics(
  _input: Record<string, unknown>,
): Record<string, unknown> {
  return {};
}

// 注意：本标志仅控制「model-request（对话）」人机验证链路。
// 开源版未移植对话态验证码 UI，故保持 false 以免回归对话流程；
// 「领取额度」走独立的 prepareRequestVerificationClaim，不受此标志影响，仍可正常弹出验证码。
export const requestVerificationInteractionAvailable = false;
