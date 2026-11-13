/**
 * 公开仓库与反馈入口统一收口到 GitHub Fork（https://github.com/qcnsec/ZCode）。
 *
 * 原版 z.ai 的社群/反馈/漏洞上报均依赖远端帮助配置（Feishu / Discord / 自建 zsrc 服务），
 * 检查更新依赖 z.ai 的 releases manifest API。Fork 后这些服务端不再适用，
 * 全部改用 GitHub 原生能力，无需自建服务端，也无需下线功能。
 */

/** GitHub 仓库所有者（Fork 目标：https://github.com/qcnsec/ZCode）。 */
export const ZCODE_GITHUB_OWNER = "qcnsec";

/** GitHub 仓库名。 */
export const ZCODE_GITHUB_REPO = "ZCode";

/** 仓库主页。 */
export const ZCODE_GITHUB_REPO_URL = `https://github.com/${ZCODE_GITHUB_OWNER}/${ZCODE_GITHUB_REPO}`;

/** Issues 列表页。 */
export const ZCODE_GITHUB_ISSUES_URL = `${ZCODE_GITHUB_REPO_URL}/issues`;

/** 新建 Issue 页：用于「问题上报」。 */
export const ZCODE_GITHUB_NEW_ISSUE_URL = `${ZCODE_GITHUB_REPO_URL}/issues/new`;

/** 新建 Issue 页（enhancement 标签）：用于「给产品提需求」。 */
export const ZCODE_GITHUB_NEW_FEATURE_URL = `${ZCODE_GITHUB_REPO_URL}/issues/new?labels=enhancement`;

/** Discussions：作为「用户社群」入口（需在仓库设置中启用 Discussions）。 */
export const ZCODE_GITHUB_DISCUSSIONS_URL = `${ZCODE_GITHUB_REPO_URL}/discussions`;

/** Wiki：作为「产品文档」入口（需在仓库设置中启用 Wiki）。 */
export const ZCODE_GITHUB_WIKI_URL = `${ZCODE_GITHUB_REPO_URL}/wiki`;

/** Releases：用于「检查更新」的兜底跳转与发布说明。 */
export const ZCODE_GITHUB_RELEASES_URL = `${ZCODE_GITHUB_REPO_URL}/releases`;

/**
 * 公开仓库的 latest release API：无需 token 即可查询最新版本。
 * 客户端只做版本比对 + 跳转下载页，不使用 electron-updater 自动下载安装，
 * 因此不需要 latest.yml、不需要代码签名、也不需要在 Release 上传更新元数据。
 */
export const ZCODE_GITHUB_RELEASES_LATEST_API = `https://api.github.com/repos/${ZCODE_GITHUB_OWNER}/${ZCODE_GITHUB_REPO}/releases/latest`;

/** 漏洞提交地址（用户指定，独立于 GitHub）。 */
export const ZCODE_VULNERABILITY_REPORT_URL = "https://zcode.uapi.xin/zsrc";
