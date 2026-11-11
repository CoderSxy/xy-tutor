import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  KnowledgeBatchDTO,
  KnowledgeItemDTO,
} from "../../../../../packages/contracts/src/knowledge-base.js";
import { useAuth } from "../../lib/auth";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { useRemote } from "../../lib/useRemote";
import { Button } from "../../components/ui/button";
import { Field, Input, Select, Textarea } from "../../components/ui/field";
import { StatusPanel } from "../../components/StatusPanel";
import { UploadInput } from "../../features/uploads/UploadInput";
import { useKnowledgeItems } from "../../features/knowledge-base/api";
import { KnowledgeItemEditor } from "../../features/knowledge-base/ItemEditor";
import {
  knowledgeStatus,
  knowledgeRunStatus,
  REPARSE_SUBMITTED,
} from "../../features/knowledge-base/status";

type BatchList = { items: KnowledgeBatchDTO[]; total: number };

export function Knowledge() {
  const a = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [editing, setEditing] = useState<string>();
  const [reparsing, setReparsing] = useState<string>();
  const [reparsePrompt, setReparsePrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const items = useKnowledgeItems({
    status: statusFilter || undefined,
    q: appliedSearch || undefined,
    limit: 100,
  });
  const batches = useRemote<BatchList>("/api/admin/knowledge/batches?limit=10");

  useEffect(() => {
    if (
      batches.data?.items.some(
        (b) =>
          b.latestRun?.status === "queued" ||
          b.latestRun?.status === "processing",
      )
    ) {
      const timer = setTimeout(() => {
        batches.reload();
        items.reload();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [batches.data, batches.reload, items.reload]);

  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;

  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() && files.length === 0) {
      setError("请粘贴知识点内容或上传资料文件。");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const batch = await api<KnowledgeBatchDTO>("/api/admin/knowledge/batches", {
        method: "POST",
        ...jsonBody({
          ...(text.trim() ? { text: text.trim() } : {}),
          fileIds: files.map((file) => file.id),
          ...(prompt.trim() ? { extraPrompt: prompt.trim() } : {}),
        }),
      });
      navigate(`/admin/knowledge/${batch.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

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
      setEditing(undefined);
      setStatus("知识点已保存");
      items.reload();
      batches.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const submitReparse = async (item: KnowledgeItemDTO) => {
    if (!reparsePrompt.trim()) return;
    setError("");
    try {
      await api(`/api/admin/knowledge/items/${item.id}/reparse`, {
        method: "POST",
        ...jsonBody({ extraPrompt: reparsePrompt.trim() }),
      });
      setReparsing(undefined);
      setReparsePrompt("");
      setStatus(REPARSE_SUBMITTED);
      items.reload();
      batches.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <div className="section-head">
        <div className="page-heading">
          <h1>知识点</h1>
          <p>
            上传资料后由管理员确认，只有确认发布的知识点才会出现在辅导与检索中。
          </p>
        </div>
        <Button onClick={() => setCreating(!creating)}>
          {creating ? "收起上传" : "上传知识点资料"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {creating && (
        <section className="panel">
          <form className="form-stack" onSubmit={create}>
            <Field
              label="粘贴知识点内容"
              hint="可直接粘贴讲义、笔记或教材文字；解析结果会先进入待确认。"
            >
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="例如：同分母分数相加减，分母不变，分子相加减。"
              />
            </Field>
            <Field label="解析提示词（可选）">
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：按知识点拆成独立条目，每条给出简短总结"
              />
            </Field>
          </form>
          {files.length > 0 && (
            <ul className="stack">
              {files.map((file) => (
                <li className="list-row" key={file.id}>
                  <span className="grow">{file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setFiles((current) =>
                        current.filter((item) => item.id !== file.id),
                      )
                    }
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {files.length < 10 && (
            <UploadInput
              purpose="knowledge_source"
              onUploaded={async (id, name) =>
                setFiles((current) =>
                  current.some((file) => file.id === id)
                    ? current
                    : [...current, { id, name: name ?? "资料文件" }],
                )
              }
            />
          )}
          <div className="form-actions">
            <Button
              disabled={busy || (!text.trim() && files.length === 0)}
              onClick={() => void create()}
            >
              {busy ? "正在提交…" : "解析为知识点"}
            </Button>
          </div>
        </section>
      )}
      <section className="panel section-spacer">
        <div className="section-head">
          <h2>最近解析批次</h2>
        </div>
        {batches.loading && !batches.data ? (
          <StatusPanel state="loading" title="正在读取解析批次" />
        ) : batches.data?.items.length ? (
          batches.data.items.map((batch) => (
            <div className="list-row" key={batch.id}>
              <div className="grow">
                <h3>
                  {batch.textContent
                    ? batch.textContent.slice(0, 40)
                    : `${batch.files.length} 个资料文件`}
                </h3>
                <p className="muted text-small">
                  {new Date(batch.createdAt).toLocaleString()} · 待确认{" "}
                  {batch.pendingCount} · 已发布 {batch.publishedCount}
                </p>
                {batch.latestRun?.notice && (
                  <p className="notice">{batch.latestRun.notice}</p>
                )}
              </div>
              <span className="badge">
                {batch.latestRun
                  ? knowledgeRunStatus[batch.latestRun.status]
                  : "等待解析"}
              </span>
              <Button asChild variant="outline">
                <Link to={`/admin/knowledge/${batch.id}`}>查看批次</Link>
              </Button>
            </div>
          ))
        ) : (
          <p className="muted">还没有解析批次。</p>
        )}
      </section>
      <section className="panel section-spacer">
        <div className="section-head">
          <h2>知识点列表</h2>
          <div className="row-actions">
            <Field label="状态">
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">全部</option>
                <option value="pending_review">待确认</option>
                <option value="published">已发布</option>
                <option value="discarded">已丢弃</option>
              </Select>
            </Field>
            <form
              className="row-actions"
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedSearch(search.trim());
              }}
            >
              <Field label="搜索">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="标题或总结"
                />
              </Field>
              <Button type="submit" variant="outline">
                搜索
              </Button>
            </form>
          </div>
        </div>
        {items.loading && !items.data ? (
          <StatusPanel state="loading" title="正在读取知识点" />
        ) : items.error ? (
          <StatusPanel state="error" title={items.error} onRetry={items.reload} />
        ) : items.data?.items.length ? (
          items.data.items.map((item) => (
            <div className="list-row" key={item.id}>
              <div className="grow">
                <h3>{item.title}</h3>
                <p>{item.summary}</p>
                <small className="muted">
                  更新于 {new Date(item.updatedAt).toLocaleString()}
                </small>
              </div>
              <span className="badge">{knowledgeStatus[item.status]}</span>
              {editing !== item.id && (
                <div className="row-actions">
                  {item.status !== "discarded" && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setReparsing(undefined);
                        setEditing(item.id);
                      }}
                    >
                      编辑
                    </Button>
                  )}
                  {item.status === "published" && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEditing(undefined);
                        setReparsing(item.id);
                      }}
                    >
                      再解析
                    </Button>
                  )}
                </div>
              )}
              {editing === item.id && (
                <div className="panel section-spacer">
                  <KnowledgeItemEditor
                    item={item}
                    onSave={(patch) => saveItem(item, patch)}
                    onCancel={() => setEditing(undefined)}
                  />
                </div>
              )}
              {reparsing === item.id && (
                <div className="panel section-spacer">
                  <Field
                    label="补充解析要求"
                    hint="重新解析会带上这一条和同一批原始资料。确认后第一条更新当前知识点，拆出来的其余条目作为新知识点。"
                  >
                    <Textarea
                      value={reparsePrompt}
                      onChange={(e) => setReparsePrompt(e.target.value)}
                      placeholder="例如：根据原文把通分步骤写完整"
                    />
                  </Field>
                  <div className="form-actions">
                    <Button
                      disabled={!reparsePrompt.trim()}
                      onClick={() => void submitReparse(item)}
                    >
                      提交再解析
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setReparsing(undefined);
                        setReparsePrompt("");
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        ) : (
          <StatusPanel
            title={
              statusFilter || appliedSearch
                ? "没有符合条件的知识点"
                : "还没有知识点"
            }
          >
            {statusFilter || appliedSearch
              ? "换一个状态或关键词试试。"
              : "先上传一份资料，解析后逐条确认发布。"}
          </StatusPanel>
        )}
      </section>
    </>
  );
}
