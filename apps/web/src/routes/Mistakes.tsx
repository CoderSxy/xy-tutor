import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useRemote } from "../lib/useRemote";
import { api, jsonBody, errorMessage } from "../lib/api";
import type { MistakeDTO, TaskDTO } from "../lib/types";
import { stateLabels } from "../lib/types";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { Markdown } from "../components/Markdown";
export function Mistakes() {
  const a = useAuth(),
    navigate = useNavigate();
  const [archive, setArchive] = useState(false),
    [state, setState] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const list = useRemote<MistakeDTO[]>(
    a.studentId ? a.scoped(`/api/mistakes?includeArchived=${archive}`) : null,
  );
  const start = async (m: MistakeDTO) => {
    setBusy(m.id);
    setError("");
    try {
      const q = await api<{ revisionId: string }>(
        a.scoped(`/api/question-versions/${m.questionVersionId}`),
      );
      const task = await api<TaskDTO>(a.scoped("/api/tasks"), {
        method: "POST",
        ...jsonBody({ revisionId: q.revisionId, kind: "mistake_review" }),
      });
      await api(a.scoped(`/api/tasks/${task.id}/attach-questions`), {
        method: "POST",
        ...jsonBody({ questionVersionIds: [m.questionVersionId] }),
      });
      await api(a.scoped(`/api/mistakes/${m.id}/start`), { method: "POST" });
      navigate(`/study/${task.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const rows = list.data?.filter((m) => !state || m.status === state);
  const stateOptions: [string, string][] = [
    ["", "全部状态"],
    ...Object.entries(stateLabels),
  ];
  return (
    <>
      <div className="page-heading">
        <h1>我的错题</h1>
        <p>保留每一次尝试，把订正、巩固和真正掌握分开来看。</p>
      </div>
      <div className="filter-bar">
        <label className="checkline">
          <input
            type="checkbox"
            checked={archive}
            onChange={(e) => setArchive(e.target.checked)}
          />
          包含已掌握归档
        </label>
        <div className="filter-radios" role="group" aria-label="学习状态">
          <span className="filter-label">学习状态</span>
          {stateOptions.map(([value, label]) => (
            <label className="radio-option" key={value || "all"}>
              <input
                type="radio"
                name="mistake-state"
                value={value}
                checked={state === value}
                onChange={() => setState(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {list.loading ? (
        <StatusPanel state="loading" title="正在读取错题" />
      ) : list.error ? (
        <StatusPanel state="error" title={list.error} onRetry={list.reload} />
      ) : rows?.length ? (
        <div className="list-stack">
          {rows.map((m) => (
            <article className="panel mistake-card" key={m.id}>
              <div className="section-head">
                <span className="badge">{stateLabels[m.status]}</span>
                {m.dueAt && (
                  <small className="muted">
                    复习时间：
                    {new Date(m.dueAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </small>
                )}
              </div>
              <Markdown>{m.stem}</Markdown>
              <div className="form-actions">
                <Button disabled={!!busy} onClick={() => void start(m)}>
                  {busy === m.id
                    ? "正在准备…"
                    : m.status === "mastered"
                      ? "重新练习"
                      : "开始订正 / 复习"}
                </Button>
                <Button asChild variant="ghost">
                  <Link to={`/mistakes/${m.id}`}>查看历史与来源</Link>
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <StatusPanel
          title={state ? "没有符合筛选条件的错题" : "目前没有需要处理的错题"}
        >
          可以上传一道错题，或者开始练习；原始作答和每次订正都会保留。
        </StatusPanel>
      )}
    </>
  );
}
