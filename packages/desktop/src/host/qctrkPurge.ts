import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IZCodeAgentService } from "@zcode/services";

const nodeRequire = createRequire(import.meta.url);

/**
 * 「删除会话真删干净 + VACUUM」。
 *
 * 产物 host/index.js 的 purgeAfterDelete(Nv) 与 scheduleVacuum(uz/main 侧 i6)：
 * - 删除任务后调用 services.purgeSessionData({workspace, sessionIds:[taskId],
 *   directories:[], preserveUsage:true})，真删会话文件与数据库行并保留用量统计；
 * - 删除成功后延迟 3 秒触发 VACUUM，60 秒冷却，只有 db.sqlite ≥ 64MB 才执行；
 * - VACUUM 用独立 Node 进程（ELECTRON_RUN_AS_NODE=1 + node:sqlite）执行，
 *   PRAGMA busy_timeout=30000，结果追加到 ~/.zcode/v2/logs/qctrk-vacuum.log，
 *   避免阻塞 Host 与 CLI 的正常写入。
 *
 * 源码协议 v4SessionDataParamsSchema 是 strict、没有 preserveUsage 字段；
 * 保留用量的语义已落在 CLI 的 sessionRepository.purgeSessions（默认开启）。
 */

/** 产物 Xre/o6=3e3：删除后延迟，合并短时间内的批量删除。 */
const VACUUM_DELAY_MS = 3_000;
/** 产物 ene/s6=6e4：两次 VACUUM 之间的冷却。 */
const VACUUM_COOLDOWN_MS = 60_000;
/** 产物 n6=64*1024*1024：小库不值得 VACUUM。 */
const VACUUM_MIN_DB_BYTES = 64 * 1024 * 1024;

let vacuumTimer: ReturnType<typeof setTimeout> | null = null;
let lastVacuumAt = 0;

function userHome(): string {
  return (
    process.env.ZCODE_DATA_BASE_DIR ||
    process.env.ZCODE_DESKTOP_HOME_DIR ||
    process.env.USERPROFILE ||
    homedir() ||
    ""
  );
}

function cliDbPath(): string {
  return join(userHome(), ".zcode", "cli", "db", "db.sqlite");
}

/**
 * 桌面端任务索引库的所有候选路径。
 *
 * Host 与 Main 是两个独立进程，环境变量并不相同：Host 可能被注入
 * ZCODE_DATA_BASE_DIR，而 Main（以及 旧客户端的 listDeletedTasks）走
 * USERPROFILE / homedir。只按单一 userHome() 拼路径会清到另一个甚至不存在的库，
 * 表现为「删除后旧客户端仍能刷新出该会话」。这里对所有候选数据根逐一清理。
 */
function candidateTasksIndexPaths(): string[] {
  const homes = [
    process.env.ZCODE_DATA_BASE_DIR,
    process.env.ZCODE_DESKTOP_HOME_DIR,
    process.env.USERPROFILE,
    homedir(),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return [...new Set(homes.map((home) => join(home, ".zcode", "v2", "tasks-index.sqlite")))];
}

/**
 * 物理删除任务索引行，供 Host 删除链路与 main 的「彻底删除」共用。
 *
 * 官方 deleteTask/deleteArchivedTask(s) 只把 tasks 行标成 deleted=1，
 * 旧版「可清理的会话」正是读 `deleted=1 OR archived=1` 的残留行，
 * 只清 CLI 会话数据（cli/db/db.sqlite）不会让它消失，必须删这里的行。
 */
export function purgeTaskIndexRows(taskId: string): number {
  const id = taskId.trim();
  if (!id) return 0;
  const paths = candidateTasksIndexPaths().filter((path) => existsSync(path));
  if (paths.length === 0) return 0;
  const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
  let total = 0;
  for (const path of paths) {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=30000");
      db.exec("begin immediate");
      const result = db.prepare("delete from tasks where task_id = ?").run(id);
      db.exec("commit");
      total += Number(result.changes ?? 0);
    } catch {
      try {
        db.exec("rollback");
      } catch {
        // 回滚失败不影响主流程。
      }
    } finally {
      db.close();
    }
  }
  return total;
}

function vacuumLogPath(): string {
  return join(userHome(), ".zcode", "v2", "logs", "qctrk-vacuum.log");
}

const VACUUM_SCRIPT = `try{var s=require('node:sqlite');var d=new s.DatabaseSync(process.argv[1],{});d.exec('PRAGMA busy_timeout=30000');d.exec('VACUUM');d.close();require('node:fs').appendFileSync(process.argv[2],new Date().toISOString()+' VACUUM ok\\n')}catch(e){try{require('node:fs').appendFileSync(process.argv[2],new Date().toISOString()+' VACUUM FAIL '+String(e&&e.message||e)+'\\n')}catch(e2){}}`;

/** 供 Host 删除链路与 main 的 QcTrkPurgeTask 共用。 */
export function scheduleQcTrkVacuum(): void {
  if (vacuumTimer) clearTimeout(vacuumTimer);
  vacuumTimer = setTimeout(() => {
    vacuumTimer = null;
    if (Date.now() - lastVacuumAt < VACUUM_COOLDOWN_MS) return;
    lastVacuumAt = Date.now();
    try {
      const db = cliDbPath();
      if (!existsSync(db) || statSync(db).size < VACUUM_MIN_DB_BYTES) return;
      const log = vacuumLogPath();
      mkdirSync(dirname(log), { recursive: true });
      const child = spawn(process.execPath, ["-e", VACUUM_SCRIPT, db, log], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      child.unref();
    } catch {
      // VACUUM 失败不影响删除结果；子进程内部也会把失败写进日志。
    }
  }, VACUUM_DELAY_MS);
}

export interface QcTrkPurgeAfterDeleteParams {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface QcTrkPurgeDeps {
  /** 延迟读取 activeServices，避免模块初始化时的循环依赖与空值。 */
  getAgentService: () => IZCodeAgentService | undefined;
  log: (level: "info" | "warn", ...args: unknown[]) => void;
}

export function createQcTrkPurgeAfterDelete(deps: QcTrkPurgeDeps): {
  purgeAfterDelete: (params: QcTrkPurgeAfterDeleteParams) => Promise<void>;
} {
  async function purgeAfterDelete(params: QcTrkPurgeAfterDeleteParams): Promise<void> {
    const taskId = params.taskId.trim();
    if (!taskId) return;

    // 「删除」等价于 的「彻底删除」：先无条件物理删除任务索引行。
    // 这一步不能依赖 agent service 或 workspacePath，也不能放在 CLI 会话清理之后，
    // 否则 purgeSessionData 失败/未就绪时，旧版「可清理的会话」仍会看到 deleted=1 残留。
    const removedIndexRows = purgeTaskIndexRows(taskId);
    deps.log(
      "info",
      "[qctrk-purge] index rows removed",
      JSON.stringify({ taskId, removedIndexRows, paths: candidateTasksIndexPaths() }),
    );

    if (!params.workspacePath?.trim()) return;
    const agent = deps.getAgentService();
    if (!agent?.purgeSessionData) return;
    try {
      const result = await agent.purgeSessionData({
        workspace: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        sessionIds: [taskId],
        directories: [],
      });
      if (result.failed.length > 0) {
        deps.log("warn", "[qctrk-purge] 删除后清理失败:", JSON.stringify(result.failed), taskId);
      }
      if (result.deleted.length > 0) scheduleQcTrkVacuum();
    } catch (error) {
      deps.log(
        "warn",
        "[qctrk-purge] 删除后清理异常:",
        error instanceof Error ? error.message : String(error),
        taskId,
      );
    }
  }

  return { purgeAfterDelete };
}
