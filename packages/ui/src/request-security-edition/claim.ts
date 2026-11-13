import type { ICodingPlanSubscriptionService } from "@zcode/services";
import type { RequestVerificationConfig, RequestVerificationProof } from "@zcode/shared";
import { logger } from "@/logger.js";
import { runAliyunCaptcha } from "./aliyunCaptcha.js";

export function useRequestVerificationPrewarm(_visible: boolean): void {}

/** 诊断错误统一前缀；MarketingTouchProvider 会据此把诊断回显给用户。 */
const DIAG_PREFIX = "人机验证未取得校验参数";

function diagError(reason: string): Error {
  return new Error(`${DIAG_PREFIX}（诊断：${reason}）`);
}

/**
 * 领取额度前的人机验证准备：拉取服务端验证码配置（sceneId/prefix/region），
 * 弹出阿里云验证码，返回校验参数。
 * - 服务端 enabled=false：返回 {}（跳过验证，沿用既有行为）。
 * - 用户完成验证：返回 { captchaVerifyParam, captchaRegion }。
 * - 配置缺失 / SDK 不可用 / 未完成验证：抛出带诊断的 Error，由调用方回显，
 *   避免静默取消导致「只看到通用提示、无法定位」。
 * - 用户主动取消 / 信号中止：返回 undefined（静默，不打扰用户）。
 */
export async function prepareRequestVerificationClaim(
  service: ICodingPlanSubscriptionService,
  signal: AbortSignal,
  onVerifying?: () => void,
): Promise<RequestVerificationProof | undefined> {
  signal.throwIfAborted();

  let config: RequestVerificationConfig | null;
  try {
    config = await service.getRequestVerificationConfig();
  } catch (e) {
    logger.warn("[request-verification] 读取验证配置失败", {
      error: e instanceof Error ? e.message : String(e),
    });
    throw diagError(`读取验证配置失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (signal.aborted) return undefined;

  if (!config || typeof config !== "object") {
    logger.warn("[request-verification] 服务端未下发验证配置");
    throw diagError("服务端未下发人机验证配置（client/configs 无 captcha 字段）");
  }

  const sceneId = typeof config.sceneId === "string" ? config.sceneId.trim() : "";
  const prefix = typeof config.prefix === "string" ? config.prefix.trim() : "";
  if (!sceneId || !prefix) {
    logger.warn("[request-verification] 验证配置缺 sceneId/prefix", { sceneId, prefix });
    throw diagError(
      `验证配置不完整（sceneId=${sceneId ? "有" : "无"}，prefix=${prefix ? "有" : "无"}）`,
    );
  }
  if (config.enabled === false) {
    logger.info("[request-verification] 服务端已关闭人机校验，跳过");
    return {};
  }

  const region =
    typeof config.region === "string" && config.region.trim() ? config.region.trim() : "cn";

  onVerifying?.();
  const result = await runAliyunCaptcha({ sceneId, prefix, region }, signal);
  if (signal.aborted) return undefined;

  if (result.cancelled || !result.token) {
    if (result.cancelled) {
      logger.info("[request-verification] 验证码被取消/中止");
      return undefined;
    }
    logger.warn("[request-verification] 未取得 verifyParam", { diag: result.diag });
    throw diagError(result.diag || "验证码未完成或 SDK 不可用");
  }

  logger.info("[request-verification] 已取得校验参数，提交领取", {
    verifyParamLength: result.token.length,
    region,
  });
  return { captchaVerifyParam: result.token, captchaRegion: region };
}
