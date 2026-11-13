import type { UpdateStatePayload } from "@zcode/shared";

/**
 * Fork 只有一个公开仓库、一条 GitHub Releases 线，preview/stable 双渠道假设不成立，
 * 帮助菜单/原生菜单/托盘的「检查更新」入口对所有桌面构建统一展示。
 * 真正发请求仍由主进程的 app.isPackaged 与总开关控制（开发态不会误连更新服务）。
 */
export function shouldShowDesktopUpdateEntry(): boolean {
  return true;
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
