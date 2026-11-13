import {
  ZCODE_GITHUB_NEW_FEATURE_URL,
  ZCODE_GITHUB_NEW_ISSUE_URL,
} from "@zcode/shared";
import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

export interface HelpMenuActionHandlers {
  openIssueReport: () => void;
  openFeatureRequest: () => void;
  openProductDocs: () => void;
  exportLogs: () => void;
}

/**
 * Fork 后问题上报/产品需求不再走 z.ai 内置工单后端（该后端在公开仓库不可用），
 * 统一跳转 GitHub Issues；产品文档与日志导出保持原行为。
 */
export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: () => {
      void platform.openExternal(ZCODE_GITHUB_NEW_ISSUE_URL);
    },
    openFeatureRequest: () => {
      void platform.openExternal(ZCODE_GITHUB_NEW_FEATURE_URL);
    },
    openProductDocs: () => {
      platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
