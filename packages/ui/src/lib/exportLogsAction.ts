import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { dismissToast, toast } from "@/components/ui/toast.js";
import { isExportLogsBusy, setExportLogsBusy } from "@/lib/exportLogsState.js";

export async function runExportLogsAction(
  platform: Pick<IPlatformService, "exportLogs">,
  intl: IntlInstance,
): Promise<void> {
  // 已有导出在进行（本窗口其它入口，或托盘/原生菜单广播过来的进度）时直接忽略，
  // 不重复弹提示、也不重复发起 IPC。main 侧另有 in-flight 锁做最终兜底。
  if (isExportLogsBusy()) return;
  setExportLogsBusy(true);

  const pendingToastId = toast(intl.formatMessage({ id: "sidebar.exportLogs.pending" }), {
    durationMs: Number.POSITIVE_INFINITY,
  });

  try {
    const result = await platform.exportLogs();
    if (!result.success) {
      toast(
        intl.formatMessage(
          { id: "sidebar.exportLogs.error" },
          { error: result.error ?? "unknown" },
        ),
      );
    }
  } catch (error) {
    toast(
      intl.formatMessage(
        { id: "sidebar.exportLogs.error" },
        { error: error instanceof Error ? error.message : String(error) },
      ),
    );
  } finally {
    dismissToast(pendingToastId);
    setExportLogsBusy(false);
  }
}
