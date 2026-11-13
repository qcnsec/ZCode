import { useRef, useState } from "react";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { mutateProjectTask } from "@/project-sidebar/task-mutation.js";
import { archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export type ArchiveOperation = "unarchive" | "delete";
export function useArchiveManagement() {
  const directory = useProjectDirectory();
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((s) => s.removeTaskState);
  const platform = useOptionalPlatform();
  const confirm = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    succeeded: number;
    failed: number;
    skipped: number;
  } | null>(null);
  const locked = useRef(false);
  const latest = useRef(directory);
  latest.current = directory;
  const run = async (tasks: ProjectTask[], operation: ArchiveOperation) => {
    if (locked.current || !tasks.length) return;
    // 固定确认时的身份集合；搜索变化、新归档和重复点击不能扩充已经确认的批次。
    const candidates = [
      ...new Map(tasks.filter((t) => t.archived).map((t) => [archiveTaskKey(t), t])).values(),
    ];
    if (!candidates.length) return;
    locked.current = true;
    setBusy(true);
    setResult(null);
    const counts = { succeeded: 0, failed: 0, skipped: 0 };
    try {
      if (
        operation === "delete" &&
        !(await confirm({
          intent: "archive-management-delete",
          title: intl.formatMessage({ id: "archives.deleteTitle" }, { count: candidates.length }),
          description: intl.formatMessage({ id: "archives.deleteDescription" }),
          confirmLabel: intl.formatMessage({ id: "archives.delete" }),
          confirmVariant: "destructive",
        }))
      )
        return;
      for (const task of candidates) {
        if (
          !latest.current.tree.tasks.some(
            (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
          )
        ) {
          counts.skipped++;
          continue;
        }
        try {
          const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
            ...task,
            state: useRemoteWorkspaceSessionStore.getState(),
          });
          await mutateProjectTask(
            { service, controller },
            task,
            operation === "delete" ? { kind: "delete" } : { kind: "archive", archived: false },
            remoteSessionId,
          );
          if (operation === "delete") {
            removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
            // 删除即彻底删除：显式走 main 侧清理（与旧版「彻底删除」按钮同一条已验证链路）。
            // Host 的 purgeAfterDelete 与 Main 是两个进程、环境变量可能不同，这里再做一次兜底。
            void platform?.qctrk?.purgeTask(task.taskId)?.catch((error) => {
              logger.warn("[archive-management] 清理任务索引残留失败", { taskId: task.taskId, error });
            });
          }
          counts.succeeded++;
        } catch (error) {
          counts.failed++;
          logger.error("[archive-management] 任务操作失败", {
            taskId: task.taskId,
            workspaceIdentity: task.workspaceIdentity,
            operation,
            error,
          });
        }
      }
      await latest.current.refresh();
      setResult(counts);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { ...directory, busy, result, run };
}
