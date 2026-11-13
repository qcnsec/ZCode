export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // token 数值仍应走本地化 compact；中文展示万/亿，英文展示 K/M/B。
  // 之前为了修 Start Plan 的英文 long unit 误把所有 locale 都强制成 K/M/B。
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // 模型列表的容量 badge 是技术规格，不应随中文 locale 变成“万/亿”。
  return formatCompactTokenNumber("en-US", contextWindow);
}

/**
 * 常驻用量条的「万 / 亿」写法。
 *
 * 之前 1 亿以上固定两位小数（`1.23亿`），每 100 万才跳一格，一次请求几万 token
 * 看不到变化。现在改为「多少亿多少万」：`1亿2345.7万`，万级增量立刻可见。
 * 刚好整亿时只显示 `1亿`（不出现 `1亿0万`）；1 万以下、1 亿以下的显示保持不变。
 * 对齐 renderer 的 PJ / DQt。
 */
export function formatQcTrkUsageTokens(value: number): string {
  const t = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (t < 1e4) return String(t);
  if (t < 1e8) return `${stripTrailingZeros((t / 1e4).toFixed(1))}万`;
  const billions = Math.floor(t / 1e8);
  const tenThousands = (t % 1e8) / 1e4;
  // 余量不足 500（0.05 万）时视为整亿，避免出现「1亿0万」。
  if (tenThousands < 0.05) return `${billions}亿`;
  return `${billions}亿${stripTrailingZeros(tenThousands.toFixed(1))}万`;
}

function stripTrailingZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}
