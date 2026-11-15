import type { AnswerPayload } from "../../../../../packages/contracts/src/question-presentation.js";

const PREFIX = "xy.practice.draft.";

export type CachedDraft = {
  itemId: string;
  answer: AnswerPayload;
  updatedAt: string;
};

function key(studentId: string, setId: string) {
  return `${PREFIX}${studentId}.${setId}`;
}

export function readLocalDrafts(
  store: Storage,
  studentId: string,
  setId: string,
): Record<string, CachedDraft> {
  const raw = store.getItem(key(studentId, setId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, CachedDraft>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLocalDraft(
  store: Storage,
  studentId: string,
  setId: string,
  itemId: string,
  answer: AnswerPayload,
): CachedDraft {
  const current = readLocalDrafts(store, studentId, setId);
  const next: CachedDraft = {
    itemId,
    answer,
    updatedAt: new Date().toISOString(),
  };
  current[itemId] = next;
  store.setItem(key(studentId, setId), JSON.stringify(current));
  return next;
}

export function clearLocalDraftItem(
  store: Storage,
  studentId: string,
  setId: string,
  itemId: string,
) {
  const current = readLocalDrafts(store, studentId, setId);
  delete current[itemId];
  store.setItem(key(studentId, setId), JSON.stringify(current));
}

export function clearStudentDrafts(store: Storage, studentId: string) {
  const prefix = `${PREFIX}${studentId}.`;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const item = store.key(i);
    if (item?.startsWith(prefix) || item?.startsWith(PREFIX)) keys.push(item);
  }
  for (const item of keys) {
    if (item.startsWith(prefix)) store.removeItem(item);
  }
}

export function containsSignedUrl(value: unknown): boolean {
  return JSON.stringify(value).includes("X-Amz-") || JSON.stringify(value).includes("Signature=");
}
