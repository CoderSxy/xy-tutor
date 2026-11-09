import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { ArrowUp, Square } from "lucide-react";

export function Composer({
  busy,
  onSubmit,
  onCancel,
  hasQuestion,
  value,
  onValueChange,
  inputRef,
  placeholder,
}: {
  busy: boolean;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => Promise<void>;
  hasQuestion?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}) {
  const [inner, setInner] = useState(""),
    [sending, setSending] = useState(false);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const areaRef = inputRef ?? localRef;
  const composing = useRef(false);
  const text = value ?? inner;
  const change = (next: string) => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "0px";
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
  }, [text, areaRef]);
  const send = async () => {
    if (!text.trim() || sending || busy) return;
    setSending(true);
    try {
      if (await onSubmit(text.trim())) change("");
    } finally {
      setSending(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };
  return (
    <form
      className={`composer${busy ? " is-busy" : ""}`}
      onSubmit={submit}
    >
      <div className="composer-box">
        <label htmlFor="tutor-answer" className="sr-only">
          你的回答
        </label>
        <textarea
          id="tutor-answer"
          ref={areaRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={
            placeholder ??
            (hasQuestion
              ? "写下你的答案或解题过程…"
              : "写下想问的问题，或告诉老师最近学到哪里…")
          }
          onChange={(e) => change(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !composing.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
          {busy ? (
            <button
              type="button"
              className="composer-send is-stop"
              onClick={() => void onCancel()}
              aria-label="停止回答"
              title="停止回答"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className="composer-send"
              disabled={sending || !text.trim()}
              aria-label="发送消息"
              title="发送"
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
