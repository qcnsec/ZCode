import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { ZCODE_GITHUB_NEW_ISSUE_URL, type IPlatformService } from "@zcode/shared";
import { useEffect } from "react";

/**
 * Fork 后内置反馈中心无后端可用，所有反馈入口统一跳转 GitHub Issues：
 * - 帮助菜单「问题上报 / 产品需求」「提交漏洞」
 * - 报错横幅 / 任务列表「提交反馈」（openSubmit）
 * 这里只负责把草稿里的标题与描述拼成 issue 的 title / body 并打开浏览器，
 * 不再渲染任何 z.ai 后端的提交表单 / 我的反馈列表 / 需求弹窗（相关代码已整体移除）。
 */
export const FeedbackCenter = function FeedbackCenterComponent({
  platform,
}: {
  platform: IPlatformService;
}) {
  const open = useFeedbackStore((state) => state.open);
  const submitDraft = useFeedbackStore((state) => state.submitDraft);
  const close = useFeedbackStore((state) => state.close);

  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams();
    if (submitDraft?.title) params.set("title", submitDraft.title);
    const bodyParts: string[] = [];
    if (submitDraft?.type) bodyParts.push(`类型：${submitDraft.type}`);
    if (submitDraft?.module) bodyParts.push(`模块：${submitDraft.module}`);
    if (submitDraft?.severity) bodyParts.push(`优先级：${submitDraft.severity}`);
    if (submitDraft?.description) bodyParts.push(submitDraft.description);
    if (bodyParts.length) params.set("body", bodyParts.join("\n\n"));
    const url = params.toString()
      ? `${ZCODE_GITHUB_NEW_ISSUE_URL}?${params.toString()}`
      : ZCODE_GITHUB_NEW_ISSUE_URL;
    void platform.openExternal(url);
    close();
  }, [open, submitDraft, platform, close]);

  return null;
};
