import { Plus, BookOpen, ArrowUpRight } from "lucide-react";
import type { RevisionDTO } from "../lib/types";
import { errorMessage } from "../lib/api";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Field, Select } from "../components/ui/field";
import { StatusPanel } from "../components/StatusPanel";
export function StudyEntry() {
  const a = useAuth(),
    navigate = useNavigate();
  const [edition, setEdition] = useState(""),
    [grade, setGrade] = useState(""),
    [subject, setSubject] = useState(""),
    [revision, setRevision] = useState("");
  const [choosing, setChoosing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const enter = async (r: RevisionDTO) => {
    setBusy(true);
    setError("");
    try {
      await a.selectRevision(r);
      navigate("/");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!a.studentId)
    return (
      <StatusPanel title="尚无授权学生档案">
        管理员可先管理教材和邀请账号；学生授权后即可选择其学习档案。
      </StatusPanel>
    );
  if (a.catalogLoading)
    return <StatusPanel state="loading" title="正在加载教材" />;
  if (a.catalogError)
    return <StatusPanel state="error" title={a.catalogError} />;
  const unique = (values: string[]) => [...new Set(values)];
  const options = a.catalog.filter(
    (r) => r.edition === edition && r.grade === grade && r.subject === subject,
  );
  const selected =
    options.find((r) => r.id === revision) ??
    (options.length === 1 ? options[0] : undefined);
  return (
    <>
      <div className="page-heading">
        <h1>选择你的教材</h1>
        <p>辅导会按照所选版本、年级和科目查找教材依据。</p>
      </div>
      <section className="selection-grid" aria-label="教材选择与历史">
        <button
          type="button"
          className="selection-card selection-add"
          aria-label="选择年级和科目"
          aria-expanded={choosing}
          aria-controls="textbook-selector"
          disabled={busy}
          onClick={() => {
            setChoosing(!choosing);
            setError("");
          }}
        >
          <Plus size={25} />
          <strong>选择年级和科目</strong>
          <span>选择教材版本，开启新的学习空间</span>
        </button>
        {a.selectionHistory.map((item) => {
          const available = a.catalog.find((r) => r.id === item.revisionId);
          return (
            <button
              type="button"
              className={`selection-card ${a.selected?.id === item.revisionId ? "is-current" : ""}`}
              key={`${item.grade}:${item.subject}`}
              aria-label={`进入 ${item.grade} ${item.subject}`}
              disabled={busy}
              onClick={() => {
                if (available) void enter(available);
                else {
                  setChoosing(true);
                  setGrade("");
                  setSubject("");
                  setRevision("");
                  setEdition(item.edition);
                  setError("这份教材已停用，请重新选择已发布教材。");
                }
              }}
            >
              <span className="selection-card-top">
                <BookOpen size={23} />
                {a.selected?.id === item.revisionId && (
                  <span className="badge">当前教材</span>
                )}
              </span>
              <strong>
                {item.grade} · {item.subject}
              </strong>
              <span>
                {item.edition} · {item.term} · {item.publicationYear}版
              </span>
              <span className="selection-card-action">
                {available ? "进入学习空间" : "教材已停用，重新选择"}
                <ArrowUpRight size={17} />
              </span>
            </button>
          );
        })}
      </section>
      {!a.catalog.length && (
        <StatusPanel title="还没有已发布教材">
          请联系管理员上传并发布教材后再开始学习。
        </StatusPanel>
      )}
      {a.historyLoading && (
        <p className="muted" role="status">
          正在加载历史选择…
        </p>
      )}
      {a.historyError && (
        <p className="notice error-text" role="alert">
          历史选择暂时无法加载：{a.historyError}
        </p>
      )}
      {error && (
        <p className="notice error-text" role="alert">
          {error}
        </p>
      )}
      {!a.historyLoading && !a.selectionHistory.length && (
        <p className="muted selection-history-note">
          选择后会自动保留在这里，同一年级和科目只保留一张卡片。
        </p>
      )}
      {choosing && (
        <section id="textbook-selector" className="panel selection-panel">
          <div className="form-grid">
            <Field label="教材版本">
              <Select
                value={edition}
                onChange={(e) => {
                  setEdition(e.target.value);
                  setGrade("");
                  setSubject("");
                  setRevision("");
                }}
              >
                <option value="">请选择版本</option>
                {unique(a.catalog.map((r) => r.edition)).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="年级">
              <Select
                value={grade}
                disabled={!edition}
                onChange={(e) => {
                  setGrade(e.target.value);
                  setSubject("");
                  setRevision("");
                }}
              >
                <option value="">请选择年级</option>
                {unique(
                  a.catalog
                    .filter((r) => r.edition === edition)
                    .map((r) => r.grade),
                ).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="科目">
              <Select
                value={subject}
                disabled={!grade}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setRevision("");
                }}
              >
                <option value="">请选择科目</option>
                {unique(
                  a.catalog
                    .filter((r) => r.edition === edition && r.grade === grade)
                    .map((r) => r.subject),
                ).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="册次与版次">
              <Select
                value={selected?.id ?? ""}
                disabled={!subject}
                onChange={(e) => setRevision(e.target.value)}
              >
                <option value="">请选择教材</option>
                {options.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.term} · {r.publicationYear}版 · 修订{r.revisionNo}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {selected && (
            <p className="selection-note">
              {selected.title} · {selected.edition} · {selected.term}
            </p>
          )}
          <div className="form-actions">
            <Button
              disabled={!selected || busy}
              onClick={() => {
                if (selected) void enter(selected);
              }}
            >
              {busy ? "正在进入…" : "进入学习空间"}
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
export function RequireTextbook({ children }: { children: React.ReactNode }) {
  const a = useAuth();
  if (a.catalogLoading)
    return <StatusPanel state="loading" title="正在加载教材" />;
  if (a.session?.actor.role === "admin" && !a.studentId) return children;
  if (!a.selected) return <Navigate to="/select" replace />;
  return children;
}
