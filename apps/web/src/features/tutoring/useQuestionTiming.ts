import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { createTimingApi } from "./api";
import {
  createTimingClient,
  type TimingSnapshot,
  type TimingSubmission,
} from "./timing-client";

const storageKey = (taskId: string, questionVersionId: string) =>
  `xy.timing.${taskId}.${questionVersionId}`;

export function useQuestionTiming(input: {
  taskId?: string;
  questionVersionId?: string;
  enabled: boolean;
  waiting: boolean;
}) {
  const a = useAuth();
  // studentId 变化时 scoped 会变；用 ref 保证客户端拿到的是最新的那个。
  const scoped = useRef(a.scoped);
  scoped.current = a.scoped;
  const api = useMemo(
    () => createTimingApi((path) => scoped.current(path)),
    [],
  );
  const timeline = useMemo(() => createTimingClient({ api }), [api]);
  const [snapshot, setSnapshot] = useState<TimingSnapshot>(() =>
    timeline.snapshot(),
  );
  const key =
    input.taskId && input.questionVersionId
      ? storageKey(input.taskId, input.questionVersionId)
      : null;
  const startedKey = useRef<string | null>(null);

  useEffect(() => timeline.subscribe(setSnapshot), [timeline]);
  useEffect(() => () => timeline.dispose(), [timeline]);

  // 换题时把上一题的计时收尾，学生回来后自己决定继续还是重记。
  useEffect(() => {
    if (!key || startedKey.current === key) return;
    if (timeline.snapshot().status === "running") void timeline.pause("user");
  }, [key, timeline]);

  // 恢复上次会话只读回数据，不自动开始计时。
  useEffect(() => {
    if (!input.enabled || !key) return;
    const stored = sessionStorage.getItem(key);
    if (!stored) return;
    let alive = true;
    void api
      .get(stored)
      .then((episode) => {
        if (!alive) return;
        if (episode.state === "finished") sessionStorage.removeItem(key);
        else timeline.restore(episode);
      })
      .catch(() => {
        if (alive) sessionStorage.removeItem(key);
      });
    return () => {
      alive = false;
    };
  }, [api, timeline, input.enabled, key]);

  useEffect(() => {
    if (!input.enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void timeline.pause("hidden");
    };
    const onOffline = () => void timeline.pause("offline");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
    };
  }, [timeline, input.enabled]);

  // 等讲解的时间不算学生自己的作答时间，但只暂停、不替学生恢复。
  useEffect(() => {
    if (!input.enabled || !input.waiting) return;
    void timeline.pause("waiting_ai");
  }, [timeline, input.enabled, input.waiting]);

  const start = async (takeOver?: boolean) => {
    if (!input.taskId || !input.questionVersionId) return false;
    const ok = await timeline.start({
      taskId: input.taskId,
      questionVersionId: input.questionVersionId,
      ...(takeOver ? { takeOver: true } : {}),
    });
    const episodeId = timeline.snapshot().episodeId;
    if (ok && key && episodeId) {
      startedKey.current = key;
      sessionStorage.setItem(key, episodeId);
    }
    return ok;
  };

  const prepareSubmission = async (): Promise<TimingSubmission> => {
    const submission = await timeline.prepareSubmission();
    if (submission.episodeId && key) sessionStorage.removeItem(key);
    startedKey.current = null;
    return submission;
  };

  return {
    snapshot,
    enabled: input.enabled,
    start,
    pause: (reason?: "user") => timeline.pause(reason),
    resume: () => timeline.resume(),
    prepareSubmission,
  };
}
