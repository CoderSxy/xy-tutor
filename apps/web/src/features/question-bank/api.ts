import type {
  AdminQuestionInput,
  QuestionBankEntrySummaryDTO,
  QuestionTemplateDTO,
  SkillDTO,
} from "../../../../../packages/contracts/src/question-bank.js";
import { api, jsonBody } from "../../lib/api";
import { useRemote } from "../../lib/useRemote";

export type EntryList = {
  items: QuestionBankEntrySummaryDTO[];
  total: number;
};

export function useSkills() {
  return useRemote<SkillDTO[]>("/api/admin/skills");
}

export function useQuestionEntries(status: string | undefined) {
  const query = status ? `?status=${status}` : "";
  return useRemote<EntryList>(`/api/admin/question-bank/entries${query}`);
}

export function useQuestionTemplates() {
  return useRemote<{ items: QuestionTemplateDTO[] }>(
    "/api/admin/question-bank/templates",
  );
}

export function createSkill(input: { code: string; name: string }) {
  return api<SkillDTO>("/api/admin/skills", {
    method: "POST",
    ...jsonBody(input),
  });
}

export function linkSkillContent(skillId: string, knowledgeItemId: string) {
  return api(`/api/admin/skills/${skillId}/content`, {
    method: "POST",
    ...jsonBody({ knowledgeItemId }),
  });
}

export function setPrerequisites(skillId: string, prerequisiteIds: string[]) {
  return api<SkillDTO>(`/api/admin/skills/${skillId}/prerequisites`, {
    method: "PUT",
    ...jsonBody({ prerequisiteIds }),
  });
}

export function createQuestion(input: AdminQuestionInput) {
  return api<QuestionBankEntrySummaryDTO>("/api/admin/question-bank/questions", {
    method: "POST",
    ...jsonBody(input),
  });
}

export function publishEntry(entryId: string, version: number) {
  return api(`/api/admin/question-bank/entries/${entryId}/publish`, {
    method: "POST",
    ...jsonBody({ version }),
  });
}

export function withdrawEntry(entryId: string, reason: string) {
  return api(`/api/question-bank/entries/${entryId}/withdraw`, {
    method: "POST",
    ...jsonBody({ reason }),
  });
}

export function reviewTemplate(
  templateId: string,
  decision: "approved" | "rejected",
) {
  return api<QuestionTemplateDTO>(
    `/api/admin/question-bank/templates/${templateId}/review`,
    { method: "POST", ...jsonBody({ decision }) },
  );
}
