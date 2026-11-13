import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export type ProviderDetailFeedbackState = "pending" | "success" | "failure";

export interface ProviderDetailFeedbackInput {
  key: string;
  message: string;
  state: ProviderDetailFeedbackState;
  /** 连接测试成功使用语义绿；保存/删除沿用中性反馈，不按文案或 key 推断操作。 */
  successEmphasis?: boolean;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
}

interface ProviderDetailFeedbackContextValue {
  showFeedback: (input: ProviderDetailFeedbackInput) => void;
  dismissFeedback: (key: string) => void;
}

const ProviderDetailFeedbackContext = createContext<ProviderDetailFeedbackContextValue>({
  showFeedback: () => undefined,
  dismissFeedback: () => undefined,
});

export function useProviderDetailFeedback(): ProviderDetailFeedbackContextValue {
  return useContext(ProviderDetailFeedbackContext);
}

function resolveDefaultDuration(state: ProviderDetailFeedbackState): number {
  if (state === "pending") return 0;
  return state === "failure" ? 8_000 : 3_500;
}

/**
 * 同时最多展示的反馈条数。批量添加/删除模型时，每个模型有独立 key，
 * 过去会无上限地从底部堆叠到铺满详情区；限制条数后再按重要性淘汰，
 * 保证失败（尤其带重试/关闭按钮）永远可见。
 */
const MAX_VISIBLE_FEEDBACK = 3;

/** 常驻 pending 的兜底时长：正常流程会被 success/failure 覆盖，异常中断时不能永久残留。 */
const PENDING_SAFETY_TIMEOUT_MS = 60_000;

/** 保留优先级：数值越大越不该被淘汰。 */
function feedbackRetentionRank(item: ProviderDetailFeedbackInput): number {
  if (item.state === "failure") return 3;
  // 需要用户操作的反馈（重试、手动关闭）不能悄悄消失。
  if (item.onAction || item.dismissible) return 2;
  if (item.state === "pending") return 1;
  return 0;
}

/**
 * 超出上限时淘汰最旧的低价值反馈。protectedIndex 是本次刚写入/更新的条目，
 * 必须保留，避免用户看不到自己刚触发操作的结果。
 */
function trimVisibleFeedback(
  items: ProviderDetailFeedbackInput[],
  protectedIndex: number,
): ProviderDetailFeedbackInput[] {
  if (items.length <= MAX_VISIBLE_FEEDBACK) return items;
  const overflow = items.length - MAX_VISIBLE_FEEDBACK;
  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => index !== protectedIndex)
    // 低保留价值优先淘汰；同等价值时淘汰更旧的（数组靠前）。
    .sort((a, b) => {
      const rank = feedbackRetentionRank(a.item) - feedbackRetentionRank(b.item);
      return rank !== 0 ? rank : a.index - b.index;
    });
  const dropped = new Set(candidates.slice(0, overflow).map(({ index }) => index));
  return items.filter((_, index) => !dropped.has(index));
}

export function ProviderDetailFeedbackBoundary({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ProviderDetailFeedbackInput[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissFeedback = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(key);
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);

  const showFeedback = useCallback(
    (input: ProviderDetailFeedbackInput) => {
      const previousTimer = timersRef.current.get(input.key);
      if (previousTimer) clearTimeout(previousTimer);
      timersRef.current.delete(input.key);
      setItems((current) => {
        const existingIndex = current.findIndex((item) => item.key === input.key);
        if (existingIndex < 0) {
          // 新反馈永远保留（放在末尾），再淘汰多余的最旧成功提示。
          const next = [...current, input];
          return trimVisibleFeedback(next, next.length - 1);
        }
        const next = [...current];
        next[existingIndex] = input;
        return trimVisibleFeedback(next, existingIndex);
      });

      const durationMs = input.durationMs ?? resolveDefaultDuration(input.state);
      // durationMs=0 表示常驻（pending）；仍挂一个兜底定时器，防止操作被
      // 后续编辑取代、或组件异常中断时留下永不消失的「正在保存/连接中」。
      const effectiveDurationMs = durationMs > 0 ? durationMs : PENDING_SAFETY_TIMEOUT_MS;
      timersRef.current.set(
        input.key,
        setTimeout(() => dismissFeedback(input.key), effectiveDurationMs),
      );
    },
    [dismissFeedback],
  );

  // 被上限淘汰的条目不会再走到 dismissFeedback，同步清掉它们的定时器，
  // 避免批量操作时残留一批到期后才空转的 timer。
  useEffect(() => {
    const timers = timersRef.current;
    const visibleKeys = new Set(items.map((item) => item.key));
    for (const [key, timer] of timers) {
      if (!visibleKeys.has(key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }
  }, [items]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const contextValue = useMemo(
    () => ({ showFeedback, dismissFeedback }),
    [dismissFeedback, showFeedback],
  );

  return (
    <ProviderDetailFeedbackContext.Provider value={contextValue}>
      {children}
      {/* 整页滚动后，内容底部可能在屏外；覆盖层不占高度，sticky 以 main 视口定位反馈。 */}
      <div className="pointer-events-none absolute inset-3 flex flex-col justify-end sm:inset-4">
        <div
          className="sticky bottom-3 z-20 flex flex-col gap-2 sm:bottom-4"
          data-testid="provider-detail-feedback-viewport"
          aria-live="polite"
        >
          {items.map((item) => (
            <div
              key={item.key}
              role={item.state === "failure" ? "alert" : "status"}
              data-provider-detail-feedback-state={item.state}
              className={cn(
                "pointer-events-auto flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 backdrop-blur-sm",
                item.state === "success" &&
                  (item.successEmphasis
                    ? "border-success/30 bg-success/10 text-success shadow-md"
                    : "border-border bg-popover/95 text-foreground shadow-md"),
                item.state === "failure" &&
                  "border-destructive/30 bg-destructive/10 text-destructive shadow-lg",
                item.state === "pending" && "border-border bg-popover/95 text-foreground shadow-md",
              )}
            >
              {item.state === "pending" ? (
                <Loader2Icon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : item.state === "success" ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 text-ui-sm font-medium">{item.message}</span>
              {item.actionLabel && item.onAction ? (
                <Button type="button" variant="ghost" size="sm" onClick={item.onAction}>
                  {item.actionLabel}
                </Button>
              ) : null}
              {item.dismissible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={item.dismissLabel ?? item.message}
                  onClick={() => dismissFeedback(item.key)}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </ProviderDetailFeedbackContext.Provider>
  );
}
