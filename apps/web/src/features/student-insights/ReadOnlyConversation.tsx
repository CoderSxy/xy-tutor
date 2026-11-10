import { useRef, useState } from "react";
import type { MessageRecordDTO } from "../../../../../packages/contracts/src/student-insights.js";
import { ImageAttachmentPreview } from "../../components/ImageAttachmentPreview";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import { useConversationMessages } from "./api";
import { dateTime } from "./format";
import { ListPager } from "./ListPager";
import { useSignedDownload } from "./useSignedDownload";

const PAGE_SIZE = 20;

function SignedAttachment({
  studentId,
  fileId,
  name,
  image,
}: {
  studentId: string;
  fileId: string;
  name: string;
  image: boolean;
}) {
  const { url, error, loading, fetchLink } = useSignedDownload(
    studentId,
    fileId,
    image,
  );
  const [imageError, setImageError] = useState("");
  const imageRetries = useRef(0);

  const onImageError = () => {
    if (imageRetries.current < 1) {
      imageRetries.current += 1;
      void fetchLink();
      return;
    }
    setImageError("附件加载失败");
  };

  const failure = imageError || error;

  if (failure)
    return (
      <span className="attachment-failure">
        <span className="muted">{failure}</span>
        <Button
          type="button"
          size="small"
          variant="outline"
          onClick={() => {
            setImageError("");
            void fetchLink();
          }}
        >
          重试
        </Button>
      </span>
    );

  if (image) {
    if (!url)
      return (
        <span className="muted text-small">
          {loading ? "正在加载附件" : "附件不可用"}
        </span>
      );
    return (
      <ImageAttachmentPreview
        label={`${name} 图片附件`}
        className="insight-message-images"
        images={[{ key: fileId, src: url, alt: name }]}
        onImageError={onImageError}
      />
    );
  }

  if (!url)
    return (
      <Button
        type="button"
        size="small"
        variant="outline"
        disabled={loading}
        onClick={() => void fetchLink()}
      >
        {loading ? "正在获取下载链接" : `下载 ${name}`}
      </Button>
    );

  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      下载 {name}
    </a>
  );
}

function Message({ studentId, message }: { studentId: string; message: MessageRecordDTO }) {
  return (
    <article className={`insight-message is-${message.role}`}>
      <header>
        <strong>{message.role === "assistant" ? "辅导员" : "学生"}</strong>
        <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time>
      </header>
      <Markdown>{message.content}</Markdown>
      {message.attachments.length > 0 && (
        <div className="insight-message-attachments">
          {message.attachments.map((attachment) => (
            <SignedAttachment
              key={attachment.fileId}
              studentId={studentId}
              fileId={attachment.fileId}
              name={attachment.name}
              image={attachment.contentType.startsWith("image/")}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function ReadOnlyConversation({
  studentId,
  conversationId,
}: {
  studentId: string;
  conversationId: string;
}) {
  const [offset, setOffset] = useState(0);
  const result = useConversationMessages(studentId, conversationId, {
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <section className="panel insight-conversation" aria-label="学习对话（只读）">
      <div className="section-head">
        <h2>学习对话</h2>
        <span className="muted">只读</span>
      </div>
      {result.loading ? (
        <p className="muted">正在读取对话</p>
      ) : result.error ? (
        <div>
          <p className="muted">{result.error}</p>
          <Button
            type="button"
            size="small"
            variant="outline"
            onClick={result.reload}
          >
            重试
          </Button>
        </div>
      ) : result.data && result.data.items.length === 0 ? (
        <p className="muted">暂无对话记录。</p>
      ) : result.data ? (
        <>
          <div className="insight-conversation-messages">
            {result.data.items.map((message) => (
              <Message
                key={message.id}
                studentId={studentId}
                message={message}
              />
            ))}
          </div>
          <ListPager
            total={result.data.total}
            limit={PAGE_SIZE}
            offset={offset}
            onChange={setOffset}
            busy={result.loading}
          />
        </>
      ) : null}
    </section>
  );
}
