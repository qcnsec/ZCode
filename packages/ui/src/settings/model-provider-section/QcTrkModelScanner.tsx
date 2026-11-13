import { useCallback, useMemo, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { recordQcTrkUpstreamContextSources } from "@/hooks/useQcTrkModelContextSources.js";
import { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
import type { QcTrkScanAttempt, QcTrkScannedModel } from "@zcode/shared";

/**
 * 「一键扫描可用模型」。
 *
 * 扫描模型列表 → 勾选未添加的模型 → 批量写入供应商配置；文案走 i18n。
 *
 * 后端 scanQcTrkModels（main/qctrk/handlers.ts）按「候选地址 × 鉴权方式」
 * 逐组探测，把每次探测写入 attempts，并把供应商自定义 headers 透传到每个请求；
 * 这里渲染对应的「探测过程」折叠区。
 */

interface StatusMessage {
  text: string;
  ok: boolean;
}

export function QcTrkModelScanner({
  providerId,
  baseURL,
  apiKey,
  headers,
  existingModelIds,
  onAddModels,
}: {
  providerId: string;
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  existingModelIds: string[];
  onAddModels: (ids: string[]) => Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id }, values),
    [intl],
  );
  const qctrk = useOptionalPlatform()?.qctrk;
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [models, setModels] = useState<QcTrkScannedModel[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [attempts, setAttempts] = useState<QcTrkScanAttempt[] | null>(null);

  const existing = useMemo(() => new Set(existingModelIds), [existingModelIds]);
  const hasBaseURL = baseURL.trim().length > 0;
  const canScan = Boolean(qctrk) && hasBaseURL;

  const handleScan = useCallback(async () => {
    if (!qctrk || !canScan) return;
    setScanning(true);
    setStatus(null);
    setModels(null);
    setAttempts(null);
    try {
      const result = await qctrk.scanModels({
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      });
      setAttempts(result.attempts ?? null);
      const details = (result.models ?? [])
        .map((model) => ({ ...model, id: model.id?.trim() }))
        .filter((model): model is QcTrkScannedModel => Boolean(model.id));
      if (result.ok && details.length > 0) {
        setModels(details);
        const ids = details.map((model) => model.id);
        setSelected(new Set(ids.filter((id) => !existing.has(id))));
        const upstreamCount =
          result.upstreamContextCount ??
          details.filter((model) => model.contextWindow !== undefined).length;
        setStatus({
          text:
            upstreamCount > 0
              ? t("settings.qctrk.scan.foundWithUpstream", {
                  count: ids.length,
                  upstream: upstreamCount,
                })
              : t("settings.qctrk.scan.found", { count: ids.length }),
          ok: true,
        });
        // 记录 下发的 contextWindow，供模型行的「来源」徽标与后续智能计算优先采用。
        const upstreamEntries = details
          .filter((model) => model.contextWindow !== undefined)
          .map((model) => ({
            providerId,
            modelId: model.id,
            source: "upstream" as const,
            contextWindow: model.contextWindow,
          }));
        if (upstreamEntries.length > 0) {
          void recordQcTrkUpstreamContextSources(qctrk, upstreamEntries).catch(() => {
            // 来源落盘失败不影响扫描结果展示。
          });
        }
        return;
      }
      setModels(null);
      setSelected(new Set());
      setStatus({
        text: t("settings.qctrk.scan.notFound", {
          error: result.error ?? t("settings.qctrk.scan.unknown"),
        }),
        ok: false,
      });
    } catch (error) {
      setStatus({
        text: t("settings.qctrk.scan.failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        ok: false,
      });
    } finally {
      setScanning(false);
    }
  }, [qctrk, canScan, baseURL, apiKey, headers, existing, providerId, t]);

  const handleToggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAdd = useCallback(async () => {
    if (selected.size === 0) return;
    setAdding(true);
    setStatus(null);
    try {
      const ids = [...selected];
      await onAddModels(ids);
      setStatus({ text: t("settings.qctrk.scan.added", { count: ids.length }), ok: true });
      setSelected(new Set());
    } catch (error) {
      setStatus({
        text: t("settings.qctrk.scan.addFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        ok: false,
      });
    } finally {
      setAdding(false);
    }
  }, [selected, onAddModels, t]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleScan()}
          disabled={scanning || !canScan}
        >
          {scanning ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {t("settings.qctrk.scan.button")}
        </Button>

        {models && models.length > 0 ? (
          <>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleAdd()}
              disabled={adding || selected.size === 0}
            >
              {adding ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("settings.qctrk.scan.addSelected", { count: selected.size })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setSelected(
                  new Set(models.map((model) => model.id).filter((id) => !existing.has(id))),
                )
              }
            >
              {t("settings.qctrk.scan.selectAllMissing")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              {t("settings.qctrk.scan.clear")}
            </Button>
          </>
        ) : null}

        {!qctrk ? (
          <span className="text-ui-base text-foreground-subtle">
            {t("settings.qctrk.scan.unsupported")}
          </span>
        ) : null}
        {!hasBaseURL ? (
          <span className="text-ui-base text-foreground-subtle">
            {t("settings.qctrk.scan.needBaseUrl")}
          </span>
        ) : null}
      </div>

      {status ? (
        <div
          className={
            status.ok
              ? "text-ui-base text-foreground-subtle"
              : "text-ui-base text-destructive"
          }
        >
          {status.text}
        </div>
      ) : null}

      {attempts && attempts.length > 0 ? (
        <details className="group rounded-md border border-border">
          <summary className="flex cursor-pointer items-center gap-1 px-3 py-2 text-ui-base text-foreground-subtle">
            <ChevronDown
              data-icon="inline-start"
              aria-hidden="true"
              className="size-4 transition-transform group-open:rotate-180"
            />
            {t("settings.qctrk.scan.attempts")}
          </summary>
          <ul className="space-y-1 border-t border-border px-3 py-2 font-mono text-ui-sm">
            {attempts.map((attempt, index) => (
              <li
                key={`${attempt.url}-${attempt.auth}-${index}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
              >
                <span
                  className={
                    attempt.status > 0 && attempt.status !== 404 && attempt.status !== 405
                      ? "text-destructive"
                      : "text-foreground-subtle"
                  }
                >
                  {attempt.status > 0 ? `HTTP ${attempt.status}` : "ERR"}
                </span>
                <span className="text-foreground-subtle">·</span>
                <span className="text-foreground">{attempt.auth}</span>
                <span className="text-foreground-subtle">·</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{attempt.url}</span>
                {typeof attempt.found === "number" ? (
                  <span className="text-foreground-subtle">
                    {t("settings.qctrk.scan.attemptFound", { count: attempt.found })}
                  </span>
                ) : null}
                {attempt.error ? (
                  <span className="w-full text-destructive">
                    {t("settings.qctrk.scan.attemptError")}
                    {attempt.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {models && models.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border p-2">
          <div className="mb-1 px-1 text-ui-sm text-foreground-subtle">
            {t("settings.qctrk.scan.upstreamHint")}
          </div>
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
            {models.map((model) => {
              const id = model.id;
              const alreadyAdded = existing.has(id);
              const formattedContext =
                model.contextWindow === undefined
                  ? undefined
                  : formatModelContextWindowLabel(model.contextWindow, locale);
              const title =
                model.contextWindow !== undefined
                  ? t("settings.qctrk.scan.upstreamTip", { value: model.contextWindow })
                  : alreadyAdded
                    ? t("settings.qctrk.scan.existingTip")
                    : t("settings.qctrk.scan.inferredTip");
              return (
                <label
                  key={id}
                  title={title}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-ui-base hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    disabled={alreadyAdded}
                    onChange={() => handleToggle(id)}
                  />
                  <span className="min-w-0 truncate font-mono">{id}</span>
                  {formattedContext ? (
                    <span
                      data-qctrk-upstream-context={model.contextWindow}
                      className="inline-flex h-5 shrink-0 items-center rounded-md border border-border bg-surface px-1.5 font-mono text-ui-sm text-foreground-subtle"
                    >
                      {t("settings.qctrk.scan.upstreamBadge", { value: formattedContext })}
                    </span>
                  ) : null}
                  {alreadyAdded ? (
                    <span className="shrink-0 text-foreground-subtle">
                      {t("settings.qctrk.scan.existing")}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
