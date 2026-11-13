/* oxlint-disable eslint(max-lines) -- 四个设置分区的文案表与表单结构集中维护，拆分会割裂与产物逐项对应的核对关系 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  PlugZap,
  Send,
} from "lucide-react";
import type {
  IPlatformService,
  QcTrkAutocontConfig,
  QcTrkBalanceConfig,
  QcTrkBalanceResult,
  QcTrkNotifyConfig,
  QcTrkNotifyEventKind,
  QcTrkProxyConfig,
  QcTrkProxyProtocol,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 四个设置分区。
 *
 * 视觉骨架逐项对齐产物 renderer 主 bundle（styles-Dx2FK6Z8.js 的
 * y1n / T1n / N1n / I1n 四个组件）：
 * - 根容器 `space-y-4`，内部是「多个独立卡片 + 顶层导语 + 保存栏」，不再把全部
 *   内容塞进一张卡片（那是上一版「组件都凑一起」的根因）。
 * - 卡片复用 SettingsGroupCard（rounded-xl border border-border bg-card），卡片内
 *   行复用 SettingsRow（border-t 分隔）。
 * - 子分组小标题（k9）只是浅色小字、**不带 border-t**，且放在卡片**外**（SectionGroup）。
 * - 导语是根容器里的顶层 `<p>`，不进卡片、不加内边距。
 * - 保存栏（V3）是 `pt-1` + flex 按钮行、**不带 border-t**；状态文字内联、按钮右对齐，
 *   所有主要按钮统一 `size=lg` 且带 `data-icon="inline-start"` 图标。
 * - 不展示写死的「配置文件」路径行：产物该行只在后端返回真实路径时才渲染，
 *   且表单里已有「不使用代理的地址」输入框，状态卡不再重复展示「直连白名单」。
 *
 * 卡片分组（产物实测）：
 * - 余额查询：3 张（配置 / 额外查询目标 / 余额结果）+ 导语 + 保存栏（保存·立即查询）
 * - 网络代理：2 张（代理配置 / 当前状态）+ 导语 + 保存栏（保存·测试连通性）
 * - 推送通知：6 张（总开关 / 钉钉 / 飞书 / 推送哪些事件 / 消息内容 / 钉钉@提醒）
 * - 自动继续：2 张（主配置 / 子代理与远程）+ 导语 + 保存栏（保存）
 */

type QcTrkApi = NonNullable<IPlatformService["qctrk"]>;
type Status = { text: string; ok: boolean } | null;

/** [中文（逐字取自产物）, 英文] */
const L = {
  balanceDesc: ["查询厂商与中转站的账户余额，结果显示在下方列表与输入框下方、重试按钮右侧。", "Query account balances of providers and relays. Results appear in the list below, under the composer and beside the retry button."],
  balanceEnabledLabel: ["启用余额显示", "Show balance"],
  balanceEnabledHint: ["关闭后不再自动查询，输入框下方的余额状态条也会隐藏。", "When off, balances are no longer polled and the balance bar under the composer is hidden."],
  balanceAutoReadLabel: ["自动读取已配置的厂商", "Auto-read configured providers"],
  balanceAutoReadHint: ["直接使用厂商设置里已填的 API Key 与 Base URL，无需在这手动重复填写。", "Reuse the API key and base URL from your provider settings instead of entering them again here."],
  balanceIntervalLabel: ["刷新间隔", "Refresh interval"],
  balanceIntervalHint: ["默认 6，可设 3–60；保存后约 10 秒内生效。", "Default 6, range 3–60. Takes effect within ~10s after saving."],
  balanceIntervalUnit: ["秒", "s"],
  balanceTargetsTitle: ["额外查询目标", "Additional targets"],
  balanceTargetsEmpty: ["暂无额外目标。开启「自动读取」后，会直接使用你的厂商配置。", "No additional targets. With auto-read enabled, your provider settings are used directly."],
  balanceTargetPrefix: ["目标", "Target"],
  balanceTargetName: ["名称", "Name"],
  balanceBaseURL: ["Base URL（可留空自动探测）", "Base URL (leave empty to auto-detect)"],
  balanceApiKey: ["API Key", "API key"],
  balanceAdd: ["新增", "Add"],
  balanceRemoveTitle: ["删除这一目标", "Remove this target"],
  balanceRemoveTarget: ["删除目标 ", "Remove target "],
  balanceQuery: ["立即查询", "Query now"],
  balanceRefresh: ["刷新余额", "Refresh balances"],
  balanceResultsTitle: ["余额", "Balances"],
  balanceQuerying: ["正在查询余额…", "Querying balances…"],
  balanceResultsEmpty: ["未发现可查询的目标（请先在厂商设置里配置 API Key）", "No queryable targets found (configure an API key in provider settings first)"],
  balanceResultsErrorHint: ["可先确认厂商设置里的 API Key 是否有效，再点右上角刷新重试。", "Check that the API key in provider settings is valid, then retry with Refresh."],
  balanceSuccessSummary: ["共 {total} 个 · 成功 {ok} 个 · 更新于 {time}", "{total} targets · {ok} succeeded · updated {time}"],
  balanceLastQueried: ["上次查询：", "Last queried: "],
  balanceError: ["错误：", "Error: "],
  adviceAuth: ["请到厂商设置里更新该站点的 API Key 后重试", "Update this site's API key in provider settings and retry"],
  adviceEndpoint: ["该站点可能不支持余额查询，可关闭「自动读取」或删除这一目标", "This site may not expose a balance endpoint; disable auto-read or remove this target"],
  adviceNetwork: ["确认 Base URL 可达；需要代理时先在代理设置里配置，然后刷新重试", "Verify the base URL is reachable; configure a proxy if needed, then refresh"],
  saved: ["已保存", "Saved"],
  saveFailed: ["保存失败：", "Save failed: "],
  queryFailed: ["查询失败：", "Query failed: "],

  proxyDesc: ["模型请求、MCP、命令工具与内置浏览器的出口流量都会经过代理。支持 HTTP / HTTPS / SOCKS4 / SOCKS4A / SOCKS5 / SOCKS5H。", "Model requests, MCP, command tools and the embedded browser all egress through this proxy. Supports HTTP / HTTPS / SOCKS4 / SOCKS4A / SOCKS5 / SOCKS5H."],
  proxyRestart: ["修改后需重启应用生效。", "Restart the app for changes to take effect."],
  proxyProtocolLabel: ["代理类型", "Proxy type"],
  proxyDirect: ["不使用代理（直连）", "No proxy (direct)"],
  proxySocks5h: ["SOCKS5H（代理端解析域名）", "SOCKS5H (proxy resolves DNS)"],
  proxySocks4a: ["SOCKS4A（代理端解析域名）", "SOCKS4A (proxy resolves DNS)"],
  proxySocks: ["SOCKS（同 SOCKS5H）", "SOCKS (same as SOCKS5H)"],
  proxyUrlLabel: ["代理地址", "Proxy address"],
  proxyUrlHint: ["与官方「HTTP 代理」设置项共用同一份配置（setting.json 的 httpProxy），在任一处修改都会同步。", "Shares the same setting.json httpProxy entry with the built-in HTTP proxy setting."],
  proxyUrlPlaceholder: ["127.0.0.1:10808 或 socks5://127.0.0.1:1080", "127.0.0.1:10808 or socks5://127.0.0.1:1080"],
  proxyNoProxyLabel: ["不使用代理的地址", "Bypass proxy for"],
  proxyNoProxyHint: ["逗号分隔的白名单。", "Comma-separated allowlist."],
  proxyNoProxyPlaceholder: ["localhost,127.0.0.1,.example.com", "localhost,127.0.0.1,.example.com"],
  proxyCaLabel: ["自定义 CA 证书", "Custom CA certificate"],
  proxyCaHint: ["PEM 根证书绝对路径。", "Absolute path to a PEM root certificate."],
  proxyTest: ["测试连通性", "Test connectivity"],
  proxyTesting: ["正在测试…", "Testing…"],
  proxyAvailable: ["代理可用", "Proxy reachable"],
  proxySaved: ["已保存，重启应用后生效", "Saved; restart the app to apply"],

  notifyDesc: ["任务完成 / 失败 / 需要确认时推送到钉钉或飞书群机器人。消息按「结果 / 运行信息 / 位置 / 摘要 / 错误」分区展示；有远程控制链接时钉钉换成带按钮的 actionCard 消息。消息按 UTF-8 字节预算发送（上限 20KB）。", "Push task completion / failure / confirmation requests to DingTalk or Feishu bots. Messages are grouped into result / runtime / location / summary / error sections, capped at 20KB UTF-8. With a remote-control link, DingTalk uses an actionCard with buttons."],
  notifyEnabledLabel: ["启用推送", "Enable notifications"],
  notifyEnabledHint: ["总开关。关闭后所有渠道都不再发送通知，配置内容保留。", "Master switch. When off, no channel sends notifications; settings are kept."],
  notifyPrefixLabel: ["任务名前缀", "Task name prefix"],
  notifyDingtalk: ["钉钉", "DingTalk"],
  notifyFeishu: ["飞书", "Feishu"],
  notifyChannelSuffix: ["机器人", " bot"],
  notifyChannelEnable: ["启用{name}推送", "Enable {name} notifications"],
  notifyBadgeOn: ["已启用", "Enabled"],
  notifyBadgeOff: ["已停用", "Disabled"],
  notifyWebhookLabel: ["Webhook 地址", "Webhook URL"],
  notifyDingtalkPlaceholder: ["https://oapi.dingtalk.com/robot/send?access_token=...", "https://oapi.dingtalk.com/robot/send?access_token=..."],
  notifyFeishuPlaceholder: ["https://open.feishu.cn/open-apis/bot/v2/hook/...", "https://open.feishu.cn/open-apis/bot/v2/hook/..."],
  notifySecretLabel: ["加签密钥", "Signing secret"],
  notifySecretHintDingtalk: ["SEC 开头", "Starts with SEC"],
  notifySecretHintFeishu: ["签名校验", "Signature verification"],
  notifyKeywordLabel: ["自定义关键词", "Custom keyword"],
  notifyEventsTitle: ["推送哪些事件", "Events to notify"],
  notifyContentTitle: ["消息内容", "Message content"],
  notifyAtTitle: ["钉钉 @ 提醒", "DingTalk @ mentions"],
  notifyIncludePath: ["带上工作区路径", "Include workspace path"],
  notifyIncludeSummary: ["带上消息摘要", "Include message summary"],
  notifyIncludeSubagents: ["包含子代理", "Include subagents"],
  notifyIncludeSubagentsHint: ["消息最前面会标注「子智能体完成」。", "Prefixes the message with 'Subagent completed'."],
  notifyForwardRemote: ["转发远程工作区", "Forward remote workspaces"],
  notifyForwardRemoteHint: ["远端 SSH 工作区里的任务完成时，由桌面端补发一次通知。", "For SSH workspaces, the desktop app re-sends the notification once."],
  notifyIncludeRemoteLink: ["附带远程控制链接", "Include remote control link"],
  notifyAtAll: ["钉钉 @所有人", "DingTalk @all"],
  notifyAtMobiles: ["钉钉 @指定手机号", "DingTalk @ phone numbers"],
  notifyAtMobilesPlaceholder: ["13800000000,13900000000", "13800000000,13900000000"],
  notifyTest: ["发送测试消息", "Send test message"],
  notifyNoChannel: ["没有已启用且配置了 Webhook 的渠道", "No enabled channel with a webhook configured"],
  notifyTesting: ["正在发送…", "Sending…"],
  notifyTestSent: ["测试消息已发送", "Test message sent"],
  notifyTestFailed: ["发送失败：", "Send failed: "],

  autocontDesc: ["临时故障中断时，自动发送下面这条消息让模型继续。额度耗尽、欠费、并发上限、鉴权失败、上下文超限这些情况不会自动继续（重试也没用，只会白白消耗额度）。用户按 Esc 取消同样不继续。", "On a transient failure, automatically send the message below so the model continues. Quota exhaustion, arrears, concurrency limits, auth failures and context overflow are not auto-continued, nor are user Esc cancellations."],
  autocontEnabledLabel: ["启用自动继续", "Enable auto-continue"],
  autocontEnabledHint: ["关闭后失败任务不再自动重试，行为回到原版。", "When off, failed tasks are not retried automatically."],
  autocontMaxLabel: ["连续自动继续上限", "Consecutive auto-continue limit"],
  autocontMaxHint: ["中途成功过一次就重新计数。到达上限后停止，避免无限空转。", "A success resets the counter. Stops at the limit to avoid endless retries."],
  autocontUnit: ["次", " times"],
  autocontTextLabel: ["自动发送的内容", "Message to send"],
  autocontTextHint: ["中断后以用户身份发出去的这条消息，内容会直接进对话。", "Sent as a user message when interrupted; it goes straight into the conversation."],
  autocontTextPlaceholder: ["继续", "Continue"],
  autocontSubagentsLabel: ["包含子代理的失败", "Include subagent failures"],
  autocontRemoteLabel: ["覆盖 SSH 远程工作区", "Apply to SSH remote workspaces"],

  eventCompleted: ["任务完成", "Task completed"],
  eventFailed: ["任务失败", "Task failed"],
  eventCancelled: ["任务取消", "Task cancelled"],
  eventPermission: ["需要确认", "Confirmation needed"],
  eventResolved: ["确认已处理", "Confirmation resolved"],
} as const;

type LabelKey = keyof typeof L;

function useQcTrkLabels() {
  const { intl, locale } = useZCodeIntl();
  const english = locale === "en-US";
  const s = useCallback((key: LabelKey): string => L[key][english ? 1 : 0], [english]);
  const t = useCallback((id: string): string => intl.formatMessage({ id }), [intl]);
  return { s, t };
}

const PROXY_PROTOCOLS: QcTrkProxyProtocol[] = [
  "http",
  "https",
  "socks5",
  "socks5h",
  "socks4",
  "socks4a",
  "socks",
];

const NOTIFY_EVENTS: Array<{ key: QcTrkNotifyEventKind; label: LabelKey }> = [
  { key: "completed", label: "eventCompleted" },
  { key: "failed", label: "eventFailed" },
  { key: "cancelled", label: "eventCancelled" },
  { key: "permission_required", label: "eventPermission" },
  { key: "permission_resolved", label: "eventResolved" },
];

function useQcTrkSection<T>(read: (qctrk: QcTrkApi) => Promise<T>, failurePrefix: string) {
  const platform = useOptionalPlatform();
  const qctrk = platform?.qctrk;
  const readRef = useRef(read);
  readRef.current = read;
  const failurePrefixRef = useRef(failurePrefix);
  failurePrefixRef.current = failurePrefix;
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    if (!qctrk) {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    void readRef
      .current(qctrk)
      .then((loaded) => {
        if (!disposed) {
          setValue(loaded);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [qctrk]);

  const save = useCallback(
    async (write: (api: QcTrkApi, next: T) => Promise<void>, message: string): Promise<void> => {
      if (!qctrk || value === null) return;
      setSaving(true);
      try {
        await write(qctrk, value);
        setStatus({ text: message, ok: true });
      } catch (error) {
        setStatus({
          text: `${failurePrefixRef.current}${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        });
      } finally {
        setSaving(false);
      }
    },
    [qctrk, value],
  );

  return { qctrk, value, setValue, loading, saving, status, setStatus, save };
}

// ── 与产物对齐的版式骨架 ────────────────────────────────────────────────

/** 区块外壳：加载/不可用态 + 根 space-y-4 容器（内含多张卡片）。
 * 分区标题由设置页顶部按 titleId 统一渲染，这里不再重复渲染，避免标题出现两次。 */
function SectionShell({
  loading,
  unavailable,
  children,
}: {
  loading: boolean;
  unavailable: boolean;
  children: ReactNode;
}) {
  const { t } = useQcTrkLabels();
  if (unavailable) {
    return <p className="text-ui-base text-foreground-subtle">{t("settings.qctrk.desktopOnly")}</p>;
  }
  if (loading) {
    return <p className="text-ui-base text-foreground-subtle">{t("settings.qctrk.loading")}</p>;
  }
  return <div className="min-w-0 space-y-4">{children}</div>;
}

/** 导语：顶层 <p>，不在卡片内、不加内边距（对齐产物 k9 之外的 description）。 */
function Description({ children }: { children: ReactNode }) {
  return <p className="text-ui-base leading-6 text-foreground-subtle">{children}</p>;
}

/** 子分组：浅色小标题 + 卡片，标题在卡片外、不带 border-t（对齐产物 k9 + section space-y-3）。 */
function SectionGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">{title}</div>
      <SettingsGroupCard>{children}</SettingsGroupCard>
    </div>
  );
}

/** 卡片内的标题行（带「新增 / 刷新」等操作按钮），首行无顶边框。 */
function CardHeader({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 first:border-t-0">
      <span className="text-ui-base font-medium text-foreground">{children}</span>
      {action}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsRow
      label={label}
      {...(description ? { description } : {})}
      control={
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label={label}
        />
      }
    />
  );
}

function FieldRow({
  label,
  description,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
  suffix,
  mono,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (next: string) => void;
  type?: "text" | "number" | "password";
  placeholder?: string;
  disabled?: boolean;
  suffix?: string;
  mono?: boolean;
}) {
  return (
    <SettingsRow
      label={label}
      {...(description ? { description } : {})}
      controlLayout="wide"
      control={
        // 必须 w-full：否则 Input 的 w-full 相对这个被 flex 收缩的容器，输入框会明显窄于
        // 同页直属 control 列的 SelectTrigger（280px），造成「输入框/下拉宽度不统一」。
        <div className="flex w-full min-w-0 items-center gap-2">
          <Input
            size="lg"
            type={type}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={label}
            className={mono ? "font-mono" : undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {suffix ? <span className="shrink-0 text-ui-base text-foreground-subtle">{suffix}</span> : null}
        </div>
      }
    />
  );
}

/** 数字输入 + 框内单位后缀（对齐产物：relative + absolute right-2 + pr-8）。 */
function NumberFieldWithUnit({
  label,
  description,
  value,
  onChange,
  unit,
  min,
  max,
  disabled,
  controlLayout = "wide",
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (next: string) => void;
  unit: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  controlLayout?: "default" | "wide";
}) {
  return (
    <SettingsRow
      label={label}
      {...(description ? { description } : {})}
      controlLayout={controlLayout}
      control={
        // 数字框固定 w-28（112px），不是撑满整列；单位用 absolute right-2 覆盖在框内。
        <div className="relative w-28">
          <Input
            size="lg"
            type="number"
            inputMode="numeric"
            value={value}
            min={min}
            max={max}
            disabled={disabled}
            aria-label={label}
            onChange={(event) => onChange(event.currentTarget.value)}
            className="pr-8 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ui-base text-foreground-subtle">
            {unit}
          </span>
        </div>
      }
    />
  );
}

/** 保存栏：pt-1 + flex 按钮行，不带 border-t；状态文字内联在按钮左侧（对齐产物 V3）。 */
function SaveBar({
  saving,
  onSave,
  label,
  extra,
  status,
  unavailable,
}: {
  saving: boolean;
  onSave: () => void;
  label: string;
  extra?: ReactNode;
  status?: Status;
  unavailable?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
      {unavailable || status ? (
        <span className="flex flex-wrap items-center gap-2">
          {status ? (
            <span
              className={
                status.ok ? "text-ui-base text-foreground-subtle" : "text-ui-base text-destructive"
              }
            >
              {status.text}
            </span>
          ) : null}
        </span>
      ) : undefined}
      <div className="flex items-center justify-end gap-2 sm:ml-auto">
        <Button type="button" size="lg" disabled={saving} onClick={onSave}>
          {saving ? (
            <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
          ) : (
            <Save data-icon="inline-start" aria-hidden="true" />
          )}
          {label}
        </Button>
        {extra}
      </div>
    </div>
  );
}

function balanceAdvice(error: string | undefined, s: (key: LabelKey) => string): string | null {
  if (!error) return null;
  if (/401|403|鉴权|unauthor|invalid[\s\S]*key/i.test(error)) return s("adviceAuth");
  if (/404|未提供余额接口/i.test(error)) return s("adviceEndpoint");
  if (/连接失败|超时|不可达|network|fetch/i.test(error)) return s("adviceNetwork");
  return null;
}

// ── 余额查询 ────────────────────────────────────────────────────────────

export function QcTrkBalanceSettingsSection() {
  const { s, t } = useQcTrkLabels();
  const section = useQcTrkSection<QcTrkBalanceConfig>((qctrk) => qctrk.getBalanceConfig(), s("saveFailed"));
  const { value, setValue, qctrk, saving, status, setStatus, save } = section;
  const [results, setResults] = useState<QcTrkBalanceResult[]>([]);
  const [querying, setQuerying] = useState(false);
  const [queried, setQueried] = useState(false);

  if (!value) {
    return (
      <SectionShell loading={section.loading} unavailable={!qctrk}>
        {null}
      </SectionShell>
    );
  }
  const config = value;
  const patch = (next: Partial<QcTrkBalanceConfig>) => setValue({ ...config, ...next });

  const addEmptyTarget = () => {
    patch({
      targets: [
        ...config.targets,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: "",
          kind: "custom",
          baseURL: "",
          apiKey: "",
          balancePath: "/v1/balance",
          enabled: true,
        },
      ],
    });
  };

  const query = () => {
    if (!qctrk || querying) return;
    setQuerying(true);
    setQueried(true);
    setStatus({ text: s("balanceQuerying"), ok: true });
    void qctrk
      .queryBalance()
      .then((items) => {
        setResults(items);
        const ok = items.filter((item) => item.ok).length;
        setStatus({
          text: s("balanceSuccessSummary")
            .replace("{total}", String(items.length))
            .replace("{ok}", String(ok))
            .replace("{time}", new Date().toLocaleTimeString()),
          ok: true,
        });
      })
      .catch((error) => {
        setStatus({
          text: `${s("queryFailed")}${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        });
      })
      .finally(() => setQuerying(false));
  };

  const names = new Map(config.targets.map((target) => [target.id, target.name]));

  return (
    <SectionShell loading={section.loading} unavailable={!qctrk}>
      <Description>{s("balanceDesc")}</Description>

      <SettingsGroupCard>
        <ToggleRow
          label={s("balanceEnabledLabel")}
          description={s("balanceEnabledHint")}
          checked={config.enabled}
          onChange={(enabled) => patch({ enabled })}
        />
        <ToggleRow
          label={s("balanceAutoReadLabel")}
          description={s("balanceAutoReadHint")}
          checked={config.autoRead}
          onChange={(autoRead) => patch({ autoRead })}
        />
        <NumberFieldWithUnit
          controlLayout="default"
          label={s("balanceIntervalLabel")}
          description={s("balanceIntervalHint")}
          unit={s("balanceIntervalUnit")}
          min={3}
          max={60}
          value={String(config.intervalSec)}
          onChange={(next) => patch({ intervalSec: Math.min(60, Math.max(3, Number(next) || 6)) })}
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <CardHeader
          action={
            <Button type="button" variant="ghost" size="sm" onClick={addEmptyTarget}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {s("balanceAdd")}
            </Button>
          }
        >
          {s("balanceTargetsTitle")}
        </CardHeader>
        {config.targets.length === 0 ? (
          <p className="px-4 py-3 text-ui-base text-foreground-subtle">
            {s("balanceTargetsEmpty")}
          </p>
        ) : (
          <div className="divide-y divide-border border-t border-border">
            {config.targets.map((target, index) => (
            <div
              key={target.id}
              className="grid grid-cols-1 items-center gap-2 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_auto]"
            >
              <Input
                size="lg"
                aria-label={`${s("balanceTargetPrefix")}${index + 1} ${s("balanceTargetName")}`}
                placeholder={s("balanceTargetName")}
                value={target.name}
                onChange={(event) =>
                  patch({
                    targets: config.targets.map((item) =>
                      item.id === target.id ? { ...item, name: event.currentTarget.value } : item,
                    ),
                  })
                }
              />
              <Input
                size="lg"
                aria-label={`${s("balanceTargetPrefix")}${index + 1} Base URL`}
                placeholder={s("balanceBaseURL")}
                className="font-mono"
                value={target.baseURL}
                onChange={(event) =>
                  patch({
                    targets: config.targets.map((item) =>
                      item.id === target.id ? { ...item, baseURL: event.currentTarget.value } : item,
                    ),
                  })
                }
              />
              <Input
                size="lg"
                aria-label={`${s("balanceTargetPrefix")}${index + 1} API Key`}
                placeholder={s("balanceApiKey")}
                className="font-mono"
                value={target.apiKey}
                onChange={(event) =>
                  patch({
                    targets: config.targets.map((item) =>
                      item.id === target.id ? { ...item, apiKey: event.currentTarget.value } : item,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label={`${s("balanceRemoveTarget")}${index + 1}`}
                title={s("balanceRemoveTitle")}
                onClick={() =>
                  patch({ targets: config.targets.filter((item) => item.id !== target.id) })
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            ))}
          </div>
        )}
      </SettingsGroupCard>

      <SaveBar
        saving={saving}
        label={t("settings.qctrk.save")}
        onSave={() => void save((api, next) => api.setBalanceConfig(next), s("saved"))}
        status={status}
        extra={
          <Button type="button" variant="outline" size="lg" disabled={querying} onClick={query}>
            {querying ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
            )}
            {s("balanceQuery")}
          </Button>
        }
      />

      {queried ? (
        <SettingsGroupCard>
          <CardHeader
            action={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={querying}
                onClick={query}
                aria-label={s("balanceRefresh")}
                title={s("balanceRefresh")}
              >
                {querying ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
              </Button>
            }
          >
            {s("balanceResultsTitle")}
          </CardHeader>
          {results.length === 0 ? (
            <p className="border-t border-border px-4 py-2 text-ui-base text-foreground-subtle">
              {s("balanceResultsEmpty")}
            </p>
          ) : (
            <div className="border-t border-border px-4 py-3">
              <p className="mb-2 text-ui-base text-foreground-subtle">
                {s("balanceSuccessSummary")
                  .replace("{total}", String(results.length))
                  .replace("{ok}", String(results.filter((item) => item.ok).length))
                  .replace("{time}", new Date().toLocaleTimeString())}
              </p>
              <ul className="space-y-2">
                {results.map((result) => {
                  const advice = balanceAdvice(result.error, s);
                  return (
                    <li key={result.targetId} className="flex min-w-0 items-start gap-2">
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${result.ok ? "bg-emerald-500" : "bg-destructive"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-ui-base text-foreground">
                            {names.get(result.targetId) ?? result.targetId}
                          </span>
                          <span className="shrink-0 text-ui-base font-medium text-foreground">
                            {result.ok ? result.amountText : "—"}
                          </span>
                        </div>
                        {!result.ok && result.error ? (
                          <p className="text-ui-sm text-destructive">
                            {s("balanceError")}
                            {result.error}
                          </p>
                        ) : null}
                        {advice ? (
                          <p className="text-ui-sm text-foreground-subtle">{advice}</p>
                        ) : null}
                        <p className="text-ui-sm text-foreground-subtle">
                          {s("balanceLastQueried")}
                          {new Date(result.queriedAt).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </SettingsGroupCard>
      ) : null}
    </SectionShell>
  );
}

// ── 网络代理 ────────────────────────────────────────────────────────────

export function QcTrkProxySettingsSection() {
  const { s, t } = useQcTrkLabels();
  const section = useQcTrkSection<QcTrkProxyConfig>((qctrk) => qctrk.getProxy(), s("saveFailed"));
  const { value, setValue, qctrk, saving, status, setStatus, save } = section;
  const [testing, setTesting] = useState(false);

  if (!value) {
    return (
      <SectionShell loading={section.loading} unavailable={!qctrk}>
        {null}
      </SectionShell>
    );
  }
  const config = value;
  const patch = (next: Partial<QcTrkProxyConfig>) => setValue({ ...config, ...next });
  const hasProxy = config.enabled && Boolean(config.url.trim());

  const test = () => {
    if (!qctrk || testing) return;
    setTesting(true);
    setStatus({ text: s("proxyTesting"), ok: true });
    void qctrk
      .testProxy()
      .then((result) => {
        // 失败态只展示后端返回的错误本身（红色由 SaveBar 的 ok=false 表达），
        // 不再叠加「失败：」前缀或单独的「配置错误」卡片——重复文案交给布局与颜色承担。
        setStatus({
          text: result.ok
            ? `${s("proxyAvailable")}${result.latencyMs != null ? ` ${result.latencyMs}ms` : ""}`
            : (result.error ?? ""),
          ok: result.ok,
        });
      })
      .catch((error) => {
        setStatus({
          text: error instanceof Error ? error.message : String(error),
          ok: false,
        });
      })
      .finally(() => setTesting(false));
  };

  return (
    <SectionShell loading={section.loading} unavailable={!qctrk}>
      <Description>
        {s("proxyDesc")} <span className="font-medium text-foreground">{s("proxyRestart")}</span>
      </Description>

      <SettingsGroupCard>
        <SettingsRow
          label={s("proxyProtocolLabel")}
          controlLayout="wide"
          control={
            <Select
              value={hasProxy ? config.protocol : "direct"}
              onValueChange={(next) => {
                if (next === "direct") {
                  patch({ enabled: false });
                } else {
                  patch({ enabled: true, protocol: next as QcTrkProxyProtocol });
                }
              }}
            >
              <SelectTrigger variant="input" size="lg" className="w-full min-w-0 justify-between">
                <SelectValue placeholder={s("proxyDirect")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">{s("proxyDirect")}</SelectItem>
                {PROXY_PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocol === "socks5h"
                      ? s("proxySocks5h")
                      : protocol === "socks4a"
                        ? s("proxySocks4a")
                        : protocol === "socks"
                          ? s("proxySocks")
                          : protocol.toUpperCase()}
                  </SelectItem>
                ))}
                {!PROXY_PROTOCOLS.includes(config.protocol) ? (
                  <SelectItem value={config.protocol}>{`${config.protocol}（当前配置）`}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          }
        />
        <FieldRow
          label={s("proxyUrlLabel")}
          description={s("proxyUrlHint")}
          placeholder={s("proxyUrlPlaceholder")}
          mono
          value={config.url}
          onChange={(url) => {
            patch({ url, enabled: Boolean(url.trim()) });
          }}
        />
        <FieldRow
          label={s("proxyNoProxyLabel")}
          description={s("proxyNoProxyHint")}
          placeholder={s("proxyNoProxyPlaceholder")}
          mono
          value={config.noProxy}
          onChange={(noProxy) => patch({ noProxy })}
        />
        <FieldRow
          label={s("proxyCaLabel")}
          description={s("proxyCaHint")}
          mono
          value={config.caPath}
          onChange={(caPath) => patch({ caPath })}
        />
      </SettingsGroupCard>

      <SaveBar
        saving={saving}
        label={t("settings.qctrk.save")}
        onSave={() => void save((api, next) => api.setProxy(next), s("proxySaved"))}
        status={status}
        extra={
          <Button type="button" variant="outline" size="lg" disabled={testing} onClick={test}>
            {testing ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <PlugZap data-icon="inline-start" aria-hidden="true" />
            )}
            {s("proxyTest")}
          </Button>
        }
      />
    </SectionShell>
  );
}

// ── 推送通知 ────────────────────────────────────────────────────────────

function NotifyChannelCard({
  channel,
  config,
  patch,
  s,
}: {
  channel: "dingtalk" | "feishu";
  config: QcTrkNotifyConfig;
  patch: (next: Partial<QcTrkNotifyConfig>) => void;
  s: (key: LabelKey) => string;
}) {
  const name = channel === "dingtalk" ? s("notifyDingtalk") : s("notifyFeishu");
  const enabled = channel === "dingtalk" ? config.dingtalkEnabled : config.feishuEnabled;
  const webhook = channel === "dingtalk" ? config.dingtalkWebhook : config.feishuWebhook;
  const secret = channel === "dingtalk" ? config.dingtalkSecret : config.feishuSecret;
  return (
    <SectionGroup title={`${name}${s("notifyChannelSuffix")}`}>
      <ToggleRow
        label={s("notifyChannelEnable").replace("{name}", name)}
        checked={enabled}
        onChange={(next) =>
          patch(channel === "dingtalk" ? { dingtalkEnabled: next } : { feishuEnabled: next })
        }
      />
      <FieldRow
        label={s("notifyWebhookLabel")}
        placeholder={
          channel === "dingtalk" ? s("notifyDingtalkPlaceholder") : s("notifyFeishuPlaceholder")
        }
        value={webhook}
        onChange={(next) =>
          patch(channel === "dingtalk" ? { dingtalkWebhook: next } : { feishuWebhook: next })
        }
      />
      <FieldRow
        label={s("notifySecretLabel")}
        description={channel === "dingtalk" ? s("notifySecretHintDingtalk") : s("notifySecretHintFeishu")}
        type="password"
        value={secret}
        onChange={(next) =>
          patch(channel === "dingtalk" ? { dingtalkSecret: next } : { feishuSecret: next })
        }
      />
      <FieldRow
        label={s("notifyKeywordLabel")}
        value={config.keyword}
        onChange={(keyword) => patch({ keyword })}
      />
    </SectionGroup>
  );
}

export function QcTrkNotifySettingsSection() {
  const { s, t } = useQcTrkLabels();
  const section = useQcTrkSection<QcTrkNotifyConfig>((qctrk) => qctrk.getNotifyConfig(), s("saveFailed"));
  const { value, setValue, qctrk, saving, status, setStatus, save } = section;
  const [testing, setTesting] = useState(false);

  if (!value) {
    return (
      <SectionShell loading={section.loading} unavailable={!qctrk}>
        {null}
      </SectionShell>
    );
  }
  const config = value;
  const patch = (next: Partial<QcTrkNotifyConfig>) => setValue({ ...config, ...next });

  // 单个「发送测试消息」，一次测所有启用且配置了 Webhook 的渠道；停用或未填的跳过。
  const testAll = () => {
    if (!qctrk || testing) return;
    setTesting(true);
    setStatus({ text: s("notifyTesting"), ok: true });
    const calls: Array<Promise<{ ok: boolean; error?: string }>> = [];
    if (config.dingtalkEnabled && config.dingtalkWebhook.trim()) {
      calls.push(
        qctrk.testNotify("dingtalk").catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      );
    }
    if (config.feishuEnabled && config.feishuWebhook.trim()) {
      calls.push(
        qctrk.testNotify("feishu").catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      );
    }
    if (calls.length === 0) {
      setStatus({ text: s("notifyNoChannel"), ok: false });
      setTesting(false);
      return;
    }
    void Promise.all(calls)
      .then((list) => {
        const failed = list.find((item) => !item.ok);
        setStatus({
          text: failed ? `${s("notifyTestFailed")}${failed.error ?? ""}` : s("notifyTestSent"),
          ok: !failed,
        });
      })
      .finally(() => setTesting(false));
  };

  return (
    <SectionShell loading={section.loading} unavailable={!qctrk}>
      <Description>{s("notifyDesc")}</Description>

      <SettingsGroupCard>
        <ToggleRow
          label={s("notifyEnabledLabel")}
          description={s("notifyEnabledHint")}
          checked={config.enabled}
          onChange={(enabled) => patch({ enabled })}
        />
        <FieldRow
          label={s("notifyPrefixLabel")}
          value={config.taskPrefix}
          onChange={(taskPrefix) => patch({ taskPrefix })}
        />
      </SettingsGroupCard>

      <NotifyChannelCard channel="dingtalk" config={config} patch={patch} s={s} />
      <NotifyChannelCard channel="feishu" config={config} patch={patch} s={s} />

      <SectionGroup title={s("notifyEventsTitle")}>
        {NOTIFY_EVENTS.map(({ key, label }) => (
          <ToggleRow
            key={key}
            label={s(label)}
            checked={config.events[key]}
            onChange={(checked) => patch({ events: { ...config.events, [key]: checked } })}
          />
        ))}
      </SectionGroup>

      <SectionGroup title={s("notifyContentTitle")}>
        <ToggleRow
          label={s("notifyIncludePath")}
          checked={config.includeWorkspacePath}
          onChange={(includeWorkspacePath) => patch({ includeWorkspacePath })}
        />
        <ToggleRow
          label={s("notifyIncludeSummary")}
          checked={config.includeLastReply}
          onChange={(includeLastReply) => patch({ includeLastReply })}
        />
        <ToggleRow
          label={s("notifyIncludeSubagents")}
          description={s("notifyIncludeSubagentsHint")}
          checked={config.subagentEnabled}
          onChange={(subagentEnabled) => patch({ subagentEnabled })}
        />
        <ToggleRow
          label={s("notifyForwardRemote")}
          description={s("notifyForwardRemoteHint")}
          checked={config.forwardRemote}
          onChange={(forwardRemote) => patch({ forwardRemote })}
        />
        <ToggleRow
          label={s("notifyIncludeRemoteLink")}
          checked={config.includeRemoteLink}
          onChange={(includeRemoteLink) => patch({ includeRemoteLink })}
        />
      </SectionGroup>

      <SectionGroup title={s("notifyAtTitle")}>
        <ToggleRow
          label={s("notifyAtAll")}
          checked={config.atAll}
          onChange={(atAll) => patch({ atAll })}
        />
        <FieldRow
          label={s("notifyAtMobiles")}
          placeholder={s("notifyAtMobilesPlaceholder")}
          disabled={config.atAll}
          value={config.atMobiles.join(",")}
          onChange={(next) =>
            patch({ atMobiles: next.split(",").map((item) => item.trim()).filter(Boolean) })
          }
        />
      </SectionGroup>

      <SaveBar
        saving={saving}
        label={t("settings.qctrk.save")}
        onSave={() => void save((api, next) => api.setNotifyConfig(next), s("saved"))}
        status={status}
        extra={
          <Button type="button" variant="outline" size="lg" disabled={testing} onClick={testAll}>
            {testing ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <Send data-icon="inline-start" aria-hidden="true" />
            )}
            {s("notifyTest")}
          </Button>
        }
      />
    </SectionShell>
  );
}

// ── 自动继续 ────────────────────────────────────────────────────────────

export function QcTrkAutocontSettingsSection() {
  const { s, t } = useQcTrkLabels();
  const section = useQcTrkSection<QcTrkAutocontConfig>((qctrk) => qctrk.getAutocontConfig(), s("saveFailed"));
  const { value, setValue, saving, status, save } = section;

  if (!value) {
    return (
      <SectionShell loading={section.loading} unavailable={!section.qctrk}>
        {null}
      </SectionShell>
    );
  }
  const config = value;
  const patch = (next: Partial<QcTrkAutocontConfig>) => setValue({ ...config, ...next });

  return (
    <SectionShell loading={section.loading} unavailable={!section.qctrk}>
      <Description>{s("autocontDesc")}</Description>

      <SettingsGroupCard>
        <ToggleRow
          label={s("autocontEnabledLabel")}
          description={s("autocontEnabledHint")}
          checked={config.enabled}
          onChange={(enabled) => patch({ enabled })}
        />
        <NumberFieldWithUnit
          label={s("autocontMaxLabel")}
          description={s("autocontMaxHint")}
          unit={s("autocontUnit")}
          min={1}
          max={50}
          value={String(config.maxAttempts)}
          onChange={(next) => patch({ maxAttempts: Math.min(50, Math.max(1, Number(next) || 3)) })}
        />
        <FieldRow
          label={s("autocontTextLabel")}
          description={s("autocontTextHint")}
          placeholder={s("autocontTextPlaceholder")}
          value={config.text}
          onChange={(text) => patch({ text })}
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <ToggleRow
          label={s("autocontSubagentsLabel")}
          checked={config.includeSubagents}
          onChange={(includeSubagents) => patch({ includeSubagents })}
        />
        <ToggleRow
          label={s("autocontRemoteLabel")}
          checked={config.forwardRemote}
          onChange={(forwardRemote) => patch({ forwardRemote })}
        />
      </SettingsGroupCard>

      <SaveBar
        saving={saving}
        label={t("settings.qctrk.save")}
        onSave={() => void save((api, next) => api.setAutocontConfig(next), s("saved"))}
        status={status}
      />
    </SectionShell>
  );
}
