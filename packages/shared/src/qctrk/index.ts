/**
 * 新增能力的共享协议与配置类型。
 *
 * 通道名、配置持久化文件名与 payload 形状均取自安装包产物：
 * - out/main/index.js / out/preload/index.cjs 中的 25 个 `zcode:qctrk-*` 通道
 * - qctrk-balance.json / qctrk-autocont.json / qctrk-remote-link.json
 * - renderer 的 settings.qctrk*Title 与 data-qctrk-* 标记
 *
 * 这里只定义协议与默认值，业务逻辑分别位于 desktop main 与 UI 层。
 */

export * from "./autoContinuePolicy.js";

export type QcTrkProxyProtocol =
  | "http"
  | "https"
  | "socks4"
  | "socks4a"
  | "socks5"
  | "socks5h"
  | "socks";

export type QcTrkProxyStatus = "direct" | "proxy" | "invalid";

export interface QcTrkProxyConfig {
  enabled: boolean;
  protocol: QcTrkProxyProtocol;
  /** 完整代理地址，例如 http://127.0.0.1:7890 或 socks5h://user:pass@host:1080 */
  url: string;
  /** 直连白名单，逗号分隔；与官方 HTTP 代理配置共用一份数据 */
  noProxy: string;
  /** 自定义 CA 证书路径（PEM） */
  caPath: string;
}

export interface QcTrkProxyTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface QcTrkBalanceTarget {
  id: string;
  name: string;
  /** auto = 从已配置供应商自动读取；custom = 手动添加的中转站 */
  kind: "auto" | "custom";
  baseURL: string;
  apiKey: string;
  /** 余额接口路径，不同中转站不一致，允许自定义 */
  balancePath: string;
  enabled: boolean;
}

export interface QcTrkBalanceConfig {
  enabled: boolean;
  /** 自动读取已配置厂商的 Key 与地址 */
  autoRead: boolean;
  /** 刷新间隔，范围 3–60 秒 */
  intervalSec: number;
  targets: QcTrkBalanceTarget[];
  /** 只显示当前所用供应商的余额小徽标 */
  currentProviderOnly: boolean;
}

export interface QcTrkBalanceResult {
  targetId: string;
  ok: boolean;
  /** 归一化后的余额文本，例如 ¥12.34 / 无限额度 */
  amountText: string;
  raw?: unknown;
  error?: string;
  queriedAt: number;
}

export type QcTrkNotifyEventKind =
  | "completed"
  | "failed"
  | "cancelled"
  | "permission_required"
  | "permission_resolved";

export interface QcTrkNotifyConfig {
  enabled: boolean;
  /** 钉钉渠道独立开关（dingtalk.enabled，默认开启） */
  dingtalkEnabled: boolean;
  /** 飞书渠道独立开关（feishu.enabled，默认开启） */
  feishuEnabled: boolean;
  dingtalkWebhook: string;
  dingtalkSecret: string;
  feishuWebhook: string;
  feishuSecret: string;
  /** 自定义关键词，钉钉安全设置使用 */
  keyword: string;
  atAll: boolean;
  atMobiles: string[];
  /** 卡片中携带工作区路径、模型最后回复摘要、任务名前缀 */
  includeWorkspacePath: boolean;
  includeLastReply: boolean;
  taskPrefix: string;
  /** 子智能体完成通知，默认不推 */
  subagentEnabled: boolean;
  events: Record<QcTrkNotifyEventKind, boolean>;
  /**
   * 远程（SSH）工作区任务终态是否也转发到钉钉/飞书。
   * 远程任务默认与本地任务同样转发，可用此开关单独关闭。
   */
  forwardRemote: boolean;
  /** 转发文案里附带远程控制链接（若有）。 */
  includeRemoteLink: boolean;
}

export interface QcTrkNotifyTestResult {
  ok: boolean;
  channel?: "dingtalk" | "feishu";
  error?: string;
}

export interface QcTrkAutocontConfig {
  enabled: boolean;
  /** 连续自动继续上限，范围 1–50；中途成功一次即清零 */
  maxAttempts: number;
  /** 自动发送的继续消息 */
  text: string;
  /** 子智能体任务是否也自动继续 */
  includeSubagents: boolean;
  /** 远程工作区是否转发自动继续 */
  forwardRemote: boolean;
}

/** 产物中 `var a8=50`：连续自动继续上限硬边界。 */
export const QCTRK_AUTOCONT_MAX_ATTEMPTS = 50;

/** 按产物 normalizeAutoContConfig 的规则收敛脏配置，避免落盘非法值。 */
export function normalizeQcTrkAutocontConfig(value: unknown): QcTrkAutocontConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const maxAttempts =
    typeof raw.maxAttempts === "number" && Number.isFinite(raw.maxAttempts)
      ? Math.min(QCTRK_AUTOCONT_MAX_ATTEMPTS, Math.max(1, Math.floor(raw.maxAttempts)))
      : DEFAULT_QCTRK_AUTOCONT_CONFIG.maxAttempts;
  const text =
    typeof raw.text === "string" && raw.text.trim()
      ? raw.text.trim()
      : DEFAULT_QCTRK_AUTOCONT_CONFIG.text;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_QCTRK_AUTOCONT_CONFIG.enabled,
    maxAttempts,
    text,
    includeSubagents:
      typeof raw.includeSubagents === "boolean"
        ? raw.includeSubagents
        : DEFAULT_QCTRK_AUTOCONT_CONFIG.includeSubagents,
    forwardRemote:
      typeof raw.forwardRemote === "boolean"
        ? raw.forwardRemote
        : DEFAULT_QCTRK_AUTOCONT_CONFIG.forwardRemote,
  };
}

export type QcTrkUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface QcTrkUpdateState {
  status: QcTrkUpdateStatus;
  currentVersion: string;
  remoteVersion?: string;
  progress?: number;
  releaseNotes?: string;
  installerPath?: string;
  error?: string;
  /** 最近一次检查完成的时间戳（ms）。 Updater 的 `checkedAt`。 */
  checkedAt?: number;
}

export interface QcTrkUsageSnapshot {
  /** 实时速度（token/s），保留最后一次有效值 */
  tps: number;
  sessionAverageTps: number;
  turnUsed: number;
  sessionUsed: number;
  todayUsed: number;
  last30DaysUsed: number;
}

/**
 * Renderer 把当前会话的用量快照回写到 main：
 * - 每个 sessionId 独立累计，分屏窗口互不串数；
 * - 窗口重连/组件重挂载时由 getUsage(sessionId) 读回上次累计继续累加。
 */
export interface QcTrkUsageReport {
  /** 会话标识；草稿态（sessionId=null）固定使用 "draft" */
  sessionId: string;
  snapshot: QcTrkUsageSnapshot;
}

export interface QcTrkErrorEntry {
  at: number;
  code: string;
  message: string;
  attempt: number;
}

export interface QcTrkErrorReport {
  /** 本轮重试次数 */
  currentRetries: number;
  /** 今日失败次数 */
  todayFailures: number;
  /** 按错误码分布 */
  byCode: Record<string, number>;
  /** 本会话最近 60 条明细 */
  recent: QcTrkErrorEntry[];
}

export interface QcTrkDeletedTask {
  id: string;
  title: string;
  deletedAt: number;
  /** 本地仍残留数据，可再次彻底删除 */
  hasLocalData: boolean;
  /** 产物 listDeletedTasks 的额外字段：归档 / 软删标记与工作区归属 */
  archived?: boolean;
  deleted?: boolean;
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** 产物 purgeQcTrkTask 的入参；main 侧兼容只传 taskId 字符串的旧调用。 */
export interface QcTrkPurgeTaskRequest {
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface QcTrkScannedModel {
  id: string;
  name?: string;
  alreadyAdded: boolean;
  /** /models 接口下发的上下文窗口大小；未下发时缺省（由本软件智能计算） */
  contextWindow?: number;
}

/**
 * 单次探测记录，对应 renderer 的「探测过程」折叠区。
 * url/auth 为本次实际请求的地址与鉴权方式；status 为 HTTP 状态码
 * （网络层失败时为 0）；found 为该地址实际解析到的模型数。
 */
export interface QcTrkScanAttempt {
  url: string;
  auth: string;
  status: number;
  error?: string;
  found?: number;
}

export interface QcTrkScanModelsResult {
  ok: boolean;
  models: QcTrkScannedModel[];
  attempts?: QcTrkScanAttempt[];
  error?: string;
  /** 携带 contextWindow 的模型数（用于扫描结果摘要） */
  upstreamContextCount?: number;
}

// ---------------------------------------------------------------------------
// 新增：模型上下文窗口大小来源追踪
// ---------------------------------------------------------------------------

/** 上下文窗口大小的来源： 下发 / 本软件智能计算 / 用户手动设置 */
export type QcTrkModelContextSource = "upstream" | "inferred" | "manual";

/** 单条来源记录，`<providerId>::<modelId>` 为键 */
export interface QcTrkModelContextSourceEntry {
  source: QcTrkModelContextSource;
  contextWindow?: number;
  updatedAt: number;
}

export type QcTrkModelContextSources = Record<string, QcTrkModelContextSourceEntry>;

/** 生成来源表的键，与产物 `${providerId}::${modelId}` 一致 */
export function qctrkModelContextKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export interface QcTrkModelContextSourcesResult {
  ok: boolean;
  sources: QcTrkModelContextSources;
  error?: string;
}

export interface QcTrkModelContextSourceInput {
  providerId: string;
  modelId: string;
  source: QcTrkModelContextSource;
  contextWindow?: number;
}

/**
 * 判定某模型当前生效的上下文窗口来源（对应产物 Vqn）。
 * 仅当来源表标记为 upstream、存有 contextWindow 且与当前生效值一致时才认作「 下发」；
 * 否则按是否有用户个人配置区分「手动设置」/「智能计算」。
 */
export function resolveQcTrkModelContextSource(params: {
  sources: QcTrkModelContextSources;
  providerId: string;
  modelId: string;
  personalContextWindow?: number | null;
  effectiveContextWindow?: number | null;
}): QcTrkModelContextSource {
  const entry = params.sources[qctrkModelContextKey(params.providerId, params.modelId)];
  if (
    entry?.source === "upstream" &&
    entry.contextWindow !== undefined &&
    params.effectiveContextWindow != null &&
    entry.contextWindow === params.effectiveContextWindow
  ) {
    return "upstream";
  }
  return params.personalContextWindow == null ? "inferred" : "manual";
}

export interface QcTrkNotifyForwardPayload {
  event: QcTrkNotifyEventKind;
  title: string;
  summary: string;
  error?: string;
  workspacePath?: string;
  isSubagent?: boolean;
  /** 是否为远程（SSH）工作区任务；配合 QcTrkNotifyConfig.forwardRemote 闸门。 */
  isRemote?: boolean;
  /** 可选的远程控制链接，includeRemoteLink 为 true 时附加到转发文案。 */
  remoteLink?: string;
}

/** 默认配置：与 行为一致，首次读取时落盘。 */
export const DEFAULT_QCTRK_BALANCE_CONFIG: QcTrkBalanceConfig = {
  enabled: true,
  autoRead: true,
  intervalSec: 6,
  targets: [],
  currentProviderOnly: true,
};

export const DEFAULT_QCTRK_PROXY_CONFIG: QcTrkProxyConfig = {
  enabled: false,
  protocol: "http",
  url: "",
  noProxy: "localhost,127.0.0.1,::1",
  caPath: "",
};

export const DEFAULT_QCTRK_NOTIFY_CONFIG: QcTrkNotifyConfig = {
  enabled: false,
  dingtalkEnabled: true,
  feishuEnabled: true,
  dingtalkWebhook: "",
  dingtalkSecret: "",
  feishuWebhook: "",
  feishuSecret: "",
  keyword: "",
  atAll: false,
  atMobiles: [],
  includeWorkspacePath: true,
  includeLastReply: true,
  taskPrefix: "ZCode",
  subagentEnabled: false,
  events: {
    completed: true,
    failed: true,
    cancelled: true,
    permission_required: true,
    permission_resolved: false,
  },
  forwardRemote: true,
  includeRemoteLink: true,
};

export const DEFAULT_QCTRK_AUTOCONT_CONFIG: QcTrkAutocontConfig = {
  enabled: true,
  maxAttempts: 3,
  text: "继续",
  includeSubagents: false,
  forwardRemote: true,
};

/**
 * preload 暴露给 renderer 的聚合 API。
 * 作为 IPlatformService 的可选字段存在，web / 手机远控实现无需提供。
 */
export interface QcTrkPlatformApi {
  /** 省略 sessionId 时返回最近一次上报的全局快照 */
  getUsage(sessionId?: string): Promise<QcTrkUsageSnapshot>;
  /** 回写当前会话的逐轮 token 用量（见 useQcTrkSessionUsage） */
  reportUsage(report: QcTrkUsageReport): Promise<void>;
  invalidateUsage(sessionId?: string): Promise<void>;
  getErrors(): Promise<QcTrkErrorReport>;
  getBalanceConfig(): Promise<QcTrkBalanceConfig>;
  setBalanceConfig(config: QcTrkBalanceConfig): Promise<void>;
  queryBalance(targetId?: string): Promise<QcTrkBalanceResult[]>;
  /** 自动读取已配置供应商的 Key 与地址，返回可作为余额查询目标的项目 */
  autoReadBalanceTargets(): Promise<QcTrkBalanceTarget[]>;
  getProxy(): Promise<QcTrkProxyConfig>;
  setProxy(config: QcTrkProxyConfig): Promise<void>;
  testProxy(): Promise<QcTrkProxyTestResult>;
  getNotifyConfig(): Promise<QcTrkNotifyConfig>;
  setNotifyConfig(config: QcTrkNotifyConfig): Promise<void>;
  testNotify(channel: "dingtalk" | "feishu"): Promise<QcTrkNotifyTestResult>;
  forwardNotify(payload: QcTrkNotifyForwardPayload): Promise<void>;
  getAutocontConfig(): Promise<QcTrkAutocontConfig>;
  setAutocontConfig(config: QcTrkAutocontConfig): Promise<void>;
  getUpdateState(): Promise<QcTrkUpdateState>;
  checkUpdate(): Promise<QcTrkUpdateState>;
  downloadUpdate(): Promise<void>;
  cancelUpdate(): Promise<void>;
  openUpdateInstaller(): Promise<void>;
  onUpdateChanged(callback: (state: QcTrkUpdateState) => void): () => void;
  listDeletedTasks(): Promise<QcTrkDeletedTask[]>;
  purgeTask(request: string | QcTrkPurgeTaskRequest): Promise<void>;
  scanModels(request: {
    baseURL: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<QcTrkScanModelsResult>;
  /** 读取全部模型的上下文窗口来源快照 */
  getModelContextSources(): Promise<QcTrkModelContextSourcesResult>;
  /** 合并写入来源记录（扫描到 值时调用） */
  setModelContextSources(
    payload: { entries: QcTrkModelContextSourceInput[] },
  ): Promise<QcTrkModelContextSourcesResult>;
}
