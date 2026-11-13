import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 新增配置的持久化。文件名与安装包产物中的
 * qctrk-balance.json / qctrk-autocont.json / qctrk-remote-link.json 对齐。
 * 产物读取的是 `~/.zcode/v2/`（与官方 setting.json 同目录），
 * 桌面端与 CLI 因此能共用同一份配置。
 */
export const QCTRK_CONFIG_FILES = {
  balance: "qctrk-balance.json",
  proxy: "qctrk-proxy.json",
  notify: "qctrk-notify.json",
  autocont: "qctrk-autocont.json",
  remoteLink: "qctrk-remote-link.json",
} as const;

export type QcTrkConfigKind = keyof typeof QCTRK_CONFIG_FILES;

export function getQcTrkConfigDir(): string {
  const home = process.env.ZCODE_DESKTOP_HOME_DIR || process.env.USERPROFILE || homedir();
  return join(home, ".zcode", "v2");
}

/** 读取配置；文件缺失或损坏时回退到默认值，不覆盖磁盘上的坏文件。 */
export async function readQcTrkConfig<T extends object>(kind: QcTrkConfigKind, defaults: T): Promise<T> {
  try {
    const raw = await readFile(join(getQcTrkConfigDir(), QCTRK_CONFIG_FILES[kind]), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...defaults };
    }
    return { ...defaults, ...(parsed as Partial<T>) };
  } catch {
    return { ...defaults };
  }
}

/** 写入配置；私有文件，仅当前用户可读写。 */
export async function writeQcTrkConfig<T extends object>(kind: QcTrkConfigKind, value: T): Promise<void> {
  const dir = getQcTrkConfigDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, QCTRK_CONFIG_FILES[kind]), JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}
