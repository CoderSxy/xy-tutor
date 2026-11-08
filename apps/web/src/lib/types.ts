export type { RevisionDTO } from "../../../server/src/modules/catalog/contracts";
export type {
  TaskDTO,
  TaskKind,
} from "../../../server/src/modules/learning/contracts";
export type { MessageHistory } from "../../../server/src/modules/conversations/contracts";
export type { MistakeDTO } from "../../../server/src/modules/learning/mistakes";
export type { SummaryContent } from "../../../server/src/modules/learning/summaries";
export type StudentProfile = {
  id: string;
  displayName: string;
  timezone: string;
  preferences: Record<string, string>;
};
export type StudentEntry = {
  id: string;
  displayName: string;
  permission: string;
};
export type Session = {
  actor: { userId: string; role: "admin" | "student" };
  studentId?: string;
};
export type Capabilities = {
  llmConfigured: boolean;
  uploadsConfigured: boolean;
  ocrConfigured: boolean;
};
export type TaskItem = {
  id: string;
  questionVersionId: string;
  position: number;
  role: string;
  status: string;
  stem: string;
  knowledgePoint?: string | null;
};
export const kindLabels: Record<string, string> = {
  daily_practice: "每日5练",
  knowledge_consolidation: "知识点巩固",
  mistake_review: "错题回顾",
  material_tutoring: "资料辅导",
  free_question: "自由提问",
};
export const stateLabels: Record<string, string> = {
  pending_correction: "待订正",
  correcting: "订正中",
  corrected_pending_practice: "已订正，待巩固",
  consolidated_pending_review: "已巩固，待复习",
  mastered: "已掌握",
};
