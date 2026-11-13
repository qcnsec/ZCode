/* oxlint-disable eslint(max-lines) -- qctrk IPC 处理器集中维护用量/代理/通知/更新等 能力，拆分会割裂共享状态与注册顺序 */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import {
  DEFAULT_QCTRK_AUTOCONT_CONFIG,
  DEFAULT_QCTRK_BALANCE_CONFIG,
  DEFAULT_QCTRK_NOTIFY_CONFIG,
  DEFAULT_QCTRK_PROXY_CONFIG,
  normalizeQcTrkAutocontConfig,
  PlatformChannels,
  type QcTrkAutocontConfig,
  type QcTrkBalanceConfig,
  type QcTrkBalanceResult,
  type QcTrkBalanceTarget,
  type QcTrkDeletedTask,
  type QcTrkErrorEntry,
  type QcTrkErrorReport,
  type QcTrkModelContextSourceInput,
  type QcTrkModelContextSourcesResult,
  type QcTrkNotifyConfig,
  type QcTrkNotifyForwardPayload,
  type QcTrkNotifyTestResult,
  type QcTrkProxyConfig,
  type QcTrkProxyTestResult,
  type QcTrkPurgeTaskRequest,
  type QcTrkScanAttempt,
  type QcTrkScanModelsResult,
  type QcTrkUpdateState,
  type QcTrkUsageReport,
  type QcTrkUsageSnapshot,
} from "@zcode/shared";
import { getQcTrkConfigDir, readQcTrkConfig, writeQcTrkConfig } from "./configStore.js";
import {
  readQcTrkModelContextSources,
  recordQcTrkModelContextSources,
  qctrkModelContextSourcesResult,
} from "./modelContextSources.js";
import { purgeTaskIndexRows, scheduleQcTrkVacuum } from "../../host/qctrkPurge.js";
import {
  QCTRK_UPDATE_CONFIG,
  downloadFileToFile,
  fetchManifest,
  fileNameFromUrl,
  isNewer,
  pickInstallerFile,
  resolveFileUrl,
  QcTrkUpdater,
  type QcTrkUpdateFile,
} from "./updateDownloader.js";

// tsup/esbuild 会把动态 import("node:sqlite") 改写成 "sqlite"，Electron 运行时找不到；
// 与 chromeCookieManager.ts 一致，用 createRequire 稳定保留 node: 协议。
const nodeRequire = createRequire(import.meta.url);

function qctrkUserHome(): string {
  return (
    process.env.ZCODE_DATA_BASE_DIR ||
    process.env.ZCODE_DESKTOP_HOME_DIR ||
    process.env.USERPROFILE ||
    homedir() ||
    ""
  );
}

function qctrkIndexDbPath(): string {
  return join(qctrkUserHome(), ".zcode", "v2", "tasks-index.sqlite");
}

/** 产物 listDeletedTasks(m_)：从任务索引读真正的软删/归档残留，供「已删除视图」。 */
function listDeletedTasksFromIndex(): QcTrkDeletedTask[] {
  try {
    const path = qctrkIndexDbPath();
    if (!existsSync(path)) return [];
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT task_id, title, workspace_path, workspace_identity, updated_at, archived, deleted FROM tasks WHERE deleted=1 OR archived=1 ORDER BY updated_at DESC",
        )
        .all() as Array<Record<string, unknown>>;
      return rows
        .map((row) => ({
          id: String(row.task_id ?? ""),
          title: String(row.title ?? ""),
          deletedAt: Number(row.updated_at) || 0,
          hasLocalData: Boolean(row.deleted),
          archived: Boolean(row.archived),
          deleted: Boolean(row.deleted),
          workspacePath: String(row.workspace_path ?? ""),
          ...(row.workspace_identity
            ? { workspaceIdentity: String(row.workspace_identity) }
            : {}),
        }))
        .filter((item) => item.id.length > 0);
    } finally {
      db.close();
    }
  } catch {
    // 索引库暂不可用（启动中/迁移中）时回落到内存视图，不把列表清空。
    return deletedTasks;
  }
}

/**
 * 产物 purgeTaskIndexRows(wg) 的实现已收口到 host/qctrkPurge.ts，
 * 由 Host 删除链路与这里的「彻底删除」IPC 共用，避免两处路径/事务逻辑漂移。
 */

/**
 * 新增 IPC 的 main 侧实现（对应产物中的 registerQcTrkIpcHandlers）。
 *
 * 已可用的能力：四类配置的读写与持久化、余额查询、代理连通性测试、
 * 钉钉/飞书推送与测试、模型扫描、更新检查/下载/取消/打开。
 * 用量、错误统计、已删除会话与自动继续的运行态数据由下面的 report* 函数接收，
 * 待下一批接入 host / services 的真实数据源后即可填充。
 */

export interface QcTrkHandlerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 自建更新通道调度参数，逐项取自 out/main/index.js 的 QcTrkUpdater 常量表：
 * checkIntervalMs=3600*1e3, startupDelayMs=15*1e3, concurrency=128 …
 * 仅在显式设置 ZCODE_QCTRK_UPDATE_BASE_URL 时启用；Fork 默认走 GitHub Releases。
 */
export const QCTRK_UPDATER_CONFIG = {
  baseUrl: process.env.ZCODE_QCTRK_UPDATE_BASE_URL || "",
  checkIntervalMs: 3_600_000,
  startupDelayMs: 15_000,
  concurrency: 128,
  minChunks: 256,
  maxChunks: 512,
  targetChunkBytes: 320 * 1024,
  minChunkBytes: 256 * 1024,
  minSplitBytes: 128 * 1024,
  maxStealsPerChunk: 6,
  stealMinAgeMs: 750,
  chunkRetries: 3,
  timeoutMs: 30_000,
} as const;

const EMPTY_USAGE: QcTrkUsageSnapshot = {
  tps: 0,
  sessionAverageTps: 0,
  turnUsed: 0,
  sessionUsed: 0,
  todayUsed: 0,
  last30DaysUsed: 0,
};

const EMPTY_ERRORS: QcTrkErrorReport = {
  currentRetries: 0,
  todayFailures: 0,
  byCode: {},
  recent: [],
};

let usageSnapshot: QcTrkUsageSnapshot = { ...EMPTY_USAGE };
/** 分屏隔离：每个会话单独累计，窗口互相不串数。 */
const usageBySession = new Map<string, QcTrkUsageSnapshot>();
let errorReport: QcTrkErrorReport = { ...EMPTY_ERRORS };
let deletedTasks: QcTrkDeletedTask[] = [];
let updateState: QcTrkUpdateState = { status: "idle", currentVersion: "" };
let installerPath: string | undefined;
/** 自动轮询控制器（15s 启动 + 1h 轮询、generation 守卫）。在 registerQcTrkIpcHandlers 中实例化。 */
let qctrkUpdater: QcTrkUpdater | null = null;

/** 应用退出时停止自动轮询定时器并作废在飞操作。 */
export function stopQcTrkUpdater(): void {
  qctrkUpdater?.stop();
}
/** 检查后缓存的待下载安装包（manifest 清单路径），下载时复用其 size/sha512。 */
let pendingInstaller: QcTrkUpdateFile | null = null;
let registered = false;

/**
 * 供 renderer 的逐轮用量上报、以及未来 host / services 上报使用。
 * 带 sessionId 时写入该会话的桶；不带时写全局快照（兼容旧调用方）。
 * Map 上限 64，超出时淘汰最早写入的会话，避免长时间运行无限增长。
 */
export function reportQcTrkUsage(snapshot: QcTrkUsageSnapshot, sessionId?: string): void {
  if (!sessionId) {
    usageSnapshot = { ...usageSnapshot, ...snapshot };
    return;
  }
  const merged = { ...(usageBySession.get(sessionId) ?? EMPTY_USAGE), ...snapshot };
  usageBySession.delete(sessionId);
  usageBySession.set(sessionId, merged);
  if (usageBySession.size > 64) {
    const oldest = usageBySession.keys().next().value;
    if (oldest !== undefined) usageBySession.delete(oldest);
  }
  usageSnapshot = merged;
}

/** 供失败重试链路记录错误明细，最多保留最近 60 条。 */
export function reportQcTrkError(entry: QcTrkErrorEntry): void {
  errorReport = {
    currentRetries: errorReport.currentRetries + 1,
    todayFailures: errorReport.todayFailures + 1,
    byCode: { ...errorReport.byCode, [entry.code]: (errorReport.byCode[entry.code] ?? 0) + 1 },
    recent: [...errorReport.recent, entry].slice(-60),
  };
}

/** 供会话删除链路登记仍残留本地数据的任务。 */
export function reportQcTrkDeletedTask(task: QcTrkDeletedTask): void {
  deletedTasks = [...deletedTasks.filter((item) => item.id !== task.id), task];
}

function publishUpdateState(state: QcTrkUpdateState): void {
  updateState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(PlatformChannels.QcTrkUpdateChanged, state);
    }
  }
}

/**
 * qctrk 自建更新通道（third-party manifest 服务）默认停用：
 * Fork 后更新统一由官方 electron-updater + GitHub Releases 接管，
 * 不再让客户端静默请求第三方域名，也不再跑两套重复的后台轮询。
 * 显式设置 ZCODE_QCTRK_UPDATE_BASE_URL 可重新启用（仅用于调试自建通道）。
 */
const QCTRK_BACKGROUND_UPDATE_ENABLED = Boolean(
  process.env.ZCODE_QCTRK_UPDATE_BASE_URL?.trim(),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractAmount(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const nested = (record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  for (const candidate of [
    record.balance,
    record.amount,
    record.remaining,
    nested.balance,
    nested.amount,
    nested.remaining,
    nested.total_balance,
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return `¥${(Math.round(candidate * 100) / 100).toFixed(2)}`;
    }
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

async function queryOneBalance(target: QcTrkBalanceTarget): Promise<QcTrkBalanceResult> {
  const queriedAt = Date.now();
  try {
    const url = `${target.baseURL.replace(/\/$/, "")}${target.balancePath || "/v1/balance"}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      return {
        targetId: target.id,
        ok: false,
        amountText: "—",
        error: `HTTP ${response.status}`,
        queriedAt,
      };
    }
    return {
      targetId: target.id,
      ok: true,
      amountText: extractAmount(body) ?? "—",
      raw: body,
      queriedAt,
    };
  } catch (error) {
    return {
      targetId: target.id,
      ok: false,
      amountText: "—",
      error: errorMessage(error),
      queriedAt,
    };
  }
}

/** 对代理地址做真实 TCP 握手连通性测试，适配 http/https/socks* 各协议。 */
function testProxyConnectivity(config: QcTrkProxyConfig): Promise<QcTrkProxyTestResult> {
  return new Promise((resolve) => {
    if (!config.url) {
      resolve({ ok: false, error: "未配置代理地址" });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      resolve({ ok: false, error: "代理地址格式无效" });
      return;
    }
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const started = Date.now();
    const socket = connect({ host: parsed.hostname, port });
    socket.setTimeout(5_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true, latencyMs: Date.now() - started });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "连接超时" });
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve({ ok: false, error: errorMessage(error) });
    });
  });
}

function dingtalkSign(secret: string): { timestamp: string; sign: string } {
  const timestamp = String(Date.now());
  const sign = createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  return { timestamp, sign: encodeURIComponent(sign) };
}

function feishuSign(secret: string): { timestamp: string; sign: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
  return { timestamp, sign };
}

/**
 * 产物 postOne 的返回形状：保留 HTTP status 才能区分「网络层失败（无 status）」、
 * 「5xx」与「业务错误码」，后者不做重试。
 */
interface WebhookPostResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

async function postWebhook(url: string, body: unknown): Promise<WebhookPostResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // 产物 AbortSignal.timeout(1e4)
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      // 钉钉 errcode / 飞书 code / 飞书 StatusCode，三者都是 0 表示成功。
      for (const key of ["errcode", "code", "StatusCode"] as const) {
        if (key in record) {
          const ok = record[key] === 0;
          return {
            ok,
            status: response.status,
            body: parsed,
            ...(ok ? {} : { error: `${key}=${String(record[key])}` }),
          };
        }
      }
    }
    return {
      ok: false,
      status: response.status,
      body: parsed,
      error: `unrecognized response shape (HTTP ${response.status})`,
    };
  } catch (error) {
    // 网络层错误没有 status，正是唯一必须重试的情形之一。
    return { ok: false, error: errorMessage(error) };
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 产物 M8(retryableDeliverFailure)：有 error 且无 status（网络层）或 status≥500 才重试。 */
function isRetryableDeliveryFailure(result: WebhookPostResult): boolean {
  if (!result.error) return false;
  return typeof result.status !== "number" || result.status >= 500;
}

/** 产物 sD(postWithRetry)：最多 2 次尝试，间隔 800ms；业务错误码不重试。 */
async function postWithRetry(url: string, body: unknown): Promise<WebhookPostResult> {
  const first = await postWebhook(url, body);
  if (first.ok || !isRetryableDeliveryFailure(first)) return first;
  await sleepMs(800);
  const second = await postWebhook(url, body);
  return second.ok || second.error ? second : first;
}

/**
 * 产物 nd：所有在飞的 webhook 推送。desktopNotifications 的转发是
 * fire-and-forget，退出时会丢通知；flushQcTrkNotifications 在退出前等待它们。
 */
const inFlightNotifications = new Set<Promise<unknown>>();
/** 产物 setQcTrkNotifyLogger：推送失败需要可诊断，不能静默丢弃。 */
let notifyLogger: QcTrkHandlerLogger | undefined;

function trackNotification<T>(promise: Promise<T>): void {
  inFlightNotifications.add(promise);
  // 用 then 的双分支而非 finally，避免生成一个未处理的 rejected promise。
  promise.then(
    () => inFlightNotifications.delete(promise),
    () => inFlightNotifications.delete(promise),
  );
}

/** 产物 cD(flushQcTrkNotifications)：退出前等待在飞推送，最多 3 秒；绝不阻塞退出。 */
export async function flushQcTrkNotifications(timeoutMs = 3_000): Promise<void> {
  if (inFlightNotifications.size === 0) return;
  try {
    await Promise.race([
      Promise.allSettled([...inFlightNotifications]),
      sleepMs(timeoutMs),
    ]);
  } catch {
    // allSettled 不会 reject；此处仅防御意外异常。
  }
}

function notifyText(config: QcTrkNotifyConfig, payload: QcTrkNotifyForwardPayload): string {
  const prefix = [config.taskPrefix, payload.isSubagent ? "🔹 子智能体完成" : ""]
    .filter(Boolean)
    .join(" ");
  const parts = [prefix, payload.title, `结果：${payload.summary}`];
  if (payload.error) parts.push(`错误：${payload.error}`);
  if (config.includeWorkspacePath && payload.workspacePath) {
    parts.push(`位置：${payload.workspacePath}`);
  }
  if (config.includeRemoteLink && payload.remoteLink) {
    parts.push(`远程链接：${payload.remoteLink}`);
  }
  if (config.keyword) parts.unshift(config.keyword);
  return parts.filter(Boolean).join("\n");
}

async function sendNotify(
  config: QcTrkNotifyConfig,
  payload: QcTrkNotifyForwardPayload,
  only?: "dingtalk" | "feishu",
): Promise<QcTrkNotifyTestResult> {
  const text = notifyText(config, payload);
  const tasks: Array<
    Promise<WebhookPostResult & { channel: "dingtalk" | "feishu" }>
  > = [];
  // 渠道独立开关（dingtalk.enabled / feishu.enabled）；旧配置缺字段时默认启用。
  if ((!only || only === "dingtalk") && config.dingtalkEnabled !== false && config.dingtalkWebhook) {
    const signed = config.dingtalkSecret ? dingtalkSign(config.dingtalkSecret) : undefined;
    const url = signed
      ? `${config.dingtalkWebhook}${config.dingtalkWebhook.includes("?") ? "&" : "?"}timestamp=${signed.timestamp}&sign=${signed.sign}`
      : config.dingtalkWebhook;
    tasks.push(
      postWithRetry(url, {
        msgtype: "text",
        text: { content: text },
        at: { atMobiles: config.atMobiles, isAtAll: config.atAll },
      }).then((result) => ({ ...result, channel: "dingtalk" as const })),
    );
  }
  if ((!only || only === "feishu") && config.feishuEnabled !== false && config.feishuWebhook) {
    const signed = config.feishuSecret ? feishuSign(config.feishuSecret) : undefined;
    tasks.push(
      postWithRetry(config.feishuWebhook, {
        msg_type: "text",
        content: { text },
        ...(signed ? { timestamp: signed.timestamp, sign: signed.sign } : {}),
      }).then((result) => ({ ...result, channel: "feishu" as const })),
    );
  }
  if (tasks.length === 0) return { ok: false, error: "未配置任何 webhook" };
  // 所有转发/测试推送都登记到在飞集合，退出前由 flushQcTrkNotifications 等待。
  const all = Promise.all(tasks);
  trackNotification(all);
  const results = await all;
  for (const result of results) {
    if (!result.ok) {
      notifyLogger?.warn(
        `[qctrk-notify] deliver ${result.channel} failed:`,
        result.error ?? `HTTP ${result.status ?? "?"}`,
      );
    }
  }
  const failed = results.find((result) => !result.ok);
  return failed
    ? {
        ok: false,
        channel: failed.channel,
        error: failed.error ?? `HTTP ${failed.status ?? "?"}`,
      }
    : { ok: true };
}

/**
 * 与官方「HTTP 代理」共用同一份配置：产物 saveProxyConfig 直接写
 * ~/.zcode/v2/setting.json 的 httpProxy / httpProxyNoProxy / httpProxyCaCertPath。
 * 用临时文件 + rename 原子替换，文件损坏时按空配置重建。
 */
async function syncOfficialProxySettings(config: QcTrkProxyConfig): Promise<void> {
  const file = join(getQcTrkConfigDir(), "setting.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在或内容损坏：按空配置重建，不覆盖原始文件直到写入成功。
  }

  if (config.enabled && config.url.trim()) {
    settings.httpProxy = config.url.trim();
    if (config.noProxy.trim()) settings.httpProxyNoProxy = config.noProxy.trim();
    else delete settings.httpProxyNoProxy;
    if (config.caPath.trim()) settings.httpProxyCaCertPath = config.caPath.trim();
    else delete settings.httpProxyCaCertPath;
  } else {
    delete settings.httpProxy;
    delete settings.httpProxyNoProxy;
    delete settings.httpProxyCaCertPath;
  }

  const serialized = JSON.stringify(settings, null, 2);
  const tempFile = `${file}.qctrk-proxy-tmp`;
  await writeFile(tempFile, serialized, "utf8");
  try {
    await rename(tempFile, file);
  } catch {
    await writeFile(file, serialized, "utf8");
  }
}

export type QcTrkNotifyForwardResult = "sent" | "skipped" | "failed";

/** 供 main 进程的系统通知链路把任务终态转发到钉钉 / 飞书。 */
export async function forwardQcTrkTaskNotification(
  payload: QcTrkNotifyForwardPayload,
): Promise<QcTrkNotifyForwardResult> {
  // 任务失败计入重试徽标 / 错误面板的今日统计与最近明细。
  // 取消是独立终态，不计入失败。
  if (payload.event === "failed") {
    reportQcTrkError({
      at: Date.now(),
      code: payload.error ?? "task_failed",
      message: payload.summary,
      attempt: 0,
    });
  }
  const config = await readQcTrkConfig("notify", DEFAULT_QCTRK_NOTIFY_CONFIG);
  if (!config.enabled || !config.events[payload.event]) return "skipped";
  if (payload.isSubagent && !config.subagentEnabled) return "skipped";
  // 远程（SSH）工作区任务终态：仅当 forwardRemote 开启时转发，与本地任务一致。
  //  forwardRemoteNotify 的 forward_remote_off / not_remote 闸门。
  if (payload.isRemote && !config.forwardRemote) return "skipped";
  const result = await sendNotify(config, payload);
  return result.ok ? "sent" : "failed";
}

async function checkForUpdate(
  currentVersion: string,
  signal?: AbortSignal,
): Promise<QcTrkUpdateState> {
  pendingInstaller = null;
  // 优先走 自建通道：<baseUrl>/manifest.yml（文本清单，含分块下载所需的 size/sha512）
  try {
    const manifest = await fetchManifest(
      QCTRK_UPDATE_CONFIG.baseUrl,
      signal ?? AbortSignal.timeout(10_000),
    );
    if (manifest.version && isNewer(manifest.version, currentVersion)) {
      const file = pickInstallerFile(manifest.files);
      pendingInstaller = file;
      return {
        status: file ? "available" : "idle",
        currentVersion,
        remoteVersion: manifest.version,
        releaseNotes: manifest.releaseNotes,
        error: file ? undefined : "清单中未找到适用于本平台的安装包",
      };
    }
    return {
      status: "idle",
      currentVersion,
      remoteVersion: manifest.version,
      releaseNotes: manifest.releaseNotes,
    };
  } catch (error) {
    // 回退到旧式 JSON feed（整包下载 + sha256）
    const feedUrl = process.env.ZCODE_QCTRK_UPDATE_FEED_URL;
    if (!feedUrl) {
      return { status: "error", currentVersion, error: errorMessage(error) };
    }
    try {
      const response = await fetch(feedUrl, {
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      const feed = (await response.json()) as {
        version?: string;
        notes?: string;
        url?: string;
        sha256?: string;
      };
      if (!feed.version) {
        return { status: "idle", currentVersion, error: "更新清单缺少版本号" };
      }
      pendingInstaller =
        feed.url && feed.sha256
          ? { url: feed.url, sha512: feed.sha256, size: 0 }
          : null;
      return {
        status: feed.version === currentVersion ? "idle" : "available",
        currentVersion,
        remoteVersion: feed.version,
        releaseNotes: feed.notes,
      };
    } catch (e2) {
      return { status: "error", currentVersion, error: errorMessage(e2) };
    }
  }
}

async function downloadUpdate(
  state: QcTrkUpdateState,
  signal?: AbortSignal,
  logger?: QcTrkHandlerLogger,
): Promise<void> {
  // 控制器在调用本函数前已把相位置为 downloading；回退路径则仍是 available。
  // 真正的前置校验由 QcTrkUpdater.download() 完成，这里只放行这两个相位。
  if (state.status !== "available" && state.status !== "downloading") return;
  // 清单路径：size>0 且带 sha512 时走 128 并发分块下载
  if (pendingInstaller && pendingInstaller.size > 0 && pendingInstaller.sha512) {
    await downloadUpdateChunked(state, pendingInstaller, signal, logger);
    return;
  }
  // 旧式 JSON feed 回退：整包下载 + sha256 校验
  await downloadUpdateLegacy(state, signal, logger);
}

/** 128 并发分块下载（忠实产物 downloadFileToFile）。 */
async function downloadUpdateChunked(
  state: QcTrkUpdateState,
  file: QcTrkUpdateFile,
  signal?: AbortSignal,
  logger?: QcTrkHandlerLogger,
): Promise<void> {
  publishUpdateState({ ...state, status: "downloading", progress: 0 });
  const dir = join(app.getPath("temp"), "zcode-qctrk-update");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, fileNameFromUrl(file.url));
  try {
    await downloadFileToFile(
      resolveFileUrl(file.url, QCTRK_UPDATE_CONFIG.baseUrl),
      file.size,
      dest,
      file.sha512,
      signal,
      (p) => {
        const progress =
          p.totalBytes > 0
            ? Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
            : 0;
        publishUpdateState({ ...state, status: "downloading", progress });
      },
    );
    installerPath = dest;
    logger?.info("[qctrk-update] 分块下载校验通过并落盘", dest);
    publishUpdateState({ ...state, status: "ready", progress: 100, installerPath: dest });
  } catch (error) {
    publishUpdateState({ ...state, status: "error", error: errorMessage(error) });
  }
}

/** 旧式 JSON feed 的整包下载 + sha256 校验（回退路径）。 */
async function downloadUpdateLegacy(
  state: QcTrkUpdateState,
  signal?: AbortSignal,
  logger?: QcTrkHandlerLogger,
): Promise<void> {
  const feedUrl = process.env.ZCODE_QCTRK_UPDATE_FEED_URL;
  if (!feedUrl) return;
  const response = await fetch(feedUrl, { signal: signal ?? AbortSignal.timeout(10_000) });
  const feed = (await response.json()) as { url?: string; sha256?: string };
  if (!feed.url || !feed.sha256) {
    throw new Error("更新清单缺少下载地址或校验值，拒绝落盘");
  }
  publishUpdateState({ ...state, status: "downloading", progress: 0 });
  const installer = await fetch(feed.url, { signal });
  const buffer = Buffer.from(await installer.arrayBuffer());
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== feed.sha256) {
    publishUpdateState({ ...state, status: "error", error: "安装包校验不通过" });
    return;
  }
  const dir = join(app.getPath("temp"), "zcode-qctrk-update");
  await mkdir(dir, { recursive: true });
  installerPath = join(dir, `ZCode-${state.remoteVersion ?? "update"}.exe`);
  await writeFile(installerPath, buffer);
  logger?.info("[qctrk-update] 安装包校验通过并落盘", installerPath);
  publishUpdateState({ ...state, status: "ready", progress: 100, installerPath });
}

/**
 * 用量快照：直接读 agent 运行时 DB（与 main 进程
 * getQcTrkUsage → v_/b6/v6 完全一致的 SQL 聚合）。
 *
 * 之前本 Fork 只在 renderer 用 v4 usage.cumulative 实时估算「本次已用 / 本会话平均」，
 * 导致与 读数偏差（会话级数据来自不同事实源）。现改为读同一份 agent DB，保证两边
 * 读数 1:1 一致：只跑一个 app 时，另一个「仅查看」读的是同一份数据。
 *
 * 口径（逐字段对齐产物 v_/b6/v6）：
 * - 今日已用 today：completed_at ≥ 本地零点的 model_usage（status=completed）token 合计；
 * - 30 天已用 hist30：started_at ≥ now-30d 的 token 合计（含全机所有会话，不限于当前）；
 * - 本会话已用 session：session_id 命中的 token 合计；
 * - 本次已用 turn：该会话最后一个 completed turn 的 token 合计；
 * - 本会话平均 avgTps：session（或最近一次压缩 tail 之后）completed 行的
 *   SUM(output+reasoning) / SUM(生成时长)，生成时长 = completed_at−first_token_at（或 duration_ms）；
 * - 实时速度 tps：留 0，由 renderer 按 v4 实时累计 token 估算（与产物 kQt 同口径）。
 *
 * token 合计列表达式与产物一致：input+output+reasoning+cache_creation。
 */
const QCTRK_TOKEN_SUM_SQL =
  "input_tokens + output_tokens + COALESCE(reasoning_tokens,0) + COALESCE(cache_creation_input_tokens,0)";
const QCTRK_TPS_TOKEN_SQL = "output_tokens + COALESCE(reasoning_tokens,0)";
const QCTRK_TPS_DURATION_SQL =
  "CASE WHEN first_token_at IS NOT NULL AND completed_at > first_token_at THEN completed_at - first_token_at WHEN duration_ms > 0 THEN duration_ms ELSE 0 END";
const QCTRK_SUBAGENT_TYPES = "('subagent_child','workflow_child','nested_workflow_child')";

function qctrkNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 与产物 m6 一致：候选 agent DB 路径，storage.dir 覆盖优先级最高，回退默认 ~/.zcode/cli/db/db.sqlite。 */
function qctrkAgentDbPaths(): string[] {
  const home = qctrkUserHome();
  const paths: string[] = [];
  try {
    const configPath = join(home, ".zcode", "cli", "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { storage?: { dir?: string } };
    const dir = raw?.storage?.dir;
    if (typeof dir === "string" && dir.trim()) {
      const resolved = dir.trim().replace(/^~/, home);
      paths.push(join(resolved, "cli", "db", "db.sqlite"));
    }
  } catch {
    // 无 config 或解析失败：回退默认路径。
  }
  paths.push(join(home, ".zcode", "cli", "db", "db.sqlite"));
  return [...new Set(paths)];
}

let qctrkAgentDb: { path: string; db: { exec(sql: string): void; prepare(sql: string): any; close(): void } } | null =
  null;

/** 与产物 ed()/f6() 一致：按路径缓存只读连接，路径变化或出错时重开。 */
function qctrkOpenAgentDb(): { path: string; db: any } | null {
  if (qctrkAgentDb) return qctrkAgentDb;
  for (const path of qctrkAgentDbPaths()) {
    if (!existsSync(path)) continue;
    try {
      const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout=2000");
      qctrkAgentDb = { path, db };
      return qctrkAgentDb;
    } catch {
      // 尝试下一个候选路径。
    }
  }
  return null;
}

function qctrkComputeUsage(sessionId: string | null | undefined): QcTrkUsageSnapshot {
  const empty: QcTrkUsageSnapshot = {
    tps: 0,
    sessionAverageTps: 0,
    turnUsed: 0,
    sessionUsed: 0,
    todayUsed: 0,
    last30DaysUsed: 0,
  };
  const handle = qctrkOpenAgentDb();
  if (!handle) return empty;
  const { db } = handle;
  const sid =
    typeof sessionId === "string" && sessionId.trim() && sessionId.trim() !== "draft"
      ? sessionId.trim()
      : null;
  try {
    const zeroDate = new Date();
    zeroDate.setHours(0, 0, 0, 0);
    const todayMidnight = zeroDate.getTime();
    const thirtyDaysAgo = Date.now() - 720 * 3600 * 1000;

    const todayRow = db
      .prepare(
        `SELECT COALESCE(SUM(${QCTRK_TOKEN_SUM_SQL}),0) v FROM model_usage WHERE status='completed' AND completed_at >= ?`,
      )
      .get(todayMidnight) as { v: number };
    const histRow = db
      .prepare(
        `SELECT COALESCE(SUM(${QCTRK_TOKEN_SUM_SQL}),0) v FROM model_usage WHERE status='completed' AND started_at >= ?`,
      )
      .get(thirtyDaysAgo) as { v: number };

    let sessionUsed = 0;
    let turnUsed = 0;
    let avgTps = 0;
    if (sid) {
      const sessionRow = db
        .prepare(
          `SELECT COALESCE(SUM(${QCTRK_TOKEN_SUM_SQL}),0) v FROM model_usage WHERE status='completed' AND session_id = ?`,
        )
        .get(sid) as { v: number };
      sessionUsed = qctrkNum(sessionRow?.v);

      const lastTurn = db
        .prepare(
          "SELECT turn_id FROM model_usage WHERE session_id=? AND status='completed' ORDER BY started_at DESC LIMIT 1",
        )
        .get(sid) as { turn_id: string | null };
      if (lastTurn?.turn_id) {
        const turnRow = db
          .prepare(
            `SELECT COALESCE(SUM(${QCTRK_TOKEN_SUM_SQL}),0) v FROM model_usage WHERE session_id=? AND status='completed' AND turn_id=?`,
          )
          .get(sid, String(lastTurn.turn_id)) as { v: number };
        turnUsed = qctrkNum(turnRow?.v);
      }

      // avgTps：与产物 v6 一致，存在上下文压缩时只统计 tail 之后的 completed 行。
      let tailTime = 0;
      try {
        const partRow = db
          .prepare(
            "SELECT json_extract(data,'$.tail_start_id') tail FROM part WHERE session_id=? AND json_extract(data,'$.type')='compaction' AND json_extract(data,'$.tail_start_id') IS NOT NULL ORDER BY time_created DESC LIMIT 1",
          )
          .get(sid) as { tail: string | null };
        if (partRow?.tail) {
          const msgRow = db
            .prepare("SELECT time_created t FROM message WHERE id=? AND session_id=?")
            .get(String(partRow.tail), sid) as { t: number };
          if (msgRow && typeof msgRow.t === "number") tailTime = msgRow.t;
        }
      } catch {
        tailTime = 0;
      }
      const aggRow = tailTime > 0
        ? db
            .prepare(
              `SELECT COALESCE(SUM(${QCTRK_TPS_TOKEN_SQL}),0) tk, COALESCE(SUM(${QCTRK_TPS_DURATION_SQL}),0) ms FROM model_usage WHERE status='completed' AND session_id=? AND started_at>=?`,
            )
            .get(sid, tailTime)
        : db
            .prepare(
              `SELECT COALESCE(SUM(${QCTRK_TPS_TOKEN_SQL}),0) tk, COALESCE(SUM(${QCTRK_TPS_DURATION_SQL}),0) ms FROM model_usage WHERE status='completed' AND session_id=?`,
            )
            .get(sid);
      const tk = qctrkNum((aggRow as { tk: number })?.tk);
      const ms = qctrkNum((aggRow as { ms: number })?.ms);
      if (ms > 0) {
        avgTps = Math.round((tk / (ms / 1000)) * 10) / 10;
      } else if (tailTime > 0) {
        // tail 之后尚无生成时长：回退到整段会话口径。
        const wholeRow = db
          .prepare(
            `SELECT COALESCE(SUM(${QCTRK_TPS_TOKEN_SQL}),0) tk, COALESCE(SUM(${QCTRK_TPS_DURATION_SQL}),0) ms FROM model_usage WHERE status='completed' AND session_id=?`,
          )
          .get(sid) as { tk: number; ms: number };
        if (qctrkNum(wholeRow?.ms) > 0) {
          avgTps = Math.round((qctrkNum(wholeRow?.tk) / (qctrkNum(wholeRow?.ms) / 1000)) * 10) / 10;
        }
      }
    }

    return {
      tps: 0,
      sessionAverageTps: avgTps,
      turnUsed,
      sessionUsed,
      todayUsed: qctrkNum(todayRow?.v),
      last30DaysUsed: qctrkNum(histRow?.v),
    };
  } catch {
    // 查询失败（DB 迁移/被占用）：关闭连接，下次重新打开，本次回落空快照。
    try {
      handle.db.close();
    } catch {
      // 忽略关闭错误。
    }
    qctrkAgentDb = null;
    return empty;
  }
}

export function registerQcTrkIpcHandlers(options: { logger?: QcTrkHandlerLogger } = {}): void {
  notifyLogger = options.logger;
  if (registered) return;
  registered = true;
  const version = app.getVersion();
  updateState = { status: "idle", currentVersion: version };

  // 自建更新通道：实例化控制器，供手动「检测更新 / 下载 / 取消」IPC 复用。
  // 默认不启动后台轮询，避免与 GitHub Releases 更新通道并发、也不请求第三方域名。
  qctrkUpdater = new QcTrkUpdater({
    notify: publishUpdateState,
    getCurrentVersion: () => app.getVersion(),
    onCheck: (signal) => checkForUpdate(version, signal),
    onDownload: (state, signal) => downloadUpdate(state, signal, options.logger),
    logger: options.logger,
  });
  if (QCTRK_BACKGROUND_UPDATE_ENABLED) qctrkUpdater.start();

  // 与 getQcTrkUsage 一致：直接读 agent DB 聚合，保证与 读数 1:1（同事实源）。
  ipcMain.handle(PlatformChannels.QcTrkUsage, (_event, sessionId?: string): QcTrkUsageSnapshot =>
    qctrkComputeUsage(sessionId),
  );
  ipcMain.handle(PlatformChannels.QcTrkUsageReport, (_event, report: QcTrkUsageReport): void => {
    if (!report?.sessionId) return;
    reportQcTrkUsage(report.snapshot, report.sessionId);
  });
  ipcMain.handle(
    PlatformChannels.QcTrkUsageInvalidate,
    (_event, sessionId?: string): void => {
      if (sessionId) {
        usageBySession.delete(sessionId);
      } else {
        usageBySession.clear();
        usageSnapshot = { ...EMPTY_USAGE };
      }
    },
  );
  ipcMain.handle(PlatformChannels.QcTrkErrors, (): QcTrkErrorReport => errorReport);
  ipcMain.handle(PlatformChannels.QcTrkDeletedTasks, (): QcTrkDeletedTask[] =>
    listDeletedTasksFromIndex(),
  );
  ipcMain.handle(
    PlatformChannels.QcTrkPurgeTask,
    (_event, request: string | QcTrkPurgeTaskRequest): void => {
      // 产物 purgeTask(f_) 兼容字符串与对象入参，这里保持一致。
      const taskId = typeof request === "string" ? request : request?.taskId;
      if (!taskId?.trim()) return;
      // 会话文件与数据库行由 host 的删除后清理链路（qctrkPurge.ts）真删；
      // 这里清掉任务索引残留并触发延迟 VACUUM。
      purgeTaskIndexRows(taskId);
      deletedTasks = deletedTasks.filter((task) => task.id !== taskId);
      scheduleQcTrkVacuum();
    },
  );

  ipcMain.handle(PlatformChannels.QcTrkBalanceGet, () =>
    readQcTrkConfig("balance", DEFAULT_QCTRK_BALANCE_CONFIG),
  );
  ipcMain.handle(PlatformChannels.QcTrkBalanceSet, (_event, config: QcTrkBalanceConfig) =>
    writeQcTrkConfig("balance", config),
  );
  ipcMain.handle(PlatformChannels.QcTrkBalanceQuery, async (_event, targetId?: string) => {
    const config = await readQcTrkConfig("balance", DEFAULT_QCTRK_BALANCE_CONFIG);
    const targets = config.targets.filter(
      (target) => target.enabled && (!targetId || target.id === targetId),
    );
    return Promise.all(targets.map(queryOneBalance));
  });
  ipcMain.handle(PlatformChannels.QcTrkBalanceAuto, async (): Promise<QcTrkBalanceTarget[]> => {
    // 自动读取已配置供应商：下一批从 IProviderSettingsService 注入，这里返回已保存的 auto 目标。
    const config = await readQcTrkConfig("balance", DEFAULT_QCTRK_BALANCE_CONFIG);
    return config.autoRead ? config.targets.filter((target) => target.kind === "auto") : [];
  });

  ipcMain.handle(PlatformChannels.QcTrkProxyGet, () =>
    readQcTrkConfig("proxy", DEFAULT_QCTRK_PROXY_CONFIG),
  );
  ipcMain.handle(PlatformChannels.QcTrkProxySet, async (_event, config: QcTrkProxyConfig) => {
    await writeQcTrkConfig("proxy", config);
    await syncOfficialProxySettings(config);
  });
  ipcMain.handle(PlatformChannels.QcTrkProxyTest, async (): Promise<QcTrkProxyTestResult> =>
    testProxyConnectivity(await readQcTrkConfig("proxy", DEFAULT_QCTRK_PROXY_CONFIG)),
  );

  ipcMain.handle(PlatformChannels.QcTrkNotifyGet, () =>
    readQcTrkConfig("notify", DEFAULT_QCTRK_NOTIFY_CONFIG),
  );
  ipcMain.handle(PlatformChannels.QcTrkNotifySet, (_event, config: QcTrkNotifyConfig) =>
    writeQcTrkConfig("notify", config),
  );
  ipcMain.handle(
    PlatformChannels.QcTrkNotifyTest,
    async (_event, channel: "dingtalk" | "feishu"): Promise<QcTrkNotifyTestResult> => {
      const config = await readQcTrkConfig("notify", DEFAULT_QCTRK_NOTIFY_CONFIG);
      return sendNotify(config, { event: "completed", title: "测试通知", summary: "推送配置正常" }, channel);
    },
  );
  ipcMain.handle(
    PlatformChannels.QcTrkNotifyForward,
    async (_event, payload: QcTrkNotifyForwardPayload): Promise<void> => {
      const result = await forwardQcTrkTaskNotification(payload);
      if (result === "failed") options.logger?.warn("[qctrk-notify] 推送失败", payload.event);
    },
  );

  ipcMain.handle(PlatformChannels.QcTrkAutocontGet, async () =>
    normalizeQcTrkAutocontConfig(await readQcTrkConfig("autocont", DEFAULT_QCTRK_AUTOCONT_CONFIG)),
  );
  ipcMain.handle(PlatformChannels.QcTrkAutocontSet, (_event, config: QcTrkAutocontConfig) =>
    writeQcTrkConfig("autocont", normalizeQcTrkAutocontConfig(config)),
  );

  ipcMain.handle(PlatformChannels.QcTrkUpdateGet, (): QcTrkUpdateState => updateState);
  ipcMain.handle(PlatformChannels.QcTrkUpdateCheck, async (): Promise<QcTrkUpdateState> => {
    return qctrkUpdater ? qctrkUpdater.check() : checkForUpdate(version);
  });
  ipcMain.handle(PlatformChannels.QcTrkUpdateDownload, async (): Promise<void> => {
    if (qctrkUpdater) {
      await qctrkUpdater.download();
      return;
    }
    try {
      await downloadUpdate(updateState, undefined, options.logger);
    } catch (error) {
      publishUpdateState({ ...updateState, status: "error", error: errorMessage(error) });
    }
  });
  ipcMain.handle(PlatformChannels.QcTrkUpdateCancel, (): void => {
    if (qctrkUpdater) {
      qctrkUpdater.cancel();
      return;
    }
    publishUpdateState({ ...updateState, status: "available" });
  });
  ipcMain.handle(PlatformChannels.QcTrkUpdateOpen, async (): Promise<void> => {
    if (installerPath) await shell.openPath(installerPath);
  });

  // === 模型扫描（main/index.js 的 scanModels / P_） ===
  // 会按「候选地址 × 鉴权方式」逐组探测，并把每次探测记录到 attempts
  // （renderer 的「探测过程」折叠区），同时把供应商自定义 headers 透传到每个请求。
  const qctrkScanTrim = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  const QCTRK_SCAN_URL_SUFFIXES = [
    "/v1/chat/completions", "/chat/completions",
    "/v1/messages", "/messages",
    "/v1/responses", "/responses",
    "/v1/models", "/models",
    "/v1/embeddings", "/embeddings",
    "/anthropic",
  ] as const;
  const qctrkScanCandidateUrls = (rawBaseUrl: string): string[] => {
    const trimmed = qctrkScanTrim(rawBaseUrl);
    if (!trimmed) return [];
    let base = trimmed.replace(/\/+$/, "");
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 8) {
      changed = false;
      for (const suffix of QCTRK_SCAN_URL_SUFFIXES) {
        if (base.toLowerCase().endsWith(suffix)) {
          base = base.slice(0, base.length - suffix.length).replace(/\/+$/, "");
          changed = true;
          break;
        }
      }
    }
    const urls: string[] = [];
    const push = (url: string) => {
      if (url && urls.indexOf(url) < 0) urls.push(url);
    };
    if (!/\/v1$/i.test(base)) push(`${base}/v1/models`);
    push(`${base}/models`);
    return urls;
  };
  const qctrkScanAuthHeaders = (
    rawApiKey: string,
  ): Array<{ name: string; headers: Record<string, string> }> => {
    const key = qctrkScanTrim(rawApiKey);
    if (key) {
      return [
        { name: "bearer", headers: { Authorization: `Bearer ${key}` } },
        { name: "x-api-key", headers: { "x-api-key": key } },
        { name: "raw", headers: { Authorization: key } },
      ];
    }
    return [{ name: "none", headers: {} }];
  };
  const qctrkScanPickList = (value: unknown, depth = 0): unknown[] | null => {
    if (depth > 4 || value == null) return null;
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    for (const key of ["data", "models", "result", "items", "list", "available"]) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const next = qctrkScanPickList(obj[key], depth + 1);
        if (next) return next;
      }
    }
    return null;
  };
  const qctrkScanIdOf = (item: unknown): string => {
    if (typeof item === "string") return qctrkScanTrim(item);
    if (!item || typeof item !== "object") return "";
    const obj = item as Record<string, unknown>;
    for (const key of ["id", "model", "modelId", "name"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  // 从 /models 条目里解析 下发的 contextWindow。
  // 字段别名、嵌套容器键与合法区间（8192~1e8）取自产物 I_ / D6 / qi。
  const QCTRK_CONTEXT_FIELD_KEYS = [
    "context_length", "contextLength",
    "max_context_length", "maxContextLength",
    "context_window", "contextWindow",
    "max_context", "maxContext",
    "max_input_tokens", "maxInputTokens",
    "max_model_len", "maxModelLen",
    "max_token_limit", "maxTokenLimit",
    "token_limit", "tokenLimit",
  ] as const;
  const QCTRK_CONTEXT_CONTAINER_KEYS = [
    "limit", "limits", "context", "context_window_info",
    "top_provider", "topProvider", "metadata", "spec", "capabilities", "pricing",
  ] as const;
  const QCTRK_CONTEXT_MIN = 8192;
  const QCTRK_CONTEXT_MAX = 1e8;
  const qctrkScanParseContextNumber = (value: unknown): number | undefined => {
    let numeric: number;
    if (typeof value === "number") {
      numeric = value;
    } else if (typeof value === "string") {
      const normalized = value.trim().replace(/,/g, "");
      const matched = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(normalized);
      if (!matched) return undefined;
      numeric = Number(matched[1]);
      const unit = matched[2]?.toLowerCase();
      if (unit === "m") numeric *= 1e6;
      else if (unit) numeric *= 1e3;
    } else {
      return undefined;
    }
    if (!Number.isFinite(numeric)) return undefined;
    numeric = Math.round(numeric);
    return numeric >= QCTRK_CONTEXT_MIN && numeric <= QCTRK_CONTEXT_MAX ? numeric : undefined;
  };
  const qctrkScanFindContextWindow = (item: unknown, depth = 0): number | undefined => {
    if (depth > 3 || !item || typeof item !== "object") return undefined;
    const obj = item as Record<string, unknown>;
    for (const key of QCTRK_CONTEXT_FIELD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const parsed = qctrkScanParseContextNumber(obj[key]);
        if (parsed !== undefined) return parsed;
      }
    }
    for (const key of QCTRK_CONTEXT_CONTAINER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const nested = qctrkScanFindContextWindow(obj[key], depth + 1);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  /** 与产物 extractModelDetails(H6) 一致：返回 {id, contextWindow?} 列表。 */
  const qctrkScanExtractModelDetails = (
    payload: unknown,
  ): Array<{ id: string; contextWindow?: number }> => {
    const list = qctrkScanPickList(payload);
    if (!list) return [];
    const out: Array<{ id: string; contextWindow?: number }> = [];
    const seen = new Set<string>();
    for (const item of list) {
      let id = qctrkScanIdOf(item);
      if (!id) continue;
      if (id.indexOf("models/") === 0) id = id.slice(7);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const contextWindow = qctrkScanFindContextWindow(item);
      out.push(contextWindow === undefined ? { id } : { id, contextWindow });
    }
    return out;
  };
  const qctrkScanFetchOnce = async (
    url: string,
    authHeaders: Record<string, string>,
    customHeaders: Record<string, string> | null,
  ): Promise<{ status: number; ok: boolean; payload: unknown; error?: string }> => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeaders,
    };
    if (customHeaders) {
      for (const [name, value] of Object.entries(customHeaders)) {
        if (typeof value === "string" && name) headers[name] = value;
      }
    }
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, ok: response.ok, payload };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const qctrkScanPayloadError = (payload: unknown): string => {
    if (!payload || typeof payload !== "object") return "";
    const obj = payload as Record<string, unknown>;
    const raw = obj.message ?? obj.error ?? obj.errmsg;
    return raw == null ? "" : String(raw).slice(0, 200);
  };
  const scanQcTrkModels = async (request: {
    baseURL: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<QcTrkScanModelsResult> => {
    const baseUrl = qctrkScanTrim(request.baseURL);
    const apiKey = qctrkScanTrim(request.apiKey);
    const customHeaders = request.headers ?? null;
    const urls = qctrkScanCandidateUrls(baseUrl);
    if (urls.length === 0) {
      return { ok: false, models: [], attempts: [], error: "no_base_url" };
    }
    const authMethods = qctrkScanAuthHeaders(apiKey);
    const attempts: QcTrkScanAttempt[] = [];
    const startedAt = Date.now();
    let lastError = "";
    let probeCount = 0;
    for (const url of urls) {
      for (const auth of authMethods) {
        if (probeCount >= 12 || Date.now() - startedAt > 40_000) {
          attempts.push({ url, auth: auth.name, status: 0, error: "aborted_budget" });
          return { ok: false, models: [], attempts, error: lastError || "budget_exhausted" };
        }
        probeCount += 1;
        const response = await qctrkScanFetchOnce(url, auth.headers, customHeaders);
        const details = response.payload ? qctrkScanExtractModelDetails(response.payload) : [];
        const attempt: QcTrkScanAttempt = { url, auth: auth.name, status: response.status };
        if (response.error) attempt.error = response.error;
        if (details.length) attempt.found = details.length;
        attempts.push(attempt);
        if (response.ok && details.length) {
          return {
            ok: true,
            models: details.map(({ id, contextWindow }) => ({
              id,
              alreadyAdded: false,
              ...(contextWindow === undefined ? {} : { contextWindow }),
            })),
            upstreamContextCount: details.filter((item) => item.contextWindow !== undefined).length,
            attempts,
          };
        }
        if (response.status && response.status !== 404 && response.status !== 405) {
          const detail = qctrkScanPayloadError(response.payload);
          lastError = `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
        } else if (response.error) {
          lastError = response.error;
        }
      }
    }
    return { ok: false, models: [], attempts, error: lastError || "not_found" };
  };

  ipcMain.handle(
    PlatformChannels.QcTrkScanModels,
    async (
      _event,
      request: { baseURL: string; apiKey: string; headers?: Record<string, string> },
    ): Promise<QcTrkScanModelsResult> => {
      try {
        return await scanQcTrkModels(request);
      } catch (error) {
        return {
          ok: false,
          models: [],
          attempts: [],
          error: errorMessage(error),
        };
      }
    },
  );

  // === 模型上下文窗口大小来源追踪（ 新增） ===
  ipcMain.handle(
    PlatformChannels.QcTrkModelContextSourcesGet,
    async (): Promise<QcTrkModelContextSourcesResult> => {
      try {
        return qctrkModelContextSourcesResult(readQcTrkModelContextSources());
      } catch (error) {
        return { ok: false, sources: {}, error: errorMessage(error) };
      }
    },
  );
  ipcMain.handle(
    PlatformChannels.QcTrkModelContextSourcesSet,
    async (_event, payload: unknown): Promise<QcTrkModelContextSourcesResult> => {
      try {
        const rawEntries: unknown[] =
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { entries?: unknown }).entries)
            ? (payload as { entries: unknown[] }).entries
            : [];
        const entries = rawEntries.filter(
          (item): item is QcTrkModelContextSourceInput =>
            Boolean(item) && typeof item === "object",
        );
        return qctrkModelContextSourcesResult(recordQcTrkModelContextSources(entries));
      } catch (error) {
        return {
          ok: false,
          sources: readQcTrkModelContextSources(),
          error: errorMessage(error),
        };
      }
    },
  );

  // 第二套后台检查（与 QcTrkUpdater 的轮询重复）。
  // Fork 后统一由 GitHub Releases 通道检查更新，这里仅在显式启用自建通道时保留。
  if (QCTRK_BACKGROUND_UPDATE_ENABLED) {
    const runBackgroundCheck = async (): Promise<void> => {
      const next = await checkForUpdate(version);
      if (next.status === "available") publishUpdateState(next);
    };
    const startupTimer = setTimeout(() => {
      void runBackgroundCheck();
      const pollTimer = setInterval(
        () => void runBackgroundCheck(),
        QCTRK_UPDATER_CONFIG.checkIntervalMs,
      );
      pollTimer.unref?.();
    }, QCTRK_UPDATER_CONFIG.startupDelayMs);
    startupTimer.unref?.();
  }
}
