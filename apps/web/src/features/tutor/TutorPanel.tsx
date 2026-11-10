import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, ArrowDown, Check } from "lucide-react";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import { ImageAttachmentPreview } from "../../components/ImageAttachmentPreview";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { MessageHistory } from "../../lib/types";
const busyStates = ["queued", "running", "reconnecting"];
const LINK_HEADROOM_MS = 60_000;

type DownloadLink = { url: string; expiresAt?: string };

function expiringSoon(link: DownloadLink) {
  return (
    !link.expiresAt ||
    new Date(link.expiresAt).getTime() - Date.now() < LINK_HEADROOM_MS
  );
}

function useImageLinks(fileIds: string[]) {
  const a = useAuth();
  const [links, setLinks] = useState<Record<string, string>>({});
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const requested = useRef(new Set<string>());
  const refreshed = useRef<Record<string, boolean>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fetchLink = useCallback(
    (fileId: string) =>
      api<DownloadLink>(a.scoped(`/api/files/${fileId}/download`)),
    [a.studentId],
  );
  const refresh = async (fileId: string) => {
    try {
      const link = await fetchLink(fileId);
      if (!mounted.current) return;
      setLinks((current) => ({ ...current, [fileId]: link.url }));
      setBroken((current) => ({ ...current, [fileId]: false }));
    } catch {
      if (mounted.current)
        setBroken((current) => ({ ...current, [fileId]: true }));
    }
  };
  const key = fileIds.join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const missing = ids.filter((id) => !requested.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => requested.current.add(id));
    for (const fileId of missing)
      void (async () => {
        try {
          const first = await fetchLink(fileId);
          let url = first.url;
          if (expiringSoon(first) && !refreshed.current[fileId]) {
            refreshed.current[fileId] = true;
            url = (await fetchLink(fileId)).url;
          }
          if (mounted.current)
            setLinks((current) => ({ ...current, [fileId]: url }));
        } catch {
          if (mounted.current)
            setBroken((current) => ({ ...current, [fileId]: true }));
        }
      })();
  }, [key, fetchLink]);
  const onError = (fileId: string) => {
    if (!refreshed.current[fileId]) {
      refreshed.current[fileId] = true;
      void refresh(fileId);
    } else setBroken((current) => ({ ...current, [fileId]: true }));
  };
  const retry = (fileId: string) => {
    refreshed.current[fileId] = false;
    void refresh(fileId);
  };
  return { links, broken, onError, retry };
}

export function TutorPanel({
  messages,
  stream,
  status,
  onRetry,
}: {
  messages: MessageHistory[];
  stream: string;
  status: string;
  onRetry?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    wasBusy = useRef(false);
  const [newContent, setNewContent] = useState(false),
    [finishedAt, setFinishedAt] = useState("");
  const busy = busyStates.includes(status);
  const fileIds: string[] = [];
  for (const message of messages)
    for (const attachment of message.attachments ?? [])
      if (!fileIds.includes(attachment.fileId))
        fileIds.push(attachment.fileId);
  const { links, broken, onError, retry } = useImageLinks(fileIds);
  const keepFollowing = () => {
    const node = container.current;
    if (!node) return;
    requestAnimationFrame(() => {
      const current = container.current;
      if (!current) return;
      if (current.scrollHeight - current.scrollTop - current.clientHeight < 96)
        current.scrollTop = current.scrollHeight;
    });
  };
  useEffect(() => {
    if (wasBusy.current && !busy && status === "idle")
      setFinishedAt(
        new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
    if (busy) setFinishedAt("");
    wasBusy.current = busy;
  }, [busy, status]);
  useEffect(() => {
    if (follow.current && container.current)
      container.current.scrollTop = container.current.scrollHeight;
    else setNewContent(true);
  }, [messages, stream, status]);
  const bottom = () => {
    follow.current = true;
    setNewContent(false);
    if (container.current)
      container.current.scrollTop = container.current.scrollHeight;
  };
  const interrupted = ["failed", "interrupted", "cancelled"].includes(status);
  return (
    <div className="tutor-log-wrap">
      <div
        className="tutor-log"
        ref={container}
        role="log"
        aria-label="辅导对话"
        aria-live="polite"
        onScroll={() => {
          const node = container.current;
          if (node) {
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 72;
            if (follow.current) setNewContent(false);
          }
        }}
      >
        {!messages.length && !stream && (
          <div className="tutor-welcome">
            <BookOpen size={30} />
            <h2>我们一起想明白</h2>
            <p>
              告诉老师你最近学到哪里，或从当前题目开始。需要时可以请求提示。
            </p>
          </div>
        )}
        {messages
          .filter((m) => m.role !== "system")
          .map((m) => {
            const attachments = m.attachments ?? [];
            const images = attachments.flatMap((attachment) => {
              const url = links[attachment.fileId];
              return url
                ? [
                    {
                      key: attachment.fileId,
                      src: url,
                      alt: attachment.name || "作答图片",
                    },
                  ]
                : [];
            });
            return (
              <article className={`message message-${m.role}`} key={m.id}>
                {m.role === "assistant" && (
                  <div className="message-author">
                    学习老师
                    {m.versionNo > 1 && <span> · 已编辑</span>}
                  </div>
                )}
                {!!attachments.length && (
                  <div className="message-images">
                    <ImageAttachmentPreview
                      images={images}
                      label="消息图片"
                      onImageLoad={keepFollowing}
                      onImageError={(image) => onError(image.key)}
                    />
                    {attachments
                      .filter(
                        (attachment) =>
                          !links[attachment.fileId] &&
                          broken[attachment.fileId],
                      )
                      .map((attachment) => (
                        <button
                          type="button"
                          className="image-reload"
                          key={attachment.fileId}
                          onClick={() => retry(attachment.fileId)}
                        >
                          重新加载图片
                        </button>
                      ))}
                  </div>
                )}
                <Markdown>{m.content}</Markdown>
              </article>
            );
          })}
        {stream && (
          <article className="message message-assistant is-streaming">
            <div className="message-author">
              学习老师 · 正在回答
              <span className="stream-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            </div>
            <Markdown>{stream}</Markdown>
          </article>
        )}
        {status === "queued" && (
          <p className="tutor-status" role="status">
            <span className="stream-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            正在排队准备回答…
          </p>
        )}
        {status === "running" && !stream && (
          <p className="tutor-status" role="status">
            <span className="stream-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            学习老师正在思考…
          </p>
        )}
        {status === "reconnecting" && (
          <p className="tutor-status" role="status">
            连接恢复中，已提交内容会保留…
          </p>
        )}
        {interrupted && (
          <div className="tutor-status is-interrupted" role="status">
            <span>
              {status === "cancelled"
                ? "已停止回答，已发送的内容和图片都保留。"
                : "回答中断，可以重新回答。"}
            </span>
            {status !== "cancelled" && onRetry && (
              <Button variant="outline" size="small" onClick={onRetry}>
                重新回答
              </Button>
            )}
          </div>
        )}
        {finishedAt && !busy && (
          <p className="tutor-status is-done" role="status">
            <Check size={14} />
            回答已完成 · {finishedAt}
          </p>
        )}
      </div>
      {newContent && (
        <Button className="new-message" variant="outline" onClick={bottom}>
          <ArrowDown size={16} />
          有新回复
        </Button>
      )}
    </div>
  );
}
