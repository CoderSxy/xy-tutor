import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { usePaged } from "../lib/usePaged";
import type { TaskDTO } from "../lib/types";
import { kindLabels } from "../lib/types";
import { sessionTitle, shortDate, statusLabels } from "../lib/taskFormat";
import { StatusPanel } from "./StatusPanel";

export function SessionRail({
  currentId,
  refreshKey,
  onTaskChange,
}: {
  currentId?: string;
  refreshKey?: string;
  onTaskChange?: () => void;
}) {
  const a = useAuth();
  const navigate = useNavigate();
  const tasks = usePaged<TaskDTO>(
    a.studentId ? a.scoped("/api/tasks") : null,
    10,
  );
  useEffect(() => {
    tasks.reload();
  }, [refreshKey, tasks.reload]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editingId, setEditingId] = useState(""),
    [editText, setEditText] = useState(""),
    [confirmId, setConfirmId] = useState("");
  const sessions = tasks.items;
  const listRef = useRef<HTMLDivElement>(null);
  const lastLoad = useRef(0);
  const loadTimer = useRef<number | undefined>(undefined);
  const loadMoreRef = useRef(tasks.loadMore);
  loadMoreRef.current = tasks.loadMore;
  const loadNext = useCallback(() => {
    const run = () => {
      lastLoad.current = Date.now();
      void loadMoreRef.current();
    };
    const wait = 400 - (Date.now() - lastLoad.current);
    if (wait > 0) {
      window.clearTimeout(loadTimer.current);
      loadTimer.current = window.setTimeout(run, wait);
      return;
    }
    run();
  }, []);
  useEffect(() => () => window.clearTimeout(loadTimer.current), []);
  useEffect(() => {
    const el = listRef.current;
    if (!el || tasks.loading || !tasks.hasMore) return;
    if (el.scrollHeight <= el.clientHeight + 4) loadNext();
  }, [tasks.loading, tasks.hasMore, sessions.length, loadNext]);
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 160) return;
    loadNext();
  };
  const open = async (t: TaskDTO) => {
    if (t.status === "paused") {
      try {
        const latest = await api<TaskDTO>(a.scoped(`/api/tasks/${t.id}`));
        await api(a.scoped(`/api/tasks/${t.id}`), {
          method: "PATCH",
          ...jsonBody({ expectedVersion: latest.version, status: "active" }),
        });
        tasks.reload();
        if (t.id === currentId) onTaskChange?.();
      } catch {
        // 恢复失败时仍可打开会话，由学习页给出提示
      }
    }
    navigate(`/study/${t.id}`);
  };
  const rename = async (t: TaskDTO) => {
    const title = editText.trim();
    if (!title) return;
    setBusy(true);
    setError("");
    try {
      await api(a.scoped(`/api/tasks/${t.id}/title`), {
        method: "PATCH",
        ...jsonBody({ title }),
      });
      setEditingId("");
      tasks.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (t: TaskDTO) => {
    setBusy(true);
    setError("");
    try {
      await api(a.scoped(`/api/tasks/${t.id}`), { method: "DELETE" });
      setConfirmId("");
      tasks.reload();
      if (t.id === currentId) navigate("/");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="session-rail" aria-label="历史学习会话">
      <header className="session-rail-head">
        <h2>学习会话</h2>
        <span className="session-rail-count">
          {tasks.loading
            ? "读取中…"
            : tasks.total
              ? `${tasks.total} 个会话`
              : "暂无会话"}
        </span>
      </header>
      {error && (
        <p role="alert" className="session-rail-error error-text">
          {error}
        </p>
      )}
      <div className="session-list" ref={listRef} onScroll={onScroll}>
        {tasks.loading ? (
          <StatusPanel state="loading" title="正在读取会话" />
        ) : tasks.error && !sessions.length ? (
          <StatusPanel
            state="error"
            title={tasks.error}
            onRetry={tasks.reload}
          />
        ) : sessions.length ? (
          <>
            {sessions.map((t) => (
              <article
                key={t.id}
                className={`session-item ${t.id === currentId ? "is-active" : ""}`}
              >
                {editingId === t.id ? (
                  <form
                    className="session-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(t);
                    }}
                  >
                    <input
                      autoFocus
                      value={editText}
                      maxLength={80}
                      aria-label="会话标题"
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditingId("");
                      }}
                    />
                    <button
                      type="submit"
                      aria-label="保存标题"
                      disabled={busy || !editText.trim()}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label="取消"
                      onClick={() => setEditingId("")}
                    >
                      <X size={15} />
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="session-open"
                    onClick={() => void open(t)}
                  >
                    <span className="session-title">{sessionTitle(t)}</span>
                    <span className="session-meta">
                      <span className={`session-dot ${t.status}`} />
                      {kindLabels[t.kind]} · {statusLabels[t.status]} ·{" "}
                      {shortDate(t.updatedAt)}
                    </span>
                  </button>
                )}
                {editingId !== t.id && (
                  <div className="session-actions">
                    <button
                      type="button"
                      aria-label="重命名会话"
                      title="重命名"
                      onClick={() => {
                        setConfirmId("");
                        setEditText(t.title?.trim() || sessionTitle(t));
                        setEditingId(t.id);
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label="删除学习会话"
                      title="删除会话"
                      onClick={() => setConfirmId(t.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
                {confirmId === t.id && (
                  <div className="session-confirm" role="alert">
                    <span>删除后不再显示，确定吗？</span>
                    <div>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => void remove(t)}
                      >
                        删除
                      </button>
                      <button type="button" onClick={() => setConfirmId("")}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
            {tasks.loadingMore && <p className="session-more">正在加载更多…</p>}
            {tasks.error && (
              <p className="session-more error-text">{tasks.error}</p>
            )}
          </>
        ) : (
          <StatusPanel title="还没有学习会话">
            在右侧说出想学的内容，或选一个快捷入口开始。
          </StatusPanel>
        )}
      </div>
    </aside>
  );
}
