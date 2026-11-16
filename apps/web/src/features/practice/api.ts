import { api, jsonBody } from "../../lib/api";
import type {
  DraftDTO,
  PracticeMode,
  PracticeSetDTO,
  PreferencesDTO,
  SubmissionDTO,
  SubmitPracticeInput,
  ContinueResult,
} from "../../../../../packages/contracts/src/practice-sets.js";
import type { AnswerPayload } from "../../../../../packages/contracts/src/question-presentation.js";

export function fetchPracticeSet(path: string) {
  return api<PracticeSetDTO>(path);
}

export function createPracticeSet(
  path: string,
  input: { requestKey: string; mode: PracticeMode; strategy?: "mixed" | "exam" },
) {
  return api<PracticeSetDTO>(path, { method: "POST", ...jsonBody(input) });
}

export function changePracticeMode(
  path: string,
  input: { expectedVersion: number; mode: PracticeMode },
) {
  return api<PracticeSetDTO>(path, { method: "PATCH", ...jsonBody(input) });
}

export function submitPracticeAnswers(path: string, input: SubmitPracticeInput) {
  return api<SubmissionDTO>(path, { method: "POST", ...jsonBody(input) });
}

export function savePracticeDraft(
  path: string,
  input: { expectedVersion: number; answer: AnswerPayload },
) {
  return api<DraftDTO>(path, { method: "PUT", ...jsonBody(input) });
}

export function listPracticeDrafts(path: string) {
  return api<DraftDTO[]>(path);
}

export function continuePracticeSet(
  path: string,
  input: { requestKey: string; expectedVersion: number },
) {
  return api<ContinueResult>(path, { method: "POST", ...jsonBody(input) });
}

export function retryPracticeGeneration(
  path: string,
  input: { requestKey: string; expectedVersion: number; skillIds?: string[] },
) {
  return api<PracticeSetDTO>(path, { method: "POST", ...jsonBody(input) });
}

export function fetchPreferences(path: string) {
  return api<PreferencesDTO>(path);
}

export function patchPreferences(
  path: string,
  input: { expectedVersion?: number; mode: PracticeMode | null },
) {
  return api<PreferencesDTO>(path, { method: "PATCH", ...jsonBody(input) });
}
