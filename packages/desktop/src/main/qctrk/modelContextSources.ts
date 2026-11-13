import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  qctrkModelContextKey,
  type QcTrkModelContextSourceInput,
  type QcTrkModelContextSources,
  type QcTrkModelContextSourcesResult,
} from "@zcode/shared";

/**
 * main/index.js：
 * `~/.zcode/v2/qctrk-model-context.json` 保存每个模型的上下文窗口大小来源。
 *
 * 产物结构：{ version: 1, sources: { "<providerId>::<modelId>": { source, contextWindow?, updatedAt } } }
 * 写入用 `${path}.${pid}.tmp` + rename 原子替换，避免进程退出时留下半截 JSON。
 */

const QCTRK_MODEL_CONTEXT_FILE = "qctrk-model-context.json";

function configPath(): string {
  const home = process.env.ZCODE_DESKTOP_HOME_DIR || process.env.USERPROFILE || homedir();
  return join(home, ".zcode", "v2", QCTRK_MODEL_CONTEXT_FILE);
}

const VALID_SOURCES = new Set(["upstream", "inferred", "manual"]);

function readAll(): QcTrkModelContextSources {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const rawSources = (parsed as Record<string, unknown>).sources;
    if (!rawSources || typeof rawSources !== "object" || Array.isArray(rawSources)) return {};
    const result: QcTrkModelContextSources = {};
    for (const [key, value] of Object.entries(rawSources as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (!VALID_SOURCES.has(String(item.source))) continue;
      const entry: QcTrkModelContextSources[string] = {
        source: item.source as QcTrkModelContextSources[string]["source"],
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
      };
      if (typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow)) {
        entry.contextWindow = Math.round(item.contextWindow);
      }
      result[key] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(sources: QcTrkModelContextSources): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, sources }, null, 2), "utf8");
  renameSync(tmp, path);
}

export function readQcTrkModelContextSources(): QcTrkModelContextSources {
  return readAll();
}

/** 合并写入；空数组时不落盘，直接返回当前快照。 */
export function recordQcTrkModelContextSources(
  entries: QcTrkModelContextSourceInput[],
): QcTrkModelContextSources {
  const valid = entries.filter(
    (entry) =>
      typeof entry.providerId === "string" &&
      entry.providerId.trim().length > 0 &&
      typeof entry.modelId === "string" &&
      entry.modelId.trim().length > 0 &&
      VALID_SOURCES.has(entry.source),
  );
  if (valid.length === 0) return readAll();
  const sources = readAll();
  const now = Date.now();
  for (const entry of valid) {
    const key = qctrkModelContextKey(entry.providerId.trim(), entry.modelId.trim());
    const record: QcTrkModelContextSources[string] = { source: entry.source, updatedAt: now };
    if (
      typeof entry.contextWindow === "number" &&
      Number.isFinite(entry.contextWindow) &&
      entry.contextWindow > 0
    ) {
      record.contextWindow = Math.round(entry.contextWindow);
    }
    sources[key] = record;
  }
  try {
    writeAll(sources);
  } catch {
    // 落盘失败不阻断本次扫描；内存快照仍可返回给 renderer。
  }
  return sources;
}

export function qctrkModelContextSourcesResult(
  sources: QcTrkModelContextSources,
): QcTrkModelContextSourcesResult {
  return { ok: true, sources };
}
