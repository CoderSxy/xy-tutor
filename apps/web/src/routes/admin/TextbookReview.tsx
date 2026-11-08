import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useRemote } from "../../lib/useRemote";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { RevisionDTO } from "../../lib/types";
import { Button } from "../../components/ui/button";
import { Field, Input, Textarea, Select } from "../../components/ui/field";
import { StatusPanel } from "../../components/StatusPanel";
import { DocumentViewer } from "../../features/uploads/DocumentViewer";
import { textbookStatus, textbookParseError } from "./Textbooks";
type PageRecord = {
  id: string;
  pageIndex: number;
  printedPageLabel: string | null;
  text: string;
  status: string;
  excluded: boolean;
};
export function TextbookReview() {
  const a = useAuth(),
    { id } = useParams();
  const revision = useRemote<RevisionDTO>(
    id ? `/api/catalog/textbooks/${id}` : null,
  );
  const pages = useRemote<PageRecord[]>(
    id ? `/api/catalog/textbooks/${id}/pages` : null,
  );
  const [pageIndex, setPageIndex] = useState(0),
    [text, setText] = useState(""),
    [printedLabel, setPrintedLabel] = useState(""),
    [chapter, setChapter] = useState(""),
    [excluded, setExcluded] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [view, setView] = useState(false);
  useEffect(() => {
    const p = pages.data?.find((p) => p.pageIndex === pageIndex);
    if (p) {
      setText(p.text);
      setPrintedLabel(p.printedPageLabel ?? "");
      setExcluded(p.excluded);
    }
  }, [pages.data, pageIndex]);
  useEffect(() => {
    if (revision.data?.status === "processing") {
      const t = setTimeout(() => {
        revision.reload();
        pages.reload();
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [revision.data]);
  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;
  if (revision.loading && !revision.data)
    return <StatusPanel state="loading" title="正在读取教材" />;
  if (revision.error || !revision.data)
    return <StatusPanel state="error" title={revision.error || "教材不存在"} />;
  const r = revision.data;
  const action = async (kind: "publish" | "disable" | "process") => {
    setError("");
    try {
      await api(`/api/admin/textbooks/${id}/${kind}`, { method: "POST" });
      revision.reload();
      pages.reload();
      setStatus("教材状态已更新");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const save = async () => {
    setError("");
    try {
      await api(`/api/admin/textbooks/${id}/pages`, {
        method: "PATCH",
        ...jsonBody({
          pageIndex,
          text,
          printedPageLabel: printedLabel,
          excluded,
          ...(chapter.trim() ? { chapter } : {}),
        }),
      });
      pages.reload();
      setStatus("本页检查结果已保存");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <div className="page-heading">
        <h1>{r.title}</h1>
        <p>
          {r.edition} · {r.grade} · {r.subject} · {r.term} · 修订{r.revisionNo}
        </p>
      </div>
      <div className="section-head">
        <span className="badge">
          {textbookStatus[r.status]} · 已处理 {pages.data?.length ?? 0} 页
        </span>
        <div className="row-actions">
          <Button variant="outline" onClick={() => setView(true)}>
            核对原始 PDF
          </Button>
          {r.status === "review" && (
            <Button onClick={() => void action("publish")}>发布教材</Button>
          )}
          {r.status === "published" && (
            <Button variant="danger" onClick={() => void action("disable")}>
              停用教材
            </Button>
          )}
          {(r.status === "draft" || r.status === "failed") && (
            <Button onClick={() => void action("process")}>
              开始 / 重试解析
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {r.status === "failed" && (
        <p className="notice error-text" role="alert">
          {textbookParseError(r.parseErrorCode)}
        </p>
      )}
      {r.status === "processing" && (
        <StatusPanel state="queued" title="教材正在分批解析">
          可以稍后回来检查，已处理页面会逐步显示。
        </StatusPanel>
      )}
      {pages.data?.length ? (
        <section className="panel">
          <div className="form-grid">
            <Field label="PDF 页面">
              <Select
                value={pageIndex}
                onChange={(e) => setPageIndex(Number(e.target.value))}
              >
                {pages.data.map((p) => (
                  <option key={p.id} value={p.pageIndex}>
                    第{p.pageIndex + 1}页 ·{" "}
                    {p.excluded
                      ? "已排除"
                      : p.status === "ready"
                        ? "可用"
                        : "需处理"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="书上印刷页码">
              <Input
                disabled={r.status !== "review"}
                value={printedLabel}
                onChange={(e) => setPrintedLabel(e.target.value)}
              />
            </Field>
            <Field label="章节 / 知识点标签">
              <Input
                disabled={r.status !== "review"}
                value={chapter}
                onChange={(e) => setChapter(e.target.value)}
                placeholder="例如：分数的基本性质"
              />
            </Field>
          </div>
          <div className="section-spacer">
            <Field label="本页提取内容">
              <Textarea
                className="textbook-text"
                disabled={r.status !== "review"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </div>
          <label className="checkline">
            <input
              type="checkbox"
              disabled={r.status !== "review"}
              checked={excluded}
              onChange={(e) => setExcluded(e.target.checked)}
            />
            明确排除此页（不会用于教学检索）
          </label>
          <Button disabled={r.status !== "review"} onClick={() => void save()}>
            保存本页检查
          </Button>
          <p className="muted text-small">
            发布后内容不可原位修改。更正时上传新修订，旧会话仍可追溯原引用。
          </p>
        </section>
      ) : (
        r.status !== "processing" && (
          <StatusPanel title="暂无可检查页面">
            先开始解析；扫描教材需要 OCR 或人工补充文字。
          </StatusPanel>
        )
      )}
      <DocumentViewer
        fileId={view ? r.fileId : undefined}
        pageIndex={pageIndex}
        onClose={() => setView(false)}
      />
    </>
  );
}
