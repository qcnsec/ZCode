// 阿里云验证码（Aliyun Captcha v2）运行时封装。
//
// 与官方一致：动态加载公开 SDK，按服务端下发的 sceneId / prefix / region 初始化验证码，
// 用户完成验证后由 success 回调拿到 CaptchaVerifyParam 字符串，作为「领取额度」等写操作
// 的校验参数回传。CaptchaAppId 由该公开 SDK 依据 prefix 内部解析，客户端无需硬编码密钥。
//
// 实现约定（对齐官方，勿擅自改动）：
//   - init 时【必须】直接传入 success 回调。SDK 的 wr() 据此选择 3.0（智能验证）模式；
//     若改用「init 后再补 success」或省略 success，都会被 SDK 判成 2.0 模式，
//     而 2.0 正常成功路径不把验证参数交给 success，token 会丢失。
//   - init 内部是 tr._extend(e)（拷贝字段），init 之后修改 config 对象不会被 SDK 读到。
//   - 不显式设置 verifyType：SDK 会自行把 wr() 的结果写回配置对象。

const ALIYUN_CAPTCHA_SDK_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

const CONTAINER_ID = "qctrk-captcha-container";
const ELEMENT_ID = "qctrk-captcha-element";
const BUTTON_ID = "qctrk-captcha-button";
const SDK_SCRIPT_ID = "qctrk-aliyun-captcha-sdk";

// 验证码弹窗占位 logo（与官方同款透明图，仅占位）。
const CAPTCHA_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAZdEVYdFNvZnR3YXJlAFBhaW50Lk5FVCB2My41Ljg3O4BdAAAAPUlEQVR42u3OMQEAAAgDoC251a3gLwSgM3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3f0CTAAB6n0mJAAAAAElFTkSuQmCC";

const SDK_LOAD_TIMEOUT = 15_000;
const INSTANCE_READY_TIMEOUT = 10_000;
const SHOW_AFTER = 1_500;
const OVERALL_TIMEOUT = 120_000;

interface AliyunCaptchaInstance {
  startTracelessVerification?: () => void;
  show?: () => void;
  [key: string]: unknown;
}

type InitAliyunCaptcha = (config: Record<string, unknown>) => void;

let sdkLoadPromise: Promise<void> | null = null;

// 最近一次验证码诊断信息（供 UI 失败提示回显）。
let lastDiag = "";
export function getLastCaptchaDiag(): string {
  return lastDiag;
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[qctrk-captcha]", ...args);
}

function loadSdk(): Promise<void> {
  if (typeof document === "undefined") return Promise.reject(new Error("no-dom"));
  const w = window as unknown as { initAliyunCaptcha?: InitAliyunCaptcha };
  if (typeof w.initAliyunCaptcha === "function") return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;
  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SDK_SCRIPT_ID;
    script.src = ALIYUN_CAPTCHA_SDK_URL;
    script.async = true;
    const timer = window.setTimeout(() => {
      script.onload = null;
      script.onerror = null;
      reject(new Error("captcha-sdk-timeout"));
    }, SDK_LOAD_TIMEOUT);
    script.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("captcha-sdk-load-failed"));
    };
    document.head.appendChild(script);
  });
  sdkLoadPromise.catch(() => {
    sdkLoadPromise = null;
  });
  return sdkLoadPromise;
}

function ensureContainer(): void {
  if (document.getElementById(CONTAINER_ID)) return;
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  container.className = "fixed left-0 top-0 z-[2147483647] h-0 w-0 overflow-visible";
  container.setAttribute("aria-hidden", "true");

  const element = document.createElement("div");
  element.id = ELEMENT_ID;
  element.className = "absolute left-0 top-0 h-0 w-0 overflow-visible";

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.tabIndex = -1;
  button.setAttribute("aria-hidden", "true");
  button.className =
    "fixed left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 border-0 p-0 opacity-0";

  container.appendChild(element);
  container.appendChild(button);
  document.body.appendChild(container);
}

function clearElement(): void {
  try {
    document.getElementById(ELEMENT_ID)?.replaceChildren();
  } catch {
    /* noop */
  }
}

export interface RunAliyunCaptchaOptions {
  sceneId: string;
  prefix: string;
  region?: string;
}

export interface RunAliyunCaptchaResult {
  token?: string;
  diag: string;
  cancelled?: boolean;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `string(${value.length}):${value.slice(0, 80)}`;
  if (typeof value === "object") {
    try {
      return `object:${JSON.stringify(value).slice(0, 160)}`;
    } catch {
      return "object(unserializable)";
    }
  }
  return typeof value;
}

/** 从回调参数里抽取验证参数字符串（兼容字符串与对象两种形态）。 */
function extractToken(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of [
      "captchaVerifyParam",
      "verifyParam",
      "captchaVerifyParamStr",
      "certifyId",
      "token",
    ]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

/** 兜底：某些 SDK 版本把验证参数挂在实例上。 */
function scanInstanceForToken(instance: AliyunCaptchaInstance | null): string | undefined {
  if (!instance || typeof instance !== "object") return undefined;
  const candidates: string[] = [];
  for (const key of Object.keys(instance)) {
    const v = instance[key];
    if (typeof v === "string" && v.length > 8) candidates.push(v);
    else if (v && typeof v === "object") {
      for (const k2 of Object.keys(v as object)) {
        const v2 = (v as Record<string, unknown>)[k2];
        if (typeof v2 === "string" && v2.length > 8) candidates.push(v2);
      }
    }
  }
  for (const c of candidates) {
    if (/certifyId|sceneId|verifyParam/i.test(c) || /^[A-Za-z0-9+/=]{40,}$/.test(c)) return c;
  }
  return undefined;
}

/**
 * 弹出阿里云验证码并等待用户完成验证。
 * @returns token 存在表示成功；cancelled 表示用户取消/中止；其余情况 diag 记录诊断。
 */
export async function runAliyunCaptcha(
  options: RunAliyunCaptchaOptions,
  signal: AbortSignal,
): Promise<RunAliyunCaptchaResult> {
  const diag: string[] = [];
  const fail = (msg: string): RunAliyunCaptchaResult => {
    lastDiag = diag.join(" | ");
    log("result:", msg, "| diag:", lastDiag);
    return { diag: lastDiag };
  };

  if (signal.aborted) return { diag: (lastDiag = "aborted-before-start"), cancelled: true };
  const sceneId = options.sceneId.trim();
  const prefix = options.prefix.trim();
  if (!sceneId || !prefix) {
    diag.push("missing-sceneId-or-prefix");
    return fail("missing-sceneId-or-prefix");
  }
  const region = options.region?.trim() || "cn";

  try {
    await loadSdk();
  } catch (e) {
    diag.push(`sdk-load-failed:${e instanceof Error ? e.message : String(e)}`);
    return fail("sdk-load-failed");
  }
  if (signal.aborted) return { diag: (lastDiag = "aborted-after-sdk"), cancelled: true };

  const init = (window as unknown as { initAliyunCaptcha?: InitAliyunCaptcha })
    .initAliyunCaptcha;
  if (typeof init !== "function") {
    diag.push("initAliyunCaptcha-not-available");
    return fail("initAliyunCaptcha-not-available");
  }

  ensureContainer();
  clearElement();
  (window as unknown as { AliyunCaptchaConfig: unknown }).AliyunCaptchaConfig = {
    region,
    prefix,
  };

  return new Promise<RunAliyunCaptchaResult>((resolve) => {
    let settled = false;
    const timers: number[] = [];
    const finish = (value?: string, cancelled = false) => {
      if (settled) return;
      settled = true;
      for (const t of timers) window.clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      if (!value) clearElement();
      const result: RunAliyunCaptchaResult = { diag: diag.join(" | ") };
      if (value) result.token = value;
      if (cancelled) result.cancelled = true;
      lastDiag = result.diag;
      log("finish:", value ? `token(${value.length})` : "no-token", "| diag:", result.diag);
      resolve(result);
    };
    const onAbort = () => finish(undefined, true);

    signal.addEventListener("abort", onAbort, { once: true });
    timers.push(window.setTimeout(() => finish(undefined), OVERALL_TIMEOUT));

    let instance: AliyunCaptchaInstance | null = null;

    const onInstance = (inst: unknown) => {
      instance = (inst as AliyunCaptchaInstance) ?? null;
      diag.push(`instance-ready:${instance ? Object.keys(instance).length + "keys" : "null"}`);
      try {
        if (typeof instance?.startTracelessVerification === "function") {
          instance.startTracelessVerification();
          timers.push(
            window.setTimeout(() => {
              if (!settled)
                try {
                  document.getElementById(BUTTON_ID)?.click();
                } catch {
                  /* noop */
                }
            }, SHOW_AFTER),
          );
        } else {
          instance?.show?.();
        }
      } catch {
        finish(undefined);
      }
    };

    // init 配置与官方一致：success 必须在此处传入（决定 SDK 走 3.0 模式）。
    const config: Record<string, unknown> = {
      SceneId: sceneId,
      region,
      prefix,
      mode: "popup",
      language: "zh",
      captchaLogoImg: CAPTCHA_LOGO,
      showErrorTip: false,
      element: `#${ELEMENT_ID}`,
      button: `#${BUTTON_ID}`,
      getInstance: (inst: unknown) => onInstance(inst),
      success: (verifyParam: unknown) => {
        diag.push(`success:${typeof verifyParam}`);
        log("success", describe(verifyParam));
        const tok = extractToken(verifyParam);
        if (tok) finish(tok);
        else if (instance) {
          const scanned = scanInstanceForToken(instance);
          finish(scanned);
        } else finish(undefined);
      },
      onBizResultCallback: (arg: unknown) => {
        // 仅诊断：2.0 模式成功时只回布尔，不带 token；正常情况下不会走到这里。
        diag.push(`onBizResultCallback:${describe(arg)}`);
        log("onBizResultCallback", describe(arg));
      },
      fail: () => {
        diag.push("fail");
        finish(undefined);
      },
      onError: (err?: unknown) => {
        diag.push(`onError:${describe(err)}`);
        finish(undefined);
      },
    };

    try {
      init(config);
      diag.push("init-called");
    } catch (e) {
      diag.push(`init-threw:${e instanceof Error ? e.message : String(e)}`);
      finish(undefined);
      return;
    }

    timers.push(
      window.setTimeout(() => {
        if (!instance) {
          diag.push("instance-never-ready");
        } else if (!settled) {
          const scanned = scanInstanceForToken(instance);
          if (scanned) finish(scanned);
        }
      }, INSTANCE_READY_TIMEOUT + 4_000),
    );
  });
}
