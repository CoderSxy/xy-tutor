export type MessageDTO = {
  id: string;
  versionId: string;
  versionNo: number;
  content: string;
  role: "user" | "assistant" | "system";
  regeneratedFrom?: string;
};
export type MessageHistory = MessageDTO & {
  versions: { id: string; versionNo: number; content: string }[];
};
