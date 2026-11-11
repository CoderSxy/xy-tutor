import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Search, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { usePaged } from "../lib/usePaged";
import type { TaskDTO } from "../lib/types";
import { kindLabels } from "../lib/types";
import { fullDate, sessionTitle, statusLabels } from "../lib/taskFormat";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";

export function TaskHistory() {
  const a = useAuth();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const path = a.studentId
    ? a.scoped(`/api/tasks${query ? `?q=${encodeURIComponent(query)}` : ""}`)
    : null;
  const paged = usePaged<TaskDTO>(path, 10);
  const filtered = !!query;
  return (
    <section className="panel history-panel">
      <div className="history-toolbar">
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
          paged.items.map((t) => (
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
                  未绑定教材
                </p>
              </div>
              <Button asChild variant="outline">
                <Link to={`/study/${t.id}`}>
                  {t.status === "completed" ? "查看记录" : "继续学习"}
                </Link>
              </Button>
            </div>
          ))
        ) : (
          <StatusPanel
            title={filtered ? "没有符合条件的学习记录" : "还没有学习记录"}
          >
            {filtered
              ? "换一个搜索词试试。"
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
