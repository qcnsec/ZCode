import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 上下文容量圈（ChatContextUsage / f0t）旁的「压缩」按钮，对应 p2t。
 *
 * 取证：styles-Dx2FK6Z8.js @3281762 的 p2t 是独立小按钮（SVG 压缩箭头 + 短文案），
 * 带 data-qctrk-compact-btn / -icon / -label、height:20、running 态与 2s 防抖，
 * 点击发送字面量命令 `/compact`。它不是 Button size="sm"，也不是容量圈的子节点。
 *
 * 渲染位置由 V4ComposerToolbar 决定：与容量圈同属右侧 submitControl 簇，
 * DOM 顺序为「压缩 → 容量圈」（与 G2t 中 p2t → f0t 一致）。
 */
const COMPACT_RUNNING_RESET_MS = 2000;

export function QcTrkCompactButton({
  disabled,
  onSendCompressionCommand,
}: {
  disabled?: boolean;
  onSendCompressionCommand?: (command: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [running, setRunning] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const fullLabel = intl.formatMessage({ id: "chat.compact.button" });
  const shortLabel = intl.formatMessage({ id: "chat.compact.button.short" });
  const runningLabel = intl.formatMessage({ id: "chat.compact.button.running" });
  const label = disabled ? runningLabel : fullLabel;
  const enabled = !disabled && !running && typeof onSendCompressionCommand === "function";

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!enabled || !onSendCompressionCommand) {
        return;
      }
      setRunning(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => setRunning(false), COMPACT_RUNNING_RESET_MS);
      try {
        Promise.resolve(onSendCompressionCommand("/compact")).catch(() => setRunning(false));
      } catch {
        setRunning(false);
      }
    },
    [enabled, onSendCompressionCommand],
  );

  return (
    <button
      type="button"
      data-qctrk-compact-btn=""
      aria-label={label}
      title={label}
      aria-disabled={!enabled}
      disabled={!enabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
      className={[
        "inline-flex flex-none items-center gap-1 rounded-md px-1 text-[10px] leading-none whitespace-nowrap",
        "text-foreground-subtle transition-colors",
        enabled
          ? "cursor-pointer hover:bg-surface-hover hover:text-foreground"
          : "cursor-not-allowed opacity-45",
        running ? "animate-pulse" : "",
      ].join(" ")}
      style={{ height: 20 }}
    >
      <svg
        data-qctrk-compact-icon=""
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="flex-none"
        aria-hidden="true"
      >
        <path d="M4 14h6v6" />
        <path d="M20 10h-6V4" />
        <path d="M14 10l7-7" />
        <path d="M3 21l7-7" />
      </svg>
      <span data-qctrk-compact-label="">{shortLabel}</span>
    </button>
  );
}
