import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Search, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { usePaged } from "../lib/usePaged";
import type { TaskDTO } from "../lib/types";
import { kindLabels } from "../lib/types";
import {
  bookMeta,
  fullDate,
  sessionTitle,
  statusLabels,
} from "../lib/taskFormat";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";

export function TaskHistory() {
  const a = useAuth();
  const [revisionId, setRevisionId] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams();
  if (revisionId) params.set("revisionId", revisionId);
  if (query) params.set("q", query);
  const suffix = params.toString();
  const path = a.studentId
    ? a.scoped(`/api/tasks${suffix ? `?${suffix}` : ""}`)
    : null;
  const paged = usePaged<TaskDTO>(path, 10);
  const revisions = new Map(a.catalog.map((r) => [r.id, r]));
  const tabs = a.selectionHistory.map((s) => ({
    id: s.revisionId,
    label: `${s.grade} · ${s.subject}`,
    title: s.title,
  }));
  const filtered = !!revisionId || !!query;
  return (
    <section className="panel history-panel">
      <div className="history-toolbar">
        <div className="history-tabs" role="tablist" aria-label="按教材筛选">
          <button
            type="button"
            role="tab"
            aria-selected={!revisionId}
            className={`history-tab ${revisionId ? "" : "is-active"}`}
            onClick={() => setRevisionId("")}
          >
            全部
          </button>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              title={tab.title}
              aria-selected={revisionId === tab.id}
              className={`history-tab ${revisionId === tab.id ? "is-active" : ""}`}
              onClick={() => setRevisionId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <label className="history-search">
          <Search size={15} aria-hidden />
          <input
            type="text"
            value={search}
            maxLength={80}
            placeholder="搜索标题或对话内容"
            aria-label="搜索学习记录"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setSearch("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      <div className="history-list">
        {paged.loading ? (
          <StatusPanel state="loading" title="正在加载学习记录" />
        ) : paged.error ? (
          <StatusPanel
            state="error"
            title={paged.error}
            onRetry={paged.reload}
          />
        ) : paged.items.length ? (
          paged.items.map((t) => {
            const rev = revisions.get(t.revisionId);
            return (
              <div className="list-row" key={t.id}>
                <div className="history-info">
                  <h3>{sessionTitle(t)}</h3>
                  <p className="history-meta">
                    <span className={`session-dot ${t.status}`} />
                    {kindLabels[t.kind]} · {statusLabels[t.status]} ·{" "}
                    {fullDate(t.updatedAt)}
                  </p>
                  <p className="history-book">
                    <BookOpen size={14} />
                    {rev
                      ? `${rev.title} · ${bookMeta(rev)}`
                      : a.catalogLoading
                        ? "正在读取教材信息"
                        : "教材信息已不可用"}
                  </p>
                </div>
                <Button asChild variant="outline">
                  <Link to={`/study/${t.id}`}>
                    {t.status === "completed" ? "查看记录" : "继续学习"}
                  </Link>
                </Button>
              </div>
            );
          })
        ) : (
          <StatusPanel
            title={filtered ? "没有符合条件的学习记录" : "还没有学习记录"}
          >
            {filtered
              ? "换个教材标签，或者换一个搜索词试试。"
              : "从首页开始一个任务，进度会自动保存在这里。"}
          </StatusPanel>
        )}
      </div>
      {!paged.loading && !paged.error && paged.pageCount > 1 && (
        <div className="history-pager">
          <span>
            共 {paged.total} 条 · 第 {paged.page + 1} / {paged.pageCount} 页
          </span>
          <div className="history-pager-actions">
            {paged.page > 0 && (
              <Button
                variant="outline"
                size="small"
                onClick={() => void paged.goTo(paged.page - 1)}
              >
                上一页
              </Button>
            )}
            {paged.page + 1 < paged.pageCount && (
              <Button
                variant="outline"
                size="small"
                onClick={() => void paged.goTo(paged.page + 1)}
              >
                下一页
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
