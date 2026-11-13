import { ZCODE_GITHUB_WIKI_URL } from "@zcode/shared";

/**
 * 产品文档入口统一收口，避免不同菜单跳到不一致的文档站。
 * Fork 发布后文档托管在 GitHub Wiki（仓库已启用 Wiki），不再依赖 z.ai 文档站。
 */
export const ZCODE_PRODUCT_DOCS_URL = ZCODE_GITHUB_WIKI_URL;
