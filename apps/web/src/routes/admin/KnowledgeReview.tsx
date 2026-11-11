import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { KnowledgeItemDTO } from "../../../../../packages/contracts/src/knowledge-base.js";
import { useAuth } from "../../lib/auth";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Field, Textarea } from "../../components/ui/field";
import { StatusPanel } from "../../components/StatusPanel";
import {
  useKnowledgeBatch,
  useKnowledgeItems,
} from "../../features/knowledge-base/api";
import { KnowledgeItemEditor } from "../../features/knowledge-base/ItemEditor";
import {
  knowledgeStatus,
  knowledgeRunStatus,
  knowledgeParseError,
  REPARSE_SUBMITTED,
} from "../../features/knowledge-base/status";

export function KnowledgeReview() {
  const a = useAuth();
  const { batchId } = useParams();
  const batch = useKnowledgeBatch(batchId);
  const items = useKnowledgeItems({ batchId, limit: 100 });
  const publishedItems = useKnowledgeItems({
    batchId,
    status: "published",
    limit: 100,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [reparsePrompt, setReparsePrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const runStatus = batch.data?.latestRun?.status;
  useEffect(() => {
    if (runStatus === "queued" || runStatus === "processing") {
      const timer = setTimeout(() => {
        batch.reload();
        items.reload();
        publishedItems.reload();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [runStatus, batch.reload, items.reload, publishedItems.reload]);

  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;
  if (batch.loading && !batch.data)
    return <StatusPanel state="loading" title="正在读取解析批次" />;
  if (batch.error || !batch.data)
    return (
      <StatusPanel
        state="error"
        title={batch.error || "解析批次不存在"}
        onRetry={batch.reload}
      />
    );

  const batchData = batch.data;
  const run = batchData.latestRun;
  const publishedTitle = new Map(
    (publishedItems.data?.items ?? []).map((item) => [item.id, item.title]),
  );
  const pending = (items.data?.items ?? []).filter(
    (item) => item.status === "pending_review",
  );
  const toggle = (id: string) =>
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );

  const saveItem = async (
    item: KnowledgeItemDTO,
    patch: { title: string; summary: string },
  ) => {
    setError("");
    try {
      await api(`/api/admin/knowledge/items/${item.id}`, {
        method: "PATCH",
        ...jsonBody(patch),
      });
      setStatus("知识点已保存");
      items.reload();
      publishedItems.reload();
      batch.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const publish = async () => {
    if (!selected.length) return;
    setBusy(true);
    setError("");
    try {
      const published = await api<KnowledgeItemDTO[]>(
        "/api/admin/knowledge/items/publish",
        { method: "POST", ...jsonBody({ ids: selected }) },
      );
      setSelected([]);
      setStatus(`已发布 ${published.length} 个知识点`);
      items.reload();
      publishedItems.reload();
      batch.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!selected.length) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/knowledge/items/discard", {
        method: "POST",
        ...jsonBody({ ids: selected }),
      });
      setStatus(`已丢弃 ${selected.length} 个知识点`);
      setSelected([]);
      items.reload();
      publishedItems.reload();
      batch.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitReparse = async () => {
    if (!reparsePrompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/knowledge/batches/${batchId}/reparse`, {
        method: "POST",
        ...jsonBody({ extraPrompt: reparsePrompt.trim() }),
      });
      setReparsePrompt("");
      setStatus(REPARSE_SUBMITTED);
      batch.reload();
      items.reload();
      publishedItems.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-head">
        <div className="page-heading">
          <h1>检查知识点</h1>
          <p>
            逐条修改标题与总结后确认发布；未确认的内容不会展示给学生。
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/admin/knowledge">返回知识点列表</Link>
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      <div className="section-head">
        <span className="badge">
          {run ? knowledgeRunStatus[run.status] : "等待解析"} · 待确认{" "}
          {batchData.pendingCount} · 已发布 {batchData.publishedCount}
        </span>
      </div>
      {run?.notice && <p className="notice">{run.notice}</p>}
      {run?.status === "failed" && (
        <p className="notice error-text" role="alert">
          {knowledgeParseError(run.errorCode)}
        </p>
      )}
      {(run?.status === "queued" || run?.status === "processing") && (
        <StatusPanel state="queued" title="正在解析知识点">
          解析完成后条目会出现在下方，确认发布前不会对学生可见。
        </StatusPanel>
      )}
      {batchData.textContent && (
        <section className="panel">
          <p className="muted text-small">资料文本</p>
          <p>{batchData.textContent}</p>
        </section>
      )}
      {batchData.files.length > 0 && (
        <section className="panel">
          <p className="muted text-small">资料文件</p>
          <p>
            {batchData.files.map((file) => file.name).join("、")}
          </p>
        </section>
      )}
      <section className="panel section-spacer">
        <div className="section-head">
          <h2>待确认知识点</h2>
          <div className="row-actions">
            <Button
              disabled={!selected.length || busy}
              onClick={() => void publish()}
            >
              确认发布所选
            </Button>
            <Button
              variant="danger"
              disabled={!selected.length || busy}
              onClick={() => void discard()}
            >
              丢弃所选
            </Button>
          </div>
        </div>
        {items.loading && !items.data ? (
          <StatusPanel state="loading" title="正在读取知识点" />
        ) : items.error ? (
          <StatusPanel
            state="error"
            title={items.error}
            onRetry={items.reload}
          />
        ) : pending.length ? (
          pending.map((item, index) => (
            <div className="list-row" key={item.id}>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={() => toggle(item.id)}
                  aria-label={`选择 ${item.title}`}
                />
                选择此知识点
              </label>
              <span className="badge">{knowledgeStatus[item.status]}</span>
              {item.replacesItemId ? (
                <p className="muted text-small">
                  确认后将更新「
                  {publishedTitle.get(item.replacesItemId) ?? "已发布知识点"}
                  」，不另外新增。
                </p>
              ) : batchData.publishedCount > 0 ? (
                <p className="muted text-small">
                  确认后将新增一条，已发布的知识点会保留。
                </p>
              ) : null}
              <div className="grow">
                <KnowledgeItemEditor
                  item={item}
                  suffix={` ${index + 1}`}
                  onSave={(patch) => saveItem(item, patch)}
                />
              </div>
            </div>
          ))
        ) : (
          <StatusPanel title="没有待确认的知识点">
            {run?.status === "failed"
              ? "修正资料或补充要求后重新解析。"
              : "解析完成或已全部确认，可返回列表查看已发布内容。"}
          </StatusPanel>
        )}
      </section>
      <section className="panel section-spacer">
        <Field
          label="补充解析要求"
          hint="重新解析会带上原始资料。标明了原标题的条目，确认后就地更新那一条；没有对应到来源的，确认后会新增，已发布内容仍保留。"
        >
          <Textarea
            value={reparsePrompt}
            onChange={(e) => setReparsePrompt(e.target.value)}
            placeholder="例如：把通分步骤拆得更细"
          />
        </Field>
        <div className="form-actions">
          <Button
            disabled={!reparsePrompt.trim() || busy}
            onClick={() => void submitReparse()}
          >
            提交再解析
          </Button>
        </div>
      </section>
    </>
  );
}
