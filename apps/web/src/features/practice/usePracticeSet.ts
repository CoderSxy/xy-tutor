import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  PracticeMode,
  PracticeSetDTO,
  SubmissionDTO,
} from "../../../../../packages/contracts/src/practice-sets.js";
import type { AnswerPayload } from "../../../../../packages/contracts/src/question-presentation.js";
import { ApiError, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  changePracticeMode,
  continuePracticeSet,
  createPracticeSet,
  fetchPracticeSet,
  fetchPreferences,
  retryPracticeGeneration,
  submitPracticeAnswers,
} from "./api";

export function usePracticeSet(taskId?: string) {
  const a = useAuth();
  const navigate = useNavigate();
  const [set, setSet] = useState<PracticeSetDTO>();
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [submissionId, setSubmissionId] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!taskId);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const dto = await fetchPracticeSet(
        a.scoped(`/api/tasks/${taskId}/practice-set`),
      );
      setSet(dto);
      setSelectedItemId((current) => {
        if (current && dto.items.some((item) => item.itemId === current))
          return current;
        const pending = dto.items.find(
          (item) => item.itemId && item.progress.submission === "unanswered",
        );
        return (
          pending?.itemId ??
          dto.items.find((item) => item.itemId)?.itemId ??
          undefined
        );
      });
      setError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (!a.capabilities) return;
        if (a.capabilities.practiceSets === "enabled") {
          try {
            const prefs = await fetchPreferences(
              a.scoped("/api/practice-preferences"),
            );
            const created = await createPracticeSet(
              a.scoped(`/api/tasks/${taskId}/practice-set`),
              {
                requestKey: `create:${taskId}`,
                mode: prefs.mode ?? (window.innerWidth < 768 ? "step" : "batch"),
                strategy: prefs.strategy,
              },
            );
            setSet(created);
            setSelectedItemId(
              created.items.find((item) => item.itemId)?.itemId ?? undefined,
            );
            setError("");
          } catch (createError) {
            setSet(undefined);
            setError(errorMessage(createError));
          }
        } else {
          setSet(undefined);
          setError("");
        }
      } else setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [taskId, a.studentId, a.capabilities]);

  useEffect(() => {
    setSet(undefined);
    setSelectedItemId(undefined);
    setLoading(!!taskId);
    if (taskId) void load();
  }, [taskId, load]);

  useEffect(() => {
    if (set?.generation !== "preparing") return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [set?.generation, load]);

  const selectItem = (itemId: string) => setSelectedItemId(itemId);

  const changeMode = async (mode: PracticeMode) => {
    if (!set) return;
    const updated = await changePracticeMode(
      a.scoped(`/api/practice-sets/${set.id}`),
      { expectedVersion: set.version, mode },
    );
    setSet(updated);
  };

  const submit = async (input: {
    entries: { itemId: string; answer: AnswerPayload }[];
    skippedItemIds: string[];
    finalize: boolean;
  }): Promise<SubmissionDTO | undefined> => {
    if (!set) return;
    const result = await submitPracticeAnswers(
      a.scoped(`/api/practice-sets/${set.id}/submit`),
      {
        requestKey: crypto.randomUUID(),
        expectedVersion: set.version,
        ...input,
      },
    );
    setSubmissionId(result.id);
    await load();
    return result;
  };

  const retry = async (itemIds: string[]) => {
    if (!submissionId) return;
    const { api, jsonBody } = await import("../../lib/api");
    await api(a.scoped(`/api/practice-submissions/${submissionId}/retry`), {
      method: "POST",
      ...jsonBody({ requestKey: crypto.randomUUID(), itemIds }),
    });
    await load();
  };

  const retryGeneration = async () => {
    if (!set) return;
    const updated = await retryPracticeGeneration(
      a.scoped(`/api/practice-sets/${set.id}/retry-generation`),
      { requestKey: crypto.randomUUID(), expectedVersion: set.version },
    );
    setSet(updated);
  };

  const continueSet = async () => {
    if (!set) return;
    const next = await continuePracticeSet(
      a.scoped(`/api/practice-sets/${set.id}/continue`),
      { requestKey: crypto.randomUUID(), expectedVersion: set.version },
    );
    navigate(`/study/${next.taskId}`);
  };

  return {
    set,
    selectedItemId,
    selectItem,
    changeMode,
    submit,
    retry,
    retryGeneration,
    continueSet,
    reload: load,
    error,
    loading,
  };
}
