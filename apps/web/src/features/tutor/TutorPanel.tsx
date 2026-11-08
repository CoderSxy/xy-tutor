import { useEffect, useRef, useState } from "react";
import { BookOpen, ArrowDown } from "lucide-react";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import type { MessageHistory } from "../../lib/types";
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
    follow = useRef(true);
  const [newContent, setNewContent] = useState(false);
  useEffect(() => {
    if (follow.current && container.current)
      container.current.scrollTop = container.current.scrollHeight;
    else setNewContent(true);
  }, [messages, stream]);
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
              <div className="message-author">
                {m.role === "assistant" ? "学习老师" : "你"}
                {m.versionNo > 1 && <span> · 已编辑</span>}
              </div>
              <Markdown>{m.content}</Markdown>
            </article>
          ))}
        {stream && (
          <article className="message message-assistant">
            <div className="message-author">学习老师 · 正在回答</div>
            <Markdown>{stream}</Markdown>
          </article>
        )}
        {status === "queued" && (
          <p className="muted" role="status">
            正在排队准备回答…
          </p>
        )}
        {status === "reconnecting" && (
          <p className="muted" role="status">
            连接恢复中，已提交内容会保留…
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
