import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  NotebookPen,
  Files,
  Target,
  MessageCircle,
  Play,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { useRemote } from "../lib/useRemote";
import type { TaskDTO, TaskKind } from "../lib/types";
import { kindLabels } from "../lib/types";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { NextActions } from "../components/NextActions";
export function Home() {
  const a = useAuth(),
    navigate = useNavigate();
  const tasks = useRemote<TaskDTO[]>(
    a.studentId ? a.scoped("/api/tasks") : null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [greeting, setGreeting] = useState(""),
    [openingRun, setOpeningRun] = useState<string>();
  useEffect(() => {
    if (!a.selected || !a.studentId) return;
    const keyName = `xy.entry.${a.studentId}.${a.selected.id}`;
    let entryKey = sessionStorage.getItem(keyName);
    if (!entryKey) {
      entryKey = crypto.randomUUID();
      sessionStorage.setItem(keyName, entryKey);
    }
    let alive = true;
    void api<{ fallback: string; runId?: string }>(
      a.scoped("/api/learning/bootstrap"),
      { method: "POST", ...jsonBody({ revisionId: a.selected.id, entryKey }) },
    )
      .then((r) => {
        if (alive) {
          setGreeting(r.fallback);
          setOpeningRun(r.runId);
        }
      })
      .catch(() => {
        if (alive) setGreeting("今天想从哪里开始？");
      });
    return () => {
      alive = false;
    };
  }, [a.selected?.id, a.studentId]);
  useEffect(() => {
    if (!openingRun) return;
    const events = new EventSource(a.scoped(`/api/runs/${openingRun}/events`));
    let text = "";
    const delta = (e: MessageEvent) => {
      const v = JSON.parse(e.data);
      text += v.data.text;
      setGreeting(text);
    };
    events.addEventListener("text_delta", delta);
    events.addEventListener("message_completed", (e) => {
      const v = JSON.parse((e as MessageEvent).data);
      setGreeting(v.data.content);
    });
    events.addEventListener("done", () => events.close());
    events.addEventListener("failed", () => events.close());
    return () => events.close();
  }, [openingRun, a.studentId]);
  const latest = tasks.data?.find(
    (t) => t.status === "active" || t.status === "paused",
  );
  const start = async (id: string) => {
    if (id === "material_tutoring") {
      navigate("/materials");
      return;
    }
    if (id === "mistake_review") {
      navigate("/mistakes");
      return;
    }
    if (id === "resume") {
      if (latest) navigate(`/study/${latest.id}`);
      else navigate("/history");
      return;
    }
    if (!a.selected) return;
    setBusy(true);
    setError("");
    try {
      const t = await api<TaskDTO>(a.scoped("/api/tasks"), {
        method: "POST",
        ...jsonBody({ revisionId: a.selected.id, kind: id as TaskKind }),
      });
      navigate(`/study/${t.id}`);
    } catch (e) {
      setError(errorMessage(e));
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
      <div className="page-heading">
        <h1>今天，从哪里开始？</h1>
        <p>{greeting || "选一个小目标，一步一步学明白。"}</p>
      </div>
      {error && (
        <p role="alert" className="error-text">
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
      <div className="welcome-layout">
        <section>
          <div className="start-panel">
            <h2>每天一点，学得更扎实。</h2>
            <p>按照当前教材逐题练习，通过提问和反馈，把不确定的地方弄明白。</p>
            <Button
              disabled={busy}
              onClick={() => void start("daily_practice")}
            >
              开始每日5练
              <ArrowRight size={18} />
            </Button>
          </div>
          <div className="study-ways">
            <h2>换一种方式学</h2>
            <div className="action-list">
              {[
                {
                  id: "knowledge_consolidation",
                  label: "知识点巩固",
                  description: "聚焦一个知识点，先诊断，再练习。",
                  icon: Target,
                },
                {
                  id: "mistake_review",
                  label: "错题回顾",
                  description: "从待订正、待巩固和到期复习的题开始。",
                  icon: NotebookPen,
                },
                {
                  id: "material_tutoring",
                  label: "上传题目 / 试卷",
                  description: "把照片或文件变成可以一起讨论的题目。",
                  icon: Files,
                },
                {
                  id: "free_question",
                  label: "自由提问",
                  description: "有哪里没想明白，直接问一问。",
                  icon: MessageCircle,
                },
              ].map(({ id, label, description, icon: Icon }) => (
                <button
                  key={id}
                  className="action-row"
                  disabled={busy}
                  onClick={() => void start(id)}
                >
                  <Icon className="action-icon" size={22} />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
          </div>
        </section>
        <aside className="panel">
          <h2>接着上次学</h2>
          {tasks.loading ? (
            <StatusPanel state="loading" title="正在读取进度" />
          ) : latest ? (
            <>
              <span className="badge">{kindLabels[latest.kind]}</span>
              <p className="muted" style={{ marginTop: 16 }}>
                上次的题目与对话已保存，可以接着往下学。
              </p>
              <Button onClick={() => void start("resume")}>
                <Play size={18} />
                继续上次学习
              </Button>
            </>
          ) : (
            <StatusPanel title="从第一个小目标开始">
              完成一次学习后，这里会保留你的任务进度。
            </StatusPanel>
          )}
          <div className="section-spacer">
            <h3>你的教材</h3>
            <p className="muted">
              {a.selected?.title}
              <br />
              {a.selected?.edition} · {a.selected?.term}
            </p>
            <Button asChild variant="ghost">
              <Link to="/select">
                更换教材
                <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
        </aside>
      </div>
      <div className="mobile-next">
        <NextActions
          actions={[{ id: "resume", label: "继续上次学习" }]}
          onSelect={(id) => void start(id)}
        />
      </div>
    </>
  );
}
