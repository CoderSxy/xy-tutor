import { useState, useEffect, useCallback, useRef } from "react";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { MessageHistory } from "../../lib/types";
import type { ImageSubmission } from "../../../../../packages/contracts/src/conversation-images.js";
type Run = { id: string; status: string; content: string | null };
export function useTutorRun(conversationId?: string) {
  const a = useAuth();
  const [messages, setMessages] = useState<MessageHistory[]>([]),
    [stream, setStream] = useState(""),
    [runId, setRunId] = useState<string>(),
    [status, setStatus] = useState("idle"),
    [error, setError] = useState("");
  const lastId = useRef("0");
  const reload = useCallback(async () => {
    if (conversationId)
      setMessages(
        await api<MessageHistory[]>(
          a.scoped(`/api/conversations/${conversationId}/messages`),
        ),
      );
  }, [conversationId, a.studentId]);
  useEffect(() => {
    setMessages([]);
    setStream("");
    setRunId(undefined);
    setStatus("idle");
    if (!conversationId) return;
    void reload().catch((e) => setError(errorMessage(e)));
    const key = `xy.run.${conversationId}`;
    void api<Run | null>(
      a.scoped(`/api/conversations/${conversationId}/latest-run`),
    )
      .then((r) => {
        if (
          r &&
          ["queued", "running", "failed", "interrupted", "cancelled"].includes(
            r.status,
          )
        ) {
          lastId.current = "0";
          setRunId(r.id);
          setStatus(r.status);
          sessionStorage.setItem(key, r.id);
        }
      })
      .catch(() => {});
    const old = sessionStorage.getItem(key);
    if (old)
      void api<Run>(a.scoped(`/api/runs/${old}`))
        .then((r) => {
          if (["queued", "running"].includes(r.status)) {
            lastId.current = "0";
            setRunId(old);
            setStatus(r.status);
          } else {
            sessionStorage.removeItem(key);
            if (["failed", "interrupted", "cancelled"].includes(r.status)) {
              setRunId(old);
              setStatus(r.status);
            }
          }
        })
        .catch(() => sessionStorage.removeItem(key));
  }, [conversationId, reload]);
  useEffect(() => {
    if (!runId || !conversationId) return;
    const source = new EventSource(
      a.scoped(`/api/runs/${runId}/events?after=${lastId.current}`),
    );
    const handle = (event: MessageEvent) => {
      const value = JSON.parse(event.data);
      if (value.id && BigInt(value.id) <= BigInt(lastId.current)) return;
      if (value.id) lastId.current = value.id;
      const data = value.data ?? {};
      if (value.type === "text_delta") {
        setStatus("running");
        setStream((s) => s + String(data.text ?? ""));
      }
      if (value.type === "started") setStatus("running");
      if (value.type === "message_completed") {
        setStream("");
        void reload();
      }
      if (
        value.type === "done" ||
        value.type === "failed" ||
        value.type === "cancelled"
      ) {
        source.close();
        setStatus(value.type === "done" ? "idle" : value.type);
        setStream("");
        sessionStorage.removeItem(`xy.run.${conversationId}`);
        void reload();
        if (value.type === "failed")
          setError(data.message ?? "回答中断，可以继续提问");
      }
    };
    for (const name of [
      "queued",
      "started",
      "text_delta",
      "message_completed",
      "done",
      "failed",
      "cancelled",
    ])
      source.addEventListener(name, handle as EventListener);
    source.onerror = () => {
      setStatus("reconnecting");
      void api<Run>(a.scoped(`/api/runs/${runId}`))
        .then((r) => {
          if (!["queued", "running"].includes(r.status)) {
            source.close();
            setStatus(r.status === "succeeded" ? "idle" : r.status);
            sessionStorage.removeItem(`xy.run.${conversationId}`);
            setStream("");
            void reload();
          }
        })
        .catch(() => {});
    };
    return () => source.close();
  }, [runId, conversationId, reload, a.studentId]);
  const submit = async (
    input: string | ImageSubmission,
    questionVersionId?: string,
  ) => {
    if (!conversationId) return false;
    const submission: ImageSubmission =
      typeof input === "string" ? { message: input, attachmentIds: [] } : input;
    const message = submission.message;
    const attachments = submission.attachmentIds;
    const question = submission.questionVersionId ?? questionVersionId;
    setError("");
    const pendingKey = `xy.pending.${conversationId}`;
    const signature = JSON.stringify([message, question ?? null, attachments]);
    let pending: { signature: string; requestKey: string } | undefined;
    try {
      pending =
        JSON.parse(sessionStorage.getItem(pendingKey) ?? "null") ?? undefined;
    } catch {
      /* discard invalid local state */
    }
    if (pending?.signature !== signature)
      pending = { signature, requestKey: crypto.randomUUID() };
    sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    try {
      const result = await api<{ runId: string }>(
        a.scoped(`/api/conversations/${conversationId}/runs`),
        {
          method: "POST",
          ...jsonBody({
            message,
            requestKey: pending!.requestKey,
            questionVersionId: question,
            attachmentIds: attachments,
          }),
        },
      );
      lastId.current = "0";
      setStream("");
      setStatus("queued");
      setRunId(result.runId);
      sessionStorage.setItem(`xy.run.${conversationId}`, result.runId);
      sessionStorage.removeItem(pendingKey);
      void reload().catch((e) => setError(errorMessage(e)));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const cancel = async () => {
    if (runId) {
      await api(a.scoped(`/api/runs/${runId}/cancel`), { method: "POST" });
      setStatus("cancelled");
    }
  };
  const retry = async () => {
    if (!runId || !conversationId) return;
    const key = `xy.retry.${runId}`;
    let retryKey = sessionStorage.getItem(key);
    if (!retryKey) {
      retryKey = crypto.randomUUID();
      sessionStorage.setItem(key, retryKey);
    }
    try {
      const result = await api<{ runId: string }>(
        a.scoped(`/api/runs/${runId}/retry`),
        { method: "POST", ...jsonBody({ requestKey: retryKey }) },
      );
      lastId.current = "0";
      setError("");
      setStream("");
      setStatus("queued");
      setRunId(result.runId);
      sessionStorage.setItem(`xy.run.${conversationId}`, result.runId);
      sessionStorage.removeItem(key);
      void reload().catch((e) => setError(errorMessage(e)));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return {
    messages,
    stream,
    status,
    error,
    setError,
    submit,
    cancel,
    retry,
    reload,
    busy: ["queued", "running", "reconnecting"].includes(status),
  };
}
