import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  ArrowUp,
  Camera,
  ImagePlus,
  Plus,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import type { ImageSubmission } from "../../../../../packages/contracts/src/conversation-images.js";
import { CHAT_IMAGE_ACCEPT } from "../uploads/imagePrepare";
import { ImageAttachmentPreview } from "../../components/ImageAttachmentPreview";
import type { ImageAttachments, ImageDraftItem } from "./useImageAttachments";

function statusLabel(item: ImageDraftItem) {
  if (item.status === "uploading") return `上传中 ${item.progress}%`;
  if (item.status === "ready") return "已就绪";
  if (item.status === "failed") return "上传失败";
  return "处理中";
}

export function Composer({
  busy,
  onSubmit,
  onCancel,
  hasQuestion,
  value,
  onValueChange,
  inputRef,
  placeholder,
  attachments,
  imagesEnabled = true,
}: {
  busy: boolean;
  onSubmit: (submission: ImageSubmission) => Promise<boolean>;
  onCancel: () => Promise<void>;
  hasQuestion?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  attachments?: ImageAttachments;
  imagesEnabled?: boolean;
}) {
  const [inner, setInner] = useState(""),
    [sending, setSending] = useState(false);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const areaRef = inputRef ?? localRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const [imageMenu, setImageMenu] = useState(false);
  const [imageNotice, setImageNotice] = useState("");
  const imageActions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!imageMenu) return;
    const close = (e: PointerEvent) => {
      if (!imageActions.current?.contains(e.target as Node))
        setImageMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setImageMenu(false);
        imageActions.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [imageMenu]);
  const coarsePointer = () =>
    window.matchMedia("(pointer: coarse)").matches;
  const mobileCamera = () =>
    navigator.maxTouchPoints > 0 &&
    (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      /MacIntel/.test(navigator.platform) ||
      window.matchMedia("(pointer: coarse)").matches);
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
  const readyImages = attachments?.readyFileIds ?? [];
  const hasContent = !!text.trim() || readyImages.length > 0;
  const canSend =
    hasContent && !sending && !busy && (!attachments || attachments.canSend);
  const pick = (input: RefObject<HTMLInputElement | null>) =>
    input.current?.click();
  const add = (files: FileList | null) => {
    if (files?.length) attachments?.addFiles(files);
  };
  const send = async () => {
    if (!canSend) return;
    setImageMenu(false);
    setSending(true);
    try {
      const submission: ImageSubmission = {
        message: text.trim(),
        attachmentIds: readyImages,
      };
      if (await onSubmit(submission)) {
        change("");
        attachments?.reset();
      }
    } finally {
      setSending(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };
  const showImages = !!attachments && imagesEnabled;
  return (
    <form
      className={`composer${busy ? " is-busy" : ""}`}
      onSubmit={submit}
      onPaste={(e) => {
        const files = [...e.clipboardData.files].filter((f) =>
          f.type.startsWith("image/"),
        );
        if (showImages && !sending && files.length) {
          e.preventDefault();
          attachments.addFiles(files);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        if (showImages && !sending)
          attachments.addFiles(
            [...e.dataTransfer.files].filter((f) =>
              f.type.startsWith("image/"),
            ),
          );
      }}
    >
      <div className="composer-box">
        {showImages && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              accept={CHAT_IMAGE_ACCEPT}
              multiple
              aria-label="选择图片文件"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={captureRef}
              type="file"
              className="sr-only"
              accept="image/*"
              capture="environment"
              aria-label="拍照上传图片"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
        {showImages && !!attachments?.items.length && (
          <div className="composer-images" role="group" aria-label="待发送图片">
            {attachments.items.map((item, index) => (
              <div className={`composer-image is-${item.status}`} key={item.id}>
                <ImageAttachmentPreview
                  className="composer-image-preview"
                  label={`第${index + 1}张图片`}
                  indexOffset={index}
                  images={[
                    { key: item.id, src: item.previewUrl, alt: "待发送图片" },
                  ]}
                />
                <span className="composer-image-status">
                  {statusLabel(item)}
                </span>
                <div className="composer-image-tools">
                  <button
                    type="button"
                    aria-label={`旋转第${index + 1}张图片`}
                    title="旋转"
                    disabled={
                      item.status !== "ready" && item.status !== "failed"
                    }
                    onClick={() => attachments.rotate(item.id)}
                  >
                    <RotateCw size={16} />
                  </button>
                  {item.status === "failed" && (
                    <button
                      type="button"
                      aria-label={`重试第${index + 1}张图片`}
                      title="重试"
                      onClick={() => attachments.retry(item.id)}
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`移除第${index + 1}张图片`}
                    title="移除"
                    onClick={() => attachments.remove(item.id)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {imageNotice && (
          <p role="alert" className="composer-image-error">
            {imageNotice}
          </p>
        )}
        {showImages && attachments?.error && (
          <p role="alert" className="composer-image-error">
            {attachments.error}
          </p>
        )}
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
              e.keyCode !== 229 &&
              !coarsePointer()
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          {attachments ? (
            <div className="composer-image-actions" ref={imageActions}>
              <button
                type="button"
                className="composer-image-add"
                aria-label="添加图片"
                title="添加图片"
                disabled={sending}
                aria-expanded={imageMenu}
                onClick={() => {
                  if (!imagesEnabled) {
                    setImageNotice(
                      "当前模型尚未启用图片输入，请启用后再上传图片。",
                    );
                    return;
                  }
                  setImageNotice("");
                  if (mobileCamera()) setImageMenu((v) => !v);
                  else pick(fileRef);
                }}
              >
                <Plus size={16} />
              </button>
              {imageMenu && (
                <div
                  className="composer-image-menu"
                  role="group"
                  aria-label="图片来源"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setImageMenu(false);
                      pick(captureRef);
                    }}
                  >
                    <Camera size={16} />
                    拍照
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setImageMenu(false);
                      pick(fileRef);
                    }}
                  >
                    <ImagePlus size={16} />
                    选择图片
                  </button>
                </div>
              )}
            </div>
          ) : (
            <span />
          )}
          <span className="composer-hint">
            {attachments?.blockedReason || "Enter 发送 · Shift + Enter 换行"}
          </span>
          {busy ? (
            <button
              type="button"
              className="composer-send is-stop"
              onClick={() => void onCancel()}
              aria-label="停止回答"
              title="停止回答"
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className="composer-send"
              disabled={!canSend}
              aria-label="发送消息"
              title="发送"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
