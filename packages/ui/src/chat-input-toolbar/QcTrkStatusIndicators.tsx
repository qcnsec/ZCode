import { useEffect, useRef, useState } from "react";
import type {
  QcTrkBalanceConfig,
  QcTrkBalanceResult,
  QcTrkProxyConfig,
} from "@zcode/shared";
import type {
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useQcTrkSessionUsage } from "@/hooks/useQcTrkSessionUsage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatQcTrkUsageTokens } from "@/lib/tokenNumberFormat.js";

/**
 * 输入框附近展示件：
 * - 常驻用量条（实时速度、本会话平均、本次/本会话/30 天/今日已用）
 * - 当前供应商余额小徽标（查询失败保留上次结果）
 * - 代理状态徽标（仅代理 / 代理无效时显示；直连不占位，悬停看脱敏地址与配置错误）
 *
 * 会话级与累计用量全部来自 platform.qctrk.getUsage()：main 进程直接读 agent 运行时 DB
 * 的 model_usage 聚合（与 v_/b6/v6 同一份 SQL），renderer 每 3s 轮询一次；
 * 只有「实时速度」由 renderer 按 v4 usage.cumulative 实时累计 token 估算。
 * 因此只跑一个 app、另一个仅查看时，两边读数 1:1 一致。
 * Web / 手机远控没有 qctrk 能力时不渲染。
 */

const PROXY_POLL_MS = 10_000;
const BALANCE_POLL_MS = 6_000;

type QcTrkApi = NonNullable<NonNullable<ReturnType<typeof useOptionalPlatform>>["qctrk"]>;

/** 轮询读取，失败时保留上一次成功值；resetKey 变化（切换会话）时清空。 */
function useQcTrkPolling<T>(
  read: (qctrk: QcTrkApi) => Promise<T>,
  intervalMs: number,
  resetKey?: string,
): T | null {
  const platform = useOptionalPlatform();
  const qctrk = platform?.qctrk;
  const readRef = useRef(read);
  readRef.current = read;
  const [value, setValue] = useState<T | null>(null);
  const lastResetRef = useRef(resetKey);

  useEffect(() => {
    if (lastResetRef.current !== resetKey) {
      lastResetRef.current = resetKey;
      setValue(null);
    }
  }, [resetKey]);

  useEffect(() => {
    if (!qctrk) return;
    let disposed = false;
    const load = () => {
      void readRef.current(qctrk).then((next) => {
        if (!disposed && next !== null && next !== undefined) setValue(next);
      });
    };
    load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [qctrk, intervalMs]);

  return value;
}

/**
 * 用量条：今日 / 30 天 / 本会话已用 / 本次已用 / 本会话平均都来自 main 进程读 agent DB
 * 的聚合结果（getUsage），实时速度由 useQcTrkSessionUsage 按 v4 累计 token 估算。
 */
export function QcTrkUsageBar({
  usage,
  sessionId,
  phase,
}: {
  usage: SessionUsageState | null;
  sessionId: string | null;
  phase: SessionPhase | null;
  /** 以下字段保留以兼容调用方，当前用量已统一由 getUsage 提供 */
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const platform = useOptionalPlatform();
  const snapshot = useQcTrkSessionUsage({ usage, sessionId, phase });
  if (!platform?.qctrk) return null;
  // 思考中（无新 token）显示 0，不再用 ref 保留上一次速度。
  const tps = snapshot.tps;

  const items = [
    { label: t("settings.qctrk.usage.speed"), value: tps.toFixed(1), unit: "tok/s" },
    {
      label: t("settings.qctrk.usage.avg"),
      value: snapshot.sessionAverageTps.toFixed(1),
      unit: "tok/s",
    },
    { label: t("settings.qctrk.usage.turn"), value: formatQcTrkUsageTokens(snapshot.turnUsed), unit: "" },
    {
      label: t("settings.qctrk.usage.session"),
      value: formatQcTrkUsageTokens(snapshot.sessionUsed),
      unit: "",
    },
    {
      label: t("settings.qctrk.usage.last30Days"),
      value: formatQcTrkUsageTokens(snapshot.last30DaysUsed),
      unit: "",
    },
    {
      label: t("settings.qctrk.usage.today"),
      value: formatQcTrkUsageTokens(snapshot.todayUsed),
      unit: "",
    },
  ];

  return (
    <span
      data-qctrk="usage"
      title={t("settings.qctrk.usage.tip")}
      className="ml-1.5 inline-grid select-none gap-x-3.5 gap-y-px rounded-lg px-2 py-[3px] text-[10px] leading-[1.35] whitespace-nowrap tabular-nums opacity-90"
      style={{ gridAutoFlow: "column", gridTemplateRows: "repeat(2, auto)" }}
    >
      {items.map((item) => (
        <span key={item.label}>
          {/* 对齐 ：标签（含冒号）与数值紧贴，中间不再留空格 */}
          {item.label}
          <b className="font-semibold">{item.value}</b>
          {item.unit ? ` ${item.unit}` : ""}
        </span>
      ))}
    </span>
  );
}

/** 「无限额度」「—」这类没有精确数值的文本不构成可显示余额。 */
function hasPreciseBalanceAmount(amountText: string): boolean {
  return /-?\d+(?:\.\d+)?/.test(amountText ?? "");
}

/** 只显示当前所用供应商的余额；查询失败不清空已有数据，标记 stale。 */
export function QcTrkBalanceBadge() {
  const config = useQcTrkPolling<QcTrkBalanceConfig>((qctrk) => qctrk.getBalanceConfig(), 30_000);
  const results = useQcTrkPolling<QcTrkBalanceResult[]>(
    (qctrk) => qctrk.queryBalance(),
    Math.max(3, Math.min(60, config?.intervalSec ?? 6)) * 1_000 || BALANCE_POLL_MS,
  );
  const platform = useOptionalPlatform();
  if (!platform?.qctrk || config?.enabled === false) return null;
  const ok = (results ?? []).filter((item) => item.ok);
  if (ok.length === 0) return null;
  const shown = config?.currentProviderOnly ? ok.slice(0, 1) : ok;
  // 只有查到精确金额时才显示；「无限额度」等无数值结果
  // 不再出现占位文案。
  const precise = shown.filter((item) => hasPreciseBalanceAmount(item.amountText));
  if (precise.length === 0) return null;
  const stale = (results ?? []).some((item) => !item.ok);
  const text = precise.map((item) => item.amountText).join(" / ");

  return (
    <span
      data-qctrk-bal=""
      data-qctrk-bal-stale={stale ? "1" : undefined}
      title={shown.map((item) => `${item.targetId}: ${item.amountText}`).join("\n")}
      className="ml-1.5 inline-flex h-[22px] select-none items-center rounded-lg border border-border/60 bg-foreground/[0.04] px-2 text-[10px] leading-none whitespace-nowrap tabular-nums text-foreground-subtle opacity-90"
    >
      {text}
    </span>
  );
}

function maskProxyUrl(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@/i, "$1***@");
}

function resolveProxyView(config: QcTrkProxyConfig): {
  state: "direct" | "on" | "invalid";
  text: string;
  tip: string;
  protocol?: string;
} {
  const hasProxy = config.enabled && Boolean(config.url.trim());
  if (!hasProxy) {
    return {
      state: "direct",
      text: "直连",
      tip: "未使用代理（直连）",
    };
  }
  const protocol = config.protocol.toUpperCase();
  let valid = true;
  try {
    const url = new URL(config.url);
    valid = Boolean(url.hostname);
  } catch {
    valid = false;
  }
  const tip = [
    `代理：${maskProxyUrl(config.url) || "（地址为空）"}`,
    config.noProxy ? `直连白名单：${config.noProxy}` : "",
    valid ? "" : "配置有误：地址或协议不合法",
    "修改代理后需重启应用生效",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    state: valid ? "on" : "invalid",
    text: valid ? `代理 · ${protocol}` : "代理 · 无效",
    tip,
    ...(valid ? { protocol } : {}),
  };
}

export function QcTrkProxyBadge() {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const config = useQcTrkPolling<QcTrkProxyConfig>((qctrk) => qctrk.getProxy(), PROXY_POLL_MS);
  const platform = useOptionalPlatform();
  if (!platform?.qctrk || !config) return null;
  const view = resolveProxyView(config);
  // 直连时不再显示常驻「● 直连」占位，只有真正启用代理
  // （或代理配置无效）才提示。
  if (view.state === "direct") return null;

  return (
    <span
      data-qctrk-proxy={view.state}
      data-qctrk-proxy-protocol={view.protocol}
      title={view.tip}
      className={
        view.state === "invalid"
          ? "ml-1.5 inline-flex h-[22px] select-none items-center rounded-lg border border-border/60 bg-foreground/[0.04] px-2 text-[10px] leading-none whitespace-nowrap tabular-nums text-destructive opacity-90"
          : "ml-1.5 inline-flex h-[22px] select-none items-center rounded-lg border border-border/60 bg-foreground/[0.04] px-2 text-[10px] leading-none whitespace-nowrap tabular-nums text-foreground-subtle opacity-90"
      }
    >
      {view.state === "invalid"
        ? t("settings.qctrk.proxy.invalid")
        : `${t("settings.qctrk.proxy.on")} · ${view.protocol ?? ""}`}
    </span>
  );
}
