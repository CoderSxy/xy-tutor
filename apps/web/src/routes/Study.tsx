import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CircleHelp, Check, ChevronDown } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { useRemote } from "../lib/useRemote";
import type { TaskDTO, TaskItem, SummaryContent } from "../lib/types";
import { kindLabels } from "../lib/types";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { QuestionCard } from "../components/QuestionCard";
import { NextActions } from "../components/NextActions";
import { useTutorRun } from "../features/tutor/useTutorRun";
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
  const [error, setError] = useState(""),
    [summary, setSummary] = useState<SummaryContent>(),
    [questionOpen, setQuestionOpen] = useState(false);
  useEffect(() => {
    if (tutor.status === "idle" || tutor.status === "failed") items.reload();
  }, [tutor.status]);
  const current =
    items.data?.find((q) => q.status === "pending") ?? items.data?.at(-1);
  if (task.loading)
    return <StatusPanel state="loading" title="正在恢复学习任务" />;
  if (task.error || !task.data)
    return (
      <StatusPanel
        state="error"
        title={task.error || "任务不存在"}
        onRetry={task.reload}
      />
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
    <>
      <div className="study-heading">
        <div>
          <h1>{kindLabels[data.kind]}</h1>
          <p className="muted">
            {items.data?.length
              ? `已安排 ${items.data.length} 题 · ${items.data.filter((q) => q.status !== "pending").length} 题已作答或跳过`
              : "从一个问题开始，逐步确定本次学习目标。"}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={tutor.busy || data.status === "completed"}
          onClick={() => void finish()}
        >
          <Check size={17} />
          结束本次学习
        </Button>
      </div>
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
      {data.status === "completed" && (
        <div className="notice">
          本次学习已保存。
          {summary?.text ?? "学习小结会在后台整理；你可以随时查看记录。"}
          <Link className="text-link" to="/history">
            查看学习记录
          </Link>
        </div>
      )}
      <div className="study-layout">
        <aside className={`study-question ${questionOpen ? "is-open" : ""}`}>
          <button
            className="question-toggle"
            onClick={() => setQuestionOpen(!questionOpen)}
          >
            当前题目
            <ChevronDown size={18} />
          </button>
          <div className="question-body">
            {current ? (
              <QuestionCard question={current} />
            ) : (
              <section className="panel">
                <h2>本次学习目标</h2>
                <p className="muted">
                  {data.kind === "daily_practice"
                    ? "先告诉老师当前章节，再逐题完成5道练习。"
                    : "告诉老师想巩固的知识点，或者直接提出问题。"}
                </p>
                <Button
                  variant="outline"
                  disabled={tutor.busy || data.status !== "active"}
                  onClick={() =>
                    void tutor.submit(
                      "请先确认我的当前章节和学习范围，再开始本次学习。",
                    )
                  }
                >
                  开始本次辅导
                </Button>
              </section>
            )}
            {current && (
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
            )}
            <p className="muted text-small question-note">
              提示后的答对会保留记录；独立练习和延迟复习提供新的掌握证据。
            </p>
          </div>
        </aside>
        <section className="tutor-workspace">
          <TutorPanel
            messages={tutor.messages}
            stream={tutor.stream}
            status={tutor.status}
          />
          {data.status === "active" && (
            <Composer
              busy={tutor.busy}
              hasQuestion={!!current}
              onSubmit={(text) =>
                tutor.submit(text, current?.questionVersionId)
              }
              onCancel={tutor.cancel}
            />
          )}
        </section>
      </div>
      <div className="study-next">
        <NextActions
          actions={[
            { id: "home", label: "返回学习首页" },
            { id: "upload", label: "上传新的题目" },
          ]}
          onSelect={(key) => {
            window.location.href = key === "home" ? "/" : "/materials";
          }}
        />
      </div>
    </>
  );
}
