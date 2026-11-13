import { create } from "zustand";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";

export interface FeedbackAttachmentDraft {
  readonly filename: string;
  readonly contentType: string;
  readonly dataBase64: string;
  readonly size: number;
}

export interface FeedbackSubmitDraft {
  readonly title?: string;
  readonly description?: string;
  readonly contact?: string;
  readonly type?: FeedbackTicketType;
  readonly module?: FeedbackTicketModule;
  readonly severity?: FeedbackTicketSeverity;
  readonly screenshots?: readonly FeedbackAttachmentDraft[];
  readonly includeLogs?: boolean;
}

interface FeedbackUiState {
  open: boolean;
  submitDraft: FeedbackSubmitDraft | null;
  /** 打开提交反馈（GitHub issue 预填草稿）；Fork 后无后端，仅用于携带草稿上下文 */
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
  close: () => void;
}

export const useFeedbackStore = create<FeedbackUiState>((set) => ({
  open: false,
  submitDraft: null,
  openSubmit: (draft) =>
    set({
      open: true,
      submitDraft: draft ?? null,
    }),
  close: () =>
    set({
      open: false,
      submitDraft: null,
    }),
}));
