import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CircleHelp, Check, ChevronDown, Sparkles } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { useRemote } from "../lib/useRemote";
import type { TaskDTO, TaskItem, SummaryContent } from "../lib/types";
import { kindLabels } from "../lib/types";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { QuestionCard } from "../components/QuestionCard";
import { SessionRail } from "../components/SessionRail";
import { useTutorRun } from "../features/tutor/useTutorRun";
import { useImageAttachments } from "../features/tutor/useImageAttachments";
import { TutorPanel } from "../features/tutor/TutorPanel";
import { Composer } from "../features/tutor/Composer";
export function Study() {
  const { id } = useParams();
  const a = useAuth();
  const task = useRemote<TaskDTO>(id ? a.scoped(`/api/tasks/${id}`) : null);
  const items = useRemote<TaskItem[]>(
    id ? a.scoped(`/api/tasks/${id}/items`) : null,
  );
  const tutor = useTutorRun(task.data?.conversationId);
  const images = useImageAttachments({
    studentId: a.studentId,
    conversationId: task.data?.conversationId,
    enabled: a.capabilities?.images !== "disabled",
  });
  const [error, setError] = useState(""),
    [summary, setSummary] = useState<SummaryContent>(),
    [questionOpen, setQuestionOpen] = useState(false);
  useEffect(() => {
    if (tutor.status === "idle" || tutor.status === "failed") items.reload();
  }, [tutor.status]);
  const railRefresh = `${id}:${task.data?.version}:${tutor.status}:${tutor.messages.at(-1)?.id}`;
  const current =
    items.data?.find((q) => q.status === "pending") ?? items.data?.at(-1);
  if (task.loading || task.error || !task.data)
    return (
      <div className="home-layout">
        <SessionRail
          currentId={id}
          refreshKey={railRefresh}
          onTaskChange={task.reload}
        />
        <section className="study-main">
          <StatusPanel
            state={task.loading ? "loading" : "error"}
            title={
              task.loading ? "正在恢复学习任务" : task.error || "任务不存在"
            }
            onRetry={task.loading ? undefined : task.reload}
          />
        </section>
      </div>
    );
  const data = task.data;
  const resume = async () => {
    try {
      await api(a.scoped(`/api/tasks/${id}`), {
        method: "PATCH",
        ...jsonBody({ expectedVersion: data.version, status: "active" }),
      });
      task.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const finish = async () => {
    try {
      const complete =
        data.kind !== "daily_practice" ||
        (items.data?.filter((q) => q.status !== "pending").length ?? 0) >= 5;
      await api(a.scoped(`/api/tasks/${id}`), {
        method: "PATCH",
        ...jsonBody({
          expectedVersion: data.version,
          status: complete ? "completed" : "paused",
        }),
      });
      task.reload();
      const saved = await api<{ content: SummaryContent } | null>(
        a.scoped(`/api/tasks/${id}/summary`),
      );
      if (saved) setSummary(saved.content);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="home-layout">
      <SessionRail
        currentId={id}
        refreshKey={railRefresh}
        onTaskChange={task.reload}
      />
      <section className="study-main">
        {(error || tutor.error) && (
          <p className="notice error-text" role="alert">
            {error || tutor.error}
          </p>
        )}
        {data.status === "paused" && (
          <div className="notice">
            任务已暂停，学习进度已保存。
            <Button variant="ghost" onClick={() => void resume()}>
              恢复学习
            </Button>
          </div>
        )}
        <div className={`study-layout${current ? "" : " is-solo"}`}>
          {current && (
            <aside
              className={`study-question ${questionOpen ? "is-open" : ""}`}
            >
              <button
                className="question-toggle"
                onClick={() => setQuestionOpen(!questionOpen)}
              >
                当前题目
                <ChevronDown size={18} />
              </button>
              <div className="question-body">
                <QuestionCard question={current} />
                <div className="question-tools">
                  <Button
                    variant="outline"
                    disabled={tutor.busy || data.status !== "active"}
                    onClick={() =>
                      void tutor.submit(
                        "这道题我还不太会，请先给一个小提示，不要直接给完整解法。",
                      )
                    }
                  >
                    <CircleHelp size={17} />
                    给我一个提示
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={tutor.busy || data.status !== "active"}
                    onClick={async () => {
                      try {
                        await api(a.scoped(`/api/tasks/${id}/skip`), {
                          method: "POST",
                          ...jsonBody({ itemId: current.id }),
                        });
                        items.reload();
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  >
                    先跳过这题
                  </Button>
                </div>
                <p className="muted text-small question-note">
                  提示后的答对会保留记录；独立练习和延迟复习提供新的掌握证据。
                </p>
              </div>
            </aside>
          )}
          <section className="tutor-workspace">
            <header className="tutor-head">
              <h1>{kindLabels[data.kind]}</h1>
              <Button
                variant="outline"
                disabled={tutor.busy || data.status === "completed"}
                onClick={() => void finish()}
              >
                <Check size={17} />
                结束本次学习
              </Button>
            </header>
            <TutorPanel
              messages={tutor.messages}
              stream={tutor.stream}
              status={tutor.status}
              onRetry={() => void tutor.retry()}
            />
            {data.status === "completed" && (
              <div className="tutor-compose">
                <div className="notice tutor-done">
                  <span>
                    本次学习已保存。
                    {summary?.text ??
                      "学习小结会在后台整理；你可以随时查看记录。"}
                  </span>
                  <Link className="text-link" to="/history">
                    查看学习记录
                  </Link>
                </div>
              </div>
            )}
            {data.status === "active" && (
              <div className="tutor-compose">
                {!current && (
                  <button
                    type="button"
                    className="composer-pill"
                    disabled={tutor.busy}
                    onClick={() =>
                      void tutor.submit(
                        "请先确认我的当前章节和学习范围，再开始本次学习。",
                      )
                    }
                  >
                    <Sparkles size={15} />
                    开始本次辅导
                  </button>
                )}
                <Composer
                  busy={tutor.busy}
                  hasQuestion={!!current}
                  onSubmit={(submission) =>
                    tutor.submit(submission, current?.questionVersionId)
                  }
                  onCancel={tutor.cancel}
                  attachments={images}
                  imagesEnabled={a.capabilities?.images !== "disabled"}
                />
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
