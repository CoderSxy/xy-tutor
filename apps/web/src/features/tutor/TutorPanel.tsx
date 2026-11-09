import { useEffect, useRef, useState } from "react";
import { BookOpen, ArrowDown, Check } from "lucide-react";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import type { MessageHistory } from "../../lib/types";
const busyStates = ["queued", "running", "reconnecting"];
export function TutorPanel({
  messages,
  stream,
  status,
}: {
  messages: MessageHistory[];
  stream: string;
  status: string;
}) {
  const container = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    wasBusy = useRef(false);
  const [newContent, setNewContent] = useState(false),
    [finishedAt, setFinishedAt] = useState("");
  const busy = busyStates.includes(status);
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
          .map((m) => (
            <article className={`message message-${m.role}`} key={m.id}>
              {m.role === "assistant" && (
                <div className="message-author">
                  学习老师
                  {m.versionNo > 1 && <span> · 已编辑</span>}
                </div>
              )}
              <Markdown>{m.content}</Markdown>
            </article>
          ))}
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
