import type { ImageAttachmentDTO } from "../../../../../packages/contracts/src/conversation-images.js";
export type MessageDTO = {
  id: string;
  versionId: string;
  versionNo: number;
  content: string;
  role: "user" | "assistant" | "system";
  regeneratedFrom?: string;
};
export type MessageVersionHistory = {
  id: string;
  versionNo: number;
  content: string;
  attachments: ImageAttachmentDTO[];
};
export type MessageHistory = MessageDTO & {
  attachments: ImageAttachmentDTO[];
  versions: MessageVersionHistory[];
};
