/**
 * 「自建更新通道」分块下载器。
 *
 * 忠实产物 out/main/index.js 的更新模块（命名沿用产物内部函数）：
 *   - fetchManifest / parseUpdateManifest(N6)：解析文本清单 manifest.yml
 *   - pickInstallerFile(Rg)：从 files 中选 win-x64 .exe
 *   - downloadFileToFile(M_)：随机写分片 + sha512 校验 + 原子改名
 *   - downloadChunks(z6)：128 并发 + 慢分片偷取（steal）的 worker 池
 *   - planChunksFixed(T_) / planChunksAdaptive(F6) / probeNetwork(U6)
 *   - downloadChunk($6)：单分片重试；splitRange(H6)：偷取时二分
 *
 * Fork 版默认不指向任何更新服务：需显式设置 ZCODE_QCTRK_UPDATE_BASE_URL 才启用本通道，
 * 正式更新由官方 electron-updater + GitHub Releases 接管。本模块不依赖 Electron，便于独立校验。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import type { QcTrkUpdateState } from "@zcode/shared";

/** 与产物 `ht` 常量逐一对应。 */
export const QCTRK_UPDATE_CONFIG = {
  // Fork 版默认不指向任何第三方更新服务；更新统一走 GitHub Releases
  // （见 main/autoUpdater.ts 的 github provider）。显式设置该环境变量仅供调试自建通道。
  baseUrl: process.env.ZCODE_QCTRK_UPDATE_BASE_URL || "",
  checkIntervalMs: 3600 * 1000,
  startupDelayMs: 15 * 1000,
  concurrency: 128,
  minChunks: 256,
  maxChunks: 512,
  targetChunkBytes: 320 * 1024,
  minChunkBytes: 256 * 1024,
  minSplitBytes: 128 * 1024,
  maxStealsPerChunk: 6,
  stealMinAgeMs: 750,
  chunkRetries: 3,
  timeoutMs: 30 * 1000,
};

export interface QcTrkUpdateFile {
  url: string;
  sha512: string;
  size: number;
}

export interface QcTrkUpdateManifest {
  version: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  files: QcTrkUpdateFile[];
}

export interface QcTrkDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
}

export interface QcTrkDownloadOptions {
  fetchChunk?: (
    start: number,
    end: number,
    signal: AbortSignal,
  ) => Promise<Buffer>;
  skipProbe?: boolean;
  onWrite?: (
    index: number,
    start: number,
    end: number,
    buffer: Buffer,
  ) => Promise<void> | void;
}

// === 清单文本解析（N6 / R_ / I_ / Qn） ===

function splitKV(line: string): [string, string] | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

function unquote(value: string): string {
  const t = value.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function applyFileField(file: QcTrkUpdateFile, key: string, value: string): void {
  if (key === "url") file.url = unquote(value);
  else if (key === "sha512") file.sha512 = unquote(value);
  else if (key === "size") {
    const n = Number(unquote(value));
    file.size = Number.isFinite(n) ? n : 0;
  }
}

export function parseUpdateManifest(text: string): QcTrkUpdateManifest {
  const manifest: QcTrkUpdateManifest = { version: "", files: [] };
  let currentFile: QcTrkUpdateFile | null = null;
  let inFiles = false;
  let filesIndent = 0;
  let blockKey: string | null = null;
  let blockIndent = 0;
  let blockLines: string[] | null = null;
  const flushBlock = () => {
    if (blockKey !== null && blockLines) {
      const joined = blockLines.join("\n").replace(/\n+$/, "");
      if (blockKey === "releaseNotes") manifest.releaseNotes = joined;
      else if (blockKey === "releaseName") manifest.releaseName = joined;
    }
    blockKey = null;
    blockLines = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    // 缩进块（releaseNotes / releaseName 的 `|` 文本块）优先处理
    if (blockKey !== null) {
      if (trimmed === "" || indent >= blockIndent) {
        blockLines?.push(line.slice(Math.min(indent, blockIndent)));
        continue;
      }
      flushBlock();
    }
    // 回到顶层：关闭 files 区块
    if (inFiles && indent <= filesIndent) {
      inFiles = false;
      currentFile = null;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ")) {
      const kv = splitKV(trimmed.slice(2).trim());
      if (inFiles && kv) {
        currentFile = { url: "", sha512: "", size: 0 };
        applyFileField(currentFile, kv[0], kv[1]);
        manifest.files.push(currentFile);
      }
      continue;
    }
    const kv = splitKV(trimmed);
    if (!kv) continue;
    const [key, value] = kv;
    if (inFiles && currentFile) {
      applyFileField(currentFile, key, value);
      continue;
    }
    if (value === "|" || value === "|-" || value === ">") {
      blockKey = key;
      blockIndent = indent + 2;
      blockLines = [];
      continue;
    }
    if (key === "files") {
      inFiles = true;
      filesIndent = indent;
      currentFile = null;
      continue;
    }
    if (key === "version") manifest.version = unquote(value);
    else if (key === "releaseName") manifest.releaseName = unquote(value);
    else if (key === "releaseDate") manifest.releaseDate = unquote(value);
    else if (key === "releaseNotes") manifest.releaseNotes = unquote(value);
  }
  flushBlock();
  return manifest;
}

// === 版本比较（E_ / A_） ===

function parseVer(value: unknown): number[] | null {
  const t = /^v?(\d+(?:\.\d+)*)/.exec(String(value ?? "").trim());
  if (!t || !t[1]) return null;
  return t[1].split(".").map((r) => Number(r));
}

export function isNewer(candidate: string, current: string): boolean {
  const r = parseVer(candidate);
  const n = parseVer(current);
  if (!r || !n) return false;
  const len = Math.max(r.length, n.length);
  for (let i = 0; i < len; i++) {
    const a = r[i] ?? 0;
    const b = n[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

// === HTTP 工具（td / x_） ===

async function httpGetBuffer(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(QCTRK_UPDATE_CONFIG.timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const res = await fetch(url, {
    headers,
    signal: combined,
    redirect: "follow",
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }
}

// === 分块规划（T_ / U6 / F6） ===

export function planChunksFixed(
  fileSize: number,
  targetChunkBytes: number,
): Array<{ start: number; end: number }> {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return [{ start: 0, end: 0 }];
  let r = Math.ceil(fileSize / Math.max(1, targetChunkBytes));
  const n = Math.max(1, Math.floor(fileSize / QCTRK_UPDATE_CONFIG.minChunkBytes));
  r = Math.max(1, Math.min(r, n));
  if (fileSize >= QCTRK_UPDATE_CONFIG.minChunkBytes * QCTRK_UPDATE_CONFIG.minChunks) {
    r = Math.max(QCTRK_UPDATE_CONFIG.minChunks, r);
  }
  r = Math.max(1, Math.min(QCTRK_UPDATE_CONFIG.maxChunks, r));
  const chunkSize = Math.floor(fileSize / r);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let a = 0; a < r; a++) {
    const c = a * chunkSize;
    const l = a === r - 1 ? fileSize - 1 : c + chunkSize - 1;
    if (l >= c) ranges.push({ start: c, end: l });
  }
  return ranges.length > 0
    ? ranges
    : [{ start: 0, end: Math.max(0, fileSize - 1) }];
}

async function probeNetwork(
  url: string,
  fileSize: number,
  signal?: AbortSignal,
): Promise<{ rttMs: number; speedBps: number } | null> {
  try {
    throwIfAborted(signal);
    const n = Math.min(
      1024 * 1024,
      Math.max(64 * 1024, Math.floor(fileSize / 8)),
    );
    const rtts = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const m = Date.now();
        try {
          await httpGetBuffer(
            url,
            { Range: "bytes=0-0", "Cache-Control": "no-cache" },
            signal,
          );
          return Date.now() - m;
        } catch {
          throwIfAborted(signal);
          return Number.POSITIVE_INFINITY;
        }
      }),
    );
    const i = Math.min(...rtts);
    if (!Number.isFinite(i)) return null;
    const a = Date.now();
    const c = await httpGetBuffer(
      url,
      { Range: `bytes=0-${n - 1}`, "Cache-Control": "no-cache" },
      signal,
    );
    const l = Date.now() - a;
    const d = Math.max(1, l - i);
    const u = c.length / (d / 1000);
    if (!Number.isFinite(u) || u <= 0) return null;
    return { rttMs: i, speedBps: u };
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

export function planChunksAdaptive(
  fileSize: number,
  probe: { rttMs: number; speedBps: number } | null,
): Array<{ start: number; end: number }> {
  if (!probe || !probe.speedBps || !probe.rttMs) {
    return planChunksFixed(fileSize, QCTRK_UPDATE_CONFIG.targetChunkBytes);
  }
  const r = 4 * (probe.rttMs / 1000) * probe.speedBps;
  const n = Math.max(
    QCTRK_UPDATE_CONFIG.minChunkBytes,
    Math.min(8 * 1024 * 1024, r),
  );
  return planChunksFixed(fileSize, n);
}

// === 单分片下载（$=downloadChunk / H6=splitRange） ===

async function downloadChunk(
  url: string,
  start: number,
  end: number,
  retries: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const len = end - start + 1;
  let last: Error | null = null;
  for (let c = 0; c <= retries; c++) {
    throwIfAborted(signal);
    try {
      const buf = await httpGetBuffer(
        url,
        { Range: `bytes=${start}-${end}`, "Cache-Control": "no-cache" },
        signal,
      );
      if (buf.length === len) return buf;
      last = new Error(`分块长度不符 ${buf.length} != ${len}`);
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      throwIfAborted(signal);
      await abortableDelay(200 * (c + 1), signal);
    }
  }
  throw last ?? new Error("下载失败");
}

function splitRange(range: { start: number; end: number }): {
  head: { start: number; end: number };
  tail: { start: number; end: number };
} {
  const len = range.end - range.start + 1;
  const mid = range.start + Math.floor(len / 2);
  return {
    head: { start: range.start, end: mid - 1 },
    tail: { start: mid, end: range.end },
  };
}

// === 并发 + 偷取的 worker 池（z6=downloadChunks） ===

interface ChunkTask {
  start: number;
  end: number;
  steals: number;
  controller: AbortController | null;
  stealAbort: boolean;
  startedAt: number;
}

export async function downloadChunks(
  url: string,
  fileSize: number,
  signal: AbortSignal | undefined,
  onProgress: ((progress: QcTrkDownloadProgress) => void) | undefined,
  options: QcTrkDownloadOptions = {},
): Promise<
  Array<{ task: ChunkTask; buf: Buffer | undefined; done: boolean }>
> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new Error("下载 size 无效");
  }
  throwIfAborted(signal);
  if (fileSize === 0) return [];

  const fetchChunk =
    options.fetchChunk ??
    ((s: number, e: number, sig: AbortSignal) =>
      downloadChunk(url, s, e, QCTRK_UPDATE_CONFIG.chunkRetries, sig));

  const probe = options.skipProbe ? null : await probeNetwork(url, fileSize, signal);
  throwIfAborted(signal);

  // 显式标注，避免 controller: null 被窄化成 null 后无法容纳 AbortController / push 新分片。
  const plan: ChunkTask[] = planChunksAdaptive(fileSize, probe).map((w) => ({
    start: w.start,
    end: w.end,
    steals: 0,
    controller: null,
    stealAbort: false,
    startedAt: 0,
  }));
  const buffers: Array<Buffer | undefined> = Array.from({ length: plan.length });
  const dones: boolean[] = Array.from({ length: plan.length }, () => false);
  let received = 0;
  let nextIndex = 0;
  const totalChunks = plan.length;
  let aborted = false;
  const active = new Set<AbortController>();
  let fatal: Error | null = null;

  const emit = () =>
    onProgress?.({ receivedBytes: received, totalBytes: fileSize, done: false });

  const takePending = (): { index: number; task: ChunkTask } | null => {
    if (nextIndex >= totalChunks) return null;
    const index = nextIndex;
    nextIndex += 1;
    const task = plan[index];
    return task ? { index, task } : null;
  };

  const stealTail = (): { index: number; task: ChunkTask } | null => {
    const now = Date.now();
    let bestIndex = -1;
    let bestSize = 0;
    for (let ct = 0; ct < plan.length; ct++) {
      const ee = plan[ct];
      if (
        !ee ||
        ee.controller === null ||
        ee.steals >= QCTRK_UPDATE_CONFIG.maxStealsPerChunk
      ) {
        continue;
      }
      if (now - ee.startedAt < QCTRK_UPDATE_CONFIG.stealMinAgeMs) continue;
      const sz = ee.end - ee.start + 1;
      if (sz < QCTRK_UPDATE_CONFIG.minSplitBytes * 2) continue;
      if (sz > bestSize) {
        bestSize = sz;
        bestIndex = ct;
      }
    }
    if (bestIndex < 0) return null;
    const victim = plan[bestIndex];
    if (!victim) return null;
    const { head, tail } = splitRange({ start: victim.start, end: victim.end });
    const newTask: ChunkTask = {
      start: tail.start,
      end: tail.end,
      steals: victim.steals + 1,
      controller: null,
      stealAbort: false,
      startedAt: 0,
    };
    victim.start = head.start;
    victim.end = head.end;
    victim.steals += 1;
    victim.stealAbort = true;
    victim.controller?.abort();
    plan.push(newTask);
    buffers.push(undefined);
    dones.push(false);
    return { index: plan.length - 1, task: newTask };
  };

  const run = async (task: ChunkTask, index: number): Promise<void> => {
    for (;;) {
      throwIfAborted(signal);
      if (aborted) throw new Error("aborted");
      const controller = new AbortController();
      task.controller = controller;
      task.startedAt = Date.now();
      active.add(controller);
      const s = task.start;
      const e = task.end;
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      try {
        const buf = await fetchChunk(s, e, combined);
        if (!(task.start !== s || task.end !== e)) {
          task.controller === null && active.delete(controller);
          if (buf.length !== e - s + 1) {
            throw new Error(`分块缺失或长度不符：${s}-${e}`);
          }
          throwIfAborted(signal);
          await options.onWrite?.(index, s, e, buf);
          throwIfAborted(signal);
          buffers[index] = undefined;
          dones[index] = true;
          received += buf.length;
          task.stealAbort = false;
          emit();
          return;
        }
        task.stealAbort = false;
      } catch (err) {
        if (aborted || signal?.aborted) throw err;
        if (task.stealAbort) task.stealAbort = false;
        else throw err;
      } finally {
        if (task.controller === controller) task.controller = null;
        active.delete(controller);
      }
    }
  };

  const worker = async (): Promise<void> => {
    try {
      for (;;) {
        if (signal?.aborted || aborted) return;
        const work = takePending() ?? stealTail();
        if (!work) {
          if (!plan.some((t) => t.controller !== null)) return;
          await abortableDelay(50, signal);
          continue;
        }
        await run(work.task, work.index);
      }
    } catch (err) {
      if (!fatal) {
        fatal = err instanceof Error ? err : new Error(String(err));
      }
      aborted = true;
      for (const c of active) c.abort();
    }
  };

  await Promise.all(
    Array.from({ length: QCTRK_UPDATE_CONFIG.concurrency }, () => worker()),
  );
  if (fatal) throw fatal;
  throwIfAborted(signal);

  const ordered = plan
    .map((w, X) => ({ task: w, buf: buffers[X], done: dones[X] }))
    .sort((a, b) => a.task.start - b.task.start);
  let se = 0;
  for (const { task: w, done: X } of ordered) {
    if (w.start !== se) {
      throw new Error(`分块不连续：期望 ${se}，实际 ${w.start}`);
    }
    se = w.end + 1;
    if (!X) throw new Error(`分块缺失：${w.start}-${w.end}`);
  }
  if (ordered.length === 0 || se !== fileSize) {
    throw new Error(`分块未覆盖全量：${se} != ${fileSize}`);
  }
  return ordered.map(({ task: w, buf: X, done: D }) => ({ task: w, buf: X, done: D ?? false }));
}

// === 文件落地（M_ / G6 / __ / D_） ===

async function writeAllAt(
  fd: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const res = await fd.write(buffer, offset, buffer.length - offset, position + offset);
    if (res.bytesWritten <= 0) throw new Error("分块写入未完成");
    offset += res.bytesWritten;
  }
}

async function hashFileSha512(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha512");
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  throwIfAborted(signal);
  return hash.digest("base64");
}

export async function verifyFileSha512(
  path: string,
  expected: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    return (await hashFileSha512(path, signal)) === expected;
  } catch {
    return false;
  }
}

export async function downloadFileToFile(
  url: string,
  size: number,
  destPath: string,
  expectedSha512: string,
  signal: AbortSignal | undefined,
  onProgress?: (progress: QcTrkDownloadProgress) => void,
  options: QcTrkDownloadOptions = {},
): Promise<void> {
  if (!expectedSha512 || !expectedSha512.trim()) {
    throw new Error("缺少 sha512，拒绝下载");
  }
  throwIfAborted(signal);
  const tmp = `${destPath}.downloading-${process.pid}-${randomUUID()}.tmp`;
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  let done = false;
  try {
    fd = await open(tmp, "wx");
    await downloadChunks(url, size, signal, onProgress, {
      ...options,
      onWrite: async (index, start, _end, buf) => {
        await writeAllAt(fd as Awaited<ReturnType<typeof open>>, buf, start, signal);
        await options.onWrite?.(index, start, _end, buf);
      },
    });
    await fd.sync();
    await fd.close();
    fd = null;
    throwIfAborted(signal);
    if ((await hashFileSha512(tmp, signal)) !== expectedSha512) {
      throw new Error("sha512 校验失败（下载可能不完整或文件被篡改）");
    }
    throwIfAborted(signal);
    await rename(tmp, destPath);
    done = true;
    onProgress?.({ receivedBytes: size, totalBytes: size, done: true });
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* ignore */
      }
    }
    if (!done) {
      try {
        await rm(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// === 清单抓取与文件定位（V6 / O_ / L_ / Pg / Rg） ===

export function manifestUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/manifest.yml";
}

export function resolveFileUrl(url: string, baseUrl: string): string {
  const r = String(url ?? "").trim();
  if (!r) throw new Error("清单里的文件地址为空");
  if (/^https?:\/\//i.test(r)) return r;
  const n = baseUrl.replace(/\/+$/, "");
  if (r.startsWith("//")) {
    const proto = /^https?:/i.exec(n)?.[1] ?? "https";
    return `${proto}:${r}`;
  }
  return `${n}/${r.replace(/^\.?\//, "")}`;
}

export function fileNameFromUrl(url: string): string {
  const name =
    (String(url ?? "").split("?")[0]?.split("/").pop() ?? "")
      .replace(/[^\w.\-]/g, "_") || "ZCode-update.exe";
  return name;
}

export async function fetchManifest(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<QcTrkUpdateManifest> {
  const url = manifestUrl(baseUrl);
  const buf = await httpGetBuffer(
    url,
    { "Cache-Control": "no-cache", "X-Release-Channel": "1" },
    signal,
  );
  return parseUpdateManifest(buf.toString("utf8"));
}

export function pickInstallerFile(
  files: QcTrkUpdateFile[],
): QcTrkUpdateFile | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  return (
    files.find((f) => /win.*x64|\.exe$/i.test(f.url)) ?? files[0] ?? null
  );
}

// === 自动轮询控制器（忠实产物 main/index.js 的 Updater 类） ===
// 产品 Updater 的关键语义：
//   - start()：先 stop()，再 setTimeout(startupDelayMs) 启动首次检查，挂 setInterval(checkIntervalMs)
//   - stop()：清除定时器并作废在飞操作（beginOperation 的 generation 自增 + 中止 AbortController）
//   - check()：phase 为 checking / downloading 时直接返回（并发守卫），否则 beginOperation 后
//     把 signal 透传给 deps.onCheck，generation 失效则丢弃结果（避免旧检查覆盖新状态）
//   - download() / cancel()：各自拥有独立的 AbortController，cancel 同时中止检查与下载并回退到 available
// 本模块不依赖 Electron，控制器通过注入 deps（notify / onCheck / onDownload）与宿主解耦，
// 便于离线测试定时器与 generation 守卫逻辑。

export interface QcTrkUpdaterLogger {
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
}

export interface QcTrkUpdaterDeps {
  /** 状态变更回调（宿主通常借此广播给所有窗口）。 */
  notify: (state: QcTrkUpdateState) => void;
  /** 当前应用版本号，用于判断是否有新版本。 */
  getCurrentVersion: () => string;
  /**
   * 执行一次检查。signal 用于取消在飞检查（宿主应透传给 fetchManifest）。
   * 返回检查后的状态（无需自带 checking/checkedAt 等相位标记，控制器会补充）。
   */
  onCheck: (signal?: AbortSignal) => Promise<QcTrkUpdateState>;
  /** 执行下载；signal 用于取消在飞下载。 */
  onDownload: (state: QcTrkUpdateState, signal?: AbortSignal) => Promise<void>;
  logger?: QcTrkUpdaterLogger;
}

export class QcTrkUpdater {
  private readonly deps: QcTrkUpdaterDeps;
  private state: QcTrkUpdateState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private checkAbort: AbortController | null = null;
  private downloadAbort: AbortController | null = null;

  constructor(deps: QcTrkUpdaterDeps) {
    this.deps = deps;
    this.state = { status: "idle", currentVersion: deps.getCurrentVersion() };
  }

  getState(): QcTrkUpdateState {
    return this.state;
  }

  private setState(patch: Partial<QcTrkUpdateState>): QcTrkUpdateState {
    this.state = { ...this.state, ...patch };
    try {
      this.deps.notify(this.state);
    } catch {
      /* 广播失败不应影响状态机 */
    }
    return this.state;
  }

  private isCurrent(gen: number): boolean {
    return this.generation === gen;
  }

  /** 启动自动轮询：启动延迟 startupDelayMs 后首次检查，之后每 checkIntervalMs 一次。 */
  start(): void {
    this.stop();
    const timer = setTimeout(() => {
      void this.check();
      this.timer = setInterval(() => {
        void this.check();
      }, QCTRK_UPDATE_CONFIG.checkIntervalMs);
    }, QCTRK_UPDATE_CONFIG.startupDelayMs);
    this.timer = timer;
  }

  /** 停止自动轮询并作废所有在飞操作（应用退出时调用）。 */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = null;
    }
    this.invalidateOperation();
  }

  private invalidateOperation(): void {
    const ctrl = this.checkAbort;
    this.generation += 1;
    this.checkAbort = null;
    try {
      ctrl?.abort();
    } catch {
      /* ignore */
    }
  }

  /** 手动或定时触发一次检查；checking/downloading 相位下直接返回当前状态（并发守卫）。 */
  async check(): Promise<QcTrkUpdateState> {
    if (this.state.status === "checking" || this.state.status === "downloading") {
      return this.state;
    }
    const gen = ++this.generation;
    const controller = new AbortController();
    this.checkAbort = controller;
    const signal = controller.signal;
    this.setState({ ...this.state, status: "checking", error: undefined });
    try {
      const result = await this.deps.onCheck(signal);
      if (!this.isCurrent(gen)) return this.state;
      this.setState({ ...result, checkedAt: Date.now() });
      return this.state;
    } catch (error) {
      if (!this.isCurrent(gen)) return this.state;
      this.setState({
        ...this.state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      });
      return this.state;
    } finally {
      if (this.checkAbort === controller) this.checkAbort = null;
    }
  }

  /** 取消在飞的检查与下载，并把下载中的状态回退到 available 以便重试；检查中则回退到 idle（避免卡在 checking）。 */
  cancel(): void {
    const wasDownloading = this.state.status === "downloading";
    const wasChecking = this.state.status === "checking";
    this.generation += 1;
    try {
      this.checkAbort?.abort();
    } catch {
      /* ignore */
    }
    this.checkAbort = null;
    try {
      this.downloadAbort?.abort();
    } catch {
      /* ignore */
    }
    this.downloadAbort = null;
    if (wasDownloading) {
      this.setState({
        ...this.state,
        status: "available",
        progress: undefined,
        error: undefined,
      });
    } else if (wasChecking) {
      this.setState({ ...this.state, status: "idle", error: undefined });
    }
  }

  /** 开始下载；非 available 相位或缺少 remoteVersion 时直接返回。 */
  async download(): Promise<void> {
    if (this.state.status !== "available" || !this.state.remoteVersion) return;
    const gen = ++this.generation;
    const controller = new AbortController();
    this.downloadAbort = controller;
    const signal = controller.signal;
    this.setState({
      ...this.state,
      status: "downloading",
      progress: 0,
      error: undefined,
    });
    try {
      await this.deps.onDownload(this.state, signal);
      if (!this.isCurrent(gen)) return;
    } catch (error) {
      if (!this.isCurrent(gen)) return;
      this.setState({
        ...this.state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.downloadAbort === controller) this.downloadAbort = null;
    }
  }
}
