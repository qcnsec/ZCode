import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";

/**
 * 消息模型徽标。
 *
 * - model 字符串形如 `providerId/modelId$reasoning`（`$` 后是推理档位，
 *   `/` 前是 providerId；缺少 `/` 时只显示 modelId）；
 * - 显示 `modelId · 供应商名 · 推理档位`，默认透明、hover 行时淡入；
 * - DOM 锚点 data-qctrk-msg-model。
 *
 * v4 协议中只有 AssistantTextRow 携带 `model` 字段，UserInputRow 没有，因此用户消息上恒不渲染；
 * 这里只在 assistant row 挂载。
 */

interface ParsedModelValue {
  providerId: string;
  modelId: string;
  reasoning: string;
}

export function parseQcTrkMessageModel(value: string | undefined): ParsedModelValue | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const reasoningSeparator = text.lastIndexOf("$");
  const base =
    reasoningSeparator > 0 ? text.slice(0, reasoningSeparator) : text;
  const reasoning =
    reasoningSeparator > 0 ? text.slice(reasoningSeparator + 1) : "";
  const providerSeparator = base.lastIndexOf("/");
  if (providerSeparator <= 0 || providerSeparator === base.length - 1) {
    return { providerId: "", modelId: base, reasoning };
  }
  return {
    providerId: base.slice(0, providerSeparator),
    modelId: base.slice(providerSeparator + 1),
    reasoning,
  };
}

export function QcTrkMessageModelBadge({
  model,
  modelSelectionView,
}: {
  model?: string;
  modelSelectionView?: ModelSelectionView | null;
}) {
  const parsed = parseQcTrkMessageModel(model);
  if (!parsed) return null;
  const providerLabel = parsed.providerId
    ? resolveProviderLabel(parsed.providerId, modelSelectionView ?? null)
    : "";
  const parts = [parsed.modelId, providerLabel, parsed.reasoning].filter(
    (part) => part.trim().length > 0,
  );
  if (parts.length === 0) return null;
  const text = parts.join(" · ");

  return (
    <span
      data-qctrk-msg-model=""
      title={text}
      className="select-none text-[10px] leading-none text-foreground-subtle opacity-0 transition-opacity group-hover/user-row:opacity-70 group-hover/assistant-row:opacity-70"
    >
      {text}
    </span>
  );
}
