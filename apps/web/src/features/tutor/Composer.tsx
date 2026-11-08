import { useState, type FormEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/field";
export function Composer({
  busy,
  onSubmit,
  onCancel,
  hasQuestion,
}: {
  busy: boolean;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => Promise<void>;
  hasQuestion: boolean;
}) {
  const [text, setText] = useState(""),
    [sending, setSending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending || busy) return;
    setSending(true);
    try {
      if (await onSubmit(text.trim())) setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="tutor-answer" className="sr-only">
        你的回答
      </label>
      <Textarea
        id="tutor-answer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          hasQuestion
            ? "写下你的答案或解题过程…"
            : "写下想问的问题，或告诉老师最近学到哪里…"
        }
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void submit(e);
        }}
      />
      <div className="composer-footer">
        <span>
          {hasQuestion
            ? "提交后会保留本次作答记录"
            : "可以输入文字，也可以上传题目"}{" "}
          · Ctrl / ⌘ + Enter 发送
        </span>
        {busy ? (
          <Button
            variant="outline"
            type="button"
            onClick={() => void onCancel()}
          >
            <Square size={15} />
            停止回答
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={sending || !text.trim()}
            aria-label="发送消息"
          >
            <ArrowUp size={19} />
            <span>发送</span>
          </Button>
        )}
      </div>
    </form>
  );
}
