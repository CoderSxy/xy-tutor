import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { useRemote } from "../lib/useRemote";
import { api, jsonBody, errorMessage } from "../lib/api";
import type { TaskDTO } from "../lib/types";
import { originLabels, stateLabels } from "../lib/types";
import type { MistakePage } from "../../../../packages/contracts/src/mistakes.js";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { Markdown } from "../components/Markdown";
import { ListPager } from "../features/student-insights/ListPager";

const PAGE_SIZE = 20;

export function Mistakes() {
  const a = useAuth(),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const origin = params.get("origin") ?? "";
  const status = params.get("status") ?? "";
  const archive = params.get("includeArchived") === "true";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    includeArchived: archive ? "true" : "false",
  });
  if (origin) query.set("origin", origin);
  if (status) query.set("status", status);
  const list = useRemote<MistakePage>(
    a.studentId ? a.scoped(`/api/mistakes?${query}`) : null,
  );
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    if ("origin" in patch || "status" in patch || "includeArchived" in patch)
      next.set("page", "1");
    setParams(next);
  };
  const start = async (id: string, questionVersionId: string) => {
    setBusy(id);
    setError("");
    try {
      const task = await api<TaskDTO>(a.scoped("/api/tasks"), {
        method: "POST",
        ...jsonBody({ kind: "mistake_review" }),
      });
      await api(a.scoped(`/api/tasks/${task.id}/attach-questions`), {
        method: "POST",
        ...jsonBody({ questionVersionIds: [questionVersionId] }),
      });
      await api(a.scoped(`/api/mistakes/${id}/start`), { method: "POST" });
      navigate(`/study/${task.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const counts = list.data?.originCounts;
  const rows = list.data?.items ?? [];
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
      <div className="filter-bar" role="tablist" aria-label="错题来源">
        {(
          [
            ["", "全部", counts?.all],
            ["uploaded", "上传错题", counts?.uploaded],
            ["learning", "学习错题", counts?.learning],
          ] as const
        ).map(([value, label, count]) => (
          <Button
            key={value || "all"}
            role="tab"
            aria-selected={origin === value}
            variant={origin === value ? "primary" : "outline"}
            onClick={() => update({ origin: value || null })}
          >
            {label}
            {typeof count === "number" ? ` ${count}` : ""}
          </Button>
        ))}
      </div>
      <div className="filter-bar">
        <label className="checkline">
          <input
            type="checkbox"
            checked={archive}
            onChange={(e) =>
              update({ includeArchived: e.target.checked ? "true" : null })
            }
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
                checked={status === value}
                onChange={() => update({ status: value || null })}
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
      ) : rows.length ? (
        <div className="list-stack">
          {rows.map((m) => (
            <article className="panel mistake-card" key={m.id}>
              <div className="section-head">
                <span className="badge">{stateLabels[m.status]}</span>
                <span className="badge">
                  {originLabels[m.originCategory] ?? m.originCategory}
                </span>
                {m.hasImageEvidence && <span className="badge">图片作答</span>}
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
                <Button
                  disabled={!!busy}
                  onClick={() => void start(m.id, m.questionVersionId)}
                >
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
          <ListPager
            total={list.data?.total ?? 0}
            limit={PAGE_SIZE}
            offset={(page - 1) * PAGE_SIZE}
            onChange={(offset) =>
              update({ page: String(Math.floor(offset / PAGE_SIZE) + 1) })
            }
            busy={list.loading}
          />
        </div>
      ) : (
        <StatusPanel
          title={status || origin ? "没有符合筛选条件的错题" : "目前没有需要处理的错题"}
        >
          可以上传一道错题，或者开始练习；原始作答和每次订正都会保留。
        </StatusPanel>
      )}
    </>
  );
}
