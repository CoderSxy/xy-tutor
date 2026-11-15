import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerPayload } from "../../../../../packages/contracts/src/question-presentation.js";
import { ApiError, errorMessage } from "../../lib/api";
import {
  clearLocalDraftItem,
  containsSignedUrl,
  readLocalDrafts,
  writeLocalDraft,
} from "./draft-cache";
import { listPracticeDrafts, savePracticeDraft } from "./api";

export function useAnswerDrafts({
  studentId,
  setId,
  scoped,
}: {
  studentId?: string;
  setId?: string;
  scoped: (path: string) => string;
}) {
  const [drafts, setDrafts] = useState<Record<string, AnswerPayload>>({});
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [conflict, setConflict] = useState("");
  const timers = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    if (!studentId || !setId) return;
    const local = readLocalDrafts(sessionStorage, studentId, setId);
    const next: Record<string, AnswerPayload> = {};
    for (const [itemId, draft] of Object.entries(local)) {
      if (!containsSignedUrl(draft.answer)) next[itemId] = draft.answer;
    }
    try {
      const remote = await listPracticeDrafts(
        scoped(`/api/practice-sets/${setId}/drafts`),
      );
      for (const draft of remote) {
        next[draft.itemId] = draft.answer;
        setVersions((current) => ({ ...current, [draft.itemId]: draft.version }));
      }
    } catch {
      /* local drafts still apply */
    }
    setDrafts(next);
  }, [studentId, setId, scoped]);

  useEffect(() => {
    void load();
    return () => {
      for (const timer of Object.values(timers.current)) window.clearTimeout(timer);
    };
  }, [load]);

  const flush = useCallback(
    async (itemId: string, answer: AnswerPayload) => {
      if (!studentId || !setId) return;
      try {
        const saved = await savePracticeDraft(
          scoped(`/api/practice-sets/${setId}/drafts/${itemId}`),
          { expectedVersion: versions[itemId] ?? 1, answer },
        );
        setVersions((current) => ({ ...current, [itemId]: saved.version }));
        setConflict("");
      } catch (error) {
        if (error instanceof ApiError && error.status === 409)
          setConflict("草稿已在其他标签页更新，已为你保留服务器上的最新内容。");
        else setConflict(errorMessage(error));
        await load();
      }
    },
    [studentId, setId, scoped, versions, load],
  );

  const update = useCallback(
    (itemId: string, answer: AnswerPayload) => {
      if (!studentId || !setId || containsSignedUrl(answer)) return;
      setDrafts((current) => ({ ...current, [itemId]: answer }));
      writeLocalDraft(sessionStorage, studentId, setId, itemId, answer);
      window.clearTimeout(timers.current[itemId]);
      timers.current[itemId] = window.setTimeout(() => {
        void flush(itemId, answer);
      }, 800);
    },
    [studentId, setId, flush],
  );

  const drop = useCallback(
    (itemId: string) => {
      if (!studentId || !setId) return;
      setDrafts((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      clearLocalDraftItem(sessionStorage, studentId, setId, itemId);
    },
    [studentId, setId],
  );

  return { drafts, update, flush, drop, conflict, reload: load };
}
