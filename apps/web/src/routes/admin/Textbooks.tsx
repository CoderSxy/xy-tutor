import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useRemote } from "../../lib/useRemote";
import { api, jsonBody, errorMessage } from "../../lib/api";
import type { RevisionDTO } from "../../lib/types";
import { Button } from "../../components/ui/button";
import { Field, Input, Select } from "../../components/ui/field";
import { UploadInput } from "../../features/uploads/UploadInput";
import { StatusPanel } from "../../components/StatusPanel";
export const textbookStatus: Record<string, string> = {
  draft: "草稿",
  processing: "解析中",
  review: "待检查",
  published: "已发布",
  disabled: "已停用",
  failed: "解析失败",
};
export function textbookParseError(code?: string | null): string {
  const reasons: Record<string, string> = {
    PDF_PAGE_LIMIT: "教材超过500页，请按册拆分后重新上传。",
    FILE_SIZE_LIMIT: "教材PDF必须小于50MB，请压缩文件或按册拆分后重新上传。",
    PDF_PARSE_FAILED: "无法读取该PDF，请检查文件是否损坏、加密或含异常页面。",
    IMAGE_PIXEL_LIMIT: "教材中有尺寸过大的页面，请压缩页面后重试。",
    OCR_IMAGE_LIMIT: "扫描页图片超过识别限制，请压缩页面后重试。",
    OCR_UNAVAILABLE: "扫描页识别失败，请检查OCR权限、额度和网络后重试。",
    PARSE_OUTPUT_LIMIT: "单页解析结果过大，请拆分或简化该页面后重试。",
  };
  return (
    reasons[code ?? ""] ??
    "教材解析未完成，请重试；若仍失败，请检查文件或联系管理员。"
  );
}
export function Textbooks() {
  const a = useAuth(),
    navigate = useNavigate();
  const list = useRemote<RevisionDTO[]>(
    a.session?.actor.role === "admin" ? "/api/admin/textbooks" : null,
  );
  const [creating, setCreating] = useState(false),
    [form, setForm] = useState({
      title: "",
      edition: "人教版",
      grade: "五年级",
      subject: "数学",
      term: "下册",
      publicationYear: 2024,
    }),
    [fileId, setFileId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (list.data?.some((r) => r.status === "processing")) {
      const timer = setTimeout(list.reload, 2500);
      return () => clearTimeout(timer);
    }
  }, [list.data, list.reload]);
  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!fileId) return;
    setBusy(true);
    try {
      const r = await api<RevisionDTO>("/api/admin/textbooks", {
        method: "POST",
        ...jsonBody({ ...form, fileId }),
      });
      await api(`/api/admin/textbooks/${r.id}/process`, { method: "POST" });
      navigate(`/admin/textbooks/${r.id}`);
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
          <h1>教材管理</h1>
          <p>上传、核对并发布教材，学生只会选到已发布内容。</p>
        </div>
        <Button onClick={() => setCreating(!creating)}>
          {creating ? "收起上传" : "上传电子教材"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {creating && (
        <section className="panel">
          <form className="form-stack" onSubmit={save}>
            <div className="form-grid">
              {(["title", "edition", "grade", "subject"] as const).map(
                (key) => (
                  <Field
                    key={key}
                    label={
                      {
                        title: "教材名称",
                        edition: "教材版本",
                        grade: "年级",
                        subject: "科目",
                      }[key]
                    }
                  >
                    <Input
                      required
                      value={form[key]}
                      onChange={(e) =>
                        setForm({ ...form, [key]: e.target.value })
                      }
                    />
                  </Field>
                ),
              )}
              <Field label="册次">
                <Select
                  value={form.term}
                  onChange={(e) => setForm({ ...form, term: e.target.value })}
                >
                  <option>上册</option>
                  <option>下册</option>
                  <option>全册</option>
                </Select>
              </Field>
              <Field label="出版年份 / 版次年份">
                <Input
                  type="number"
                  min={1900}
                  max={2100}
                  value={form.publicationYear}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      publicationYear: Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
          </form>
          {fileId ? (
            <p role="status" className="notice">
              教材原文件已上传并封存，可以创建教材并解析。
            </p>
          ) : (
            <UploadInput
              purpose="textbook"
              onUploaded={async (id) => setFileId(id)}
            />
          )}
          <Button
            disabled={!fileId || busy || !form.title.trim()}
            onClick={() => void save({ preventDefault() {} } as FormEvent)}
          >
            {busy ? "正在创建…" : "创建教材并解析"}
          </Button>
        </section>
      )}
      <section className="panel section-spacer">
        {list.loading && !list.data ? (
          <StatusPanel state="loading" title="正在读取教材" />
        ) : list.error ? (
          <StatusPanel state="error" title={list.error} onRetry={list.reload} />
        ) : list.data?.length ? (
          list.data.map((r) => (
            <div className="list-row" key={r.id}>
              <div className="grow">
                <h3>{r.title}</h3>
                <p>
                  {r.edition} · {r.grade} · {r.subject} · {r.term} ·{" "}
                  {r.publicationYear}版 · 修订{r.revisionNo}
                </p>
              </div>
              <span className="badge">{textbookStatus[r.status]}</span>
              {r.status === "failed" && (
                <p className="error-text text-small">
                  {textbookParseError(r.parseErrorCode)}
                </p>
              )}
              <Button asChild variant="outline">
                <Link to={`/admin/textbooks/${r.id}`}>检查与管理</Link>
              </Button>
            </div>
          ))
        ) : (
          <StatusPanel title="还没有电子教材">
            先上传一本教材，并核对解析页码与内容。
          </StatusPanel>
        )}
      </section>
    </>
  );
}
