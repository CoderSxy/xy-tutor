import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageCircle, NotebookPen, Sparkles, Target } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import type { TaskDTO, TaskKind } from "../lib/types";
import type { ImageSubmission } from "../../../../packages/contracts/src/conversation-images.js";
import { Button } from "../components/ui/button";
import { SessionRail } from "../components/SessionRail";
import { sessionStarter } from "../lib/sessionStart";
import { Composer } from "../features/tutor/Composer";
import { useImageAttachments } from "../features/tutor/useImageAttachments";

const quickStarts: {
  kind: TaskKind;
  label: string;
  description: string;
  icon: typeof Target;
}[] = [
  {
    kind: "daily_practice",
    label: "每日5练",
    description: "按当前教材练5题",
    icon: Sparkles,
  },
  {
    kind: "knowledge_consolidation",
    label: "知识点巩固",
    description: "先诊断，再针对性练习",
    icon: Target,
  },
  {
    kind: "mistake_review",
    label: "错题回顾",
    description: "从待订正的错题开始",
    icon: NotebookPen,
  },
  {
    kind: "free_question",
    label: "自由提问",
    description: "把没想明白的直接问出来",
    icon: MessageCircle,
  },
];

export function Home() {
  const a = useAuth(),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState(""),
    [railRefresh, setRailRefresh] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const firstMessage = useRef<ReturnType<typeof sessionStarter> | null>(null);
  if (!firstMessage.current)
    firstMessage.current = sessionStarter(
      async (scope, creationKey) => {
        const [studentId, revisionId] = scope.split(":");
        const task = await api<TaskDTO>(
          `/api/tasks?studentId=${encodeURIComponent(studentId!)}`,
          {
            method: "POST",
            ...jsonBody({ revisionId, kind: "free_question", creationKey }),
          },
        );
        setRailRefresh((value) => value + 1);
        return task;
      },
      async (conversationId, submission, requestKey, scope) => {
        const result = await api<{ runId: string }>(
          `/api/conversations/${conversationId}/runs?studentId=${encodeURIComponent(scope.split(":")[0]!)}`,
          {
            method: "POST",
            ...jsonBody({
              message: submission.message,
              requestKey,
              attachmentIds: submission.attachmentIds,
            }),
          },
        );
        sessionStorage.setItem(`xy.run.${conversationId}`, result.runId);
        return result;
      },
    );
  const images = useImageAttachments({
    studentId: a.studentId,
    identity: a.selected?.id,
    enabled: a.capabilities?.images !== "disabled",
    ensureConversation: () =>
      firstMessage.current!.ensureConversation(
        `${a.studentId}:${a.selected!.id}`,
      ),
  });
  const createSession = async (kind: TaskKind, submission?: ImageSubmission) => {
    if (!a.selected) return;
    if (submission) {
      const id = await firstMessage.current!.send(
        `${a.studentId}:${a.selected.id}`,
        submission,
      );
      navigate(`/study/${id}`);
      return;
    }
    const t = await api<TaskDTO>(a.scoped("/api/tasks"), {
      method: "POST",
      ...jsonBody({ revisionId: a.selected.id, kind }),
    });
    navigate(`/study/${t.id}`);
  };
  const quickStart = async (kind: TaskKind) => {
    if (kind === "mistake_review") {
      navigate("/mistakes");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createSession(kind);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const prepareFreeQuestion = () => {
    setDraft("我想自由提问：");
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const sendFreeQuestion = async (submission: ImageSubmission) => {
    setBusy(true);
    setError("");
    try {
      await createSession("free_question", submission);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!a.studentId)
    return (
      <>
        <div className="page-heading">
          <h1>欢迎使用 XY Tutor</h1>
          <p>先发布教材并邀请学习账号，即可开始使用。</p>
        </div>
        <Button asChild>
          <Link to="/admin/textbooks">管理电子教材</Link>
        </Button>
      </>
    );
  return (
    <>
      {error && (
        <p role="alert" className="notice error-text">
          {error}
        </p>
      )}
      {a.capabilities && !a.capabilities.llmConfigured && (
        <div className="notice">
          <MessageCircle size={20} />
          <span>
            辅导服务尚未启用。你可以先查看教材、整理错题，启用后继续学习。
          </span>
        </div>
      )}
      <div className="home-layout">
        <SessionRail refreshKey={String(railRefresh)} />
        <section className="chat-landing">
          <div className="chat-landing-body">
            <div className="chat-hero">
              <span className="chat-eyebrow">
                <Sparkles size={15} />
                今天，从哪里开始？
              </span>
              <h1 className="chat-title">选一个方向，或者直接说出来。</h1>
              <p className="chat-lede">
                左边可以接着之前的学习；也可以在下面开始新的练习、巩固，或者把没想明白的直接问出来。
              </p>
            </div>
          </div>
          <div className="composer-dock">
            <div className="quick-chips" aria-label="快捷开始">
              {quickStarts.map(({ kind, label, description, icon: Icon }) => (
                <button
                  key={kind}
                  type="button"
                  className="quick-chip"
                  disabled={busy}
                  title={description}
                  onClick={() => {
                    if (kind === "free_question") prepareFreeQuestion();
                    else void quickStart(kind);
                  }}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
            <Composer
              busy={false}
              hasQuestion={false}
              value={draft}
              onValueChange={setDraft}
              inputRef={composerRef}
              placeholder="想学什么、哪里没懂，直接说…"
              onSubmit={sendFreeQuestion}
              onCancel={async () => {}}
              attachments={images}
              imagesEnabled={a.capabilities?.images !== "disabled"}
            />
            <p className="composer-note">
              发送后会开启一个新的自由提问会话，左边随时可以找回。
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
