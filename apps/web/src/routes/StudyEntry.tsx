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
  if (!a.catalog.length)
    return (
      <StatusPanel title="还没有已发布教材">
        请联系管理员上传并发布教材后再开始学习。
      </StatusPanel>
    );
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
      <section className="panel selection-panel">
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
            disabled={!selected}
            onClick={() => {
              a.selectRevision(selected!);
              navigate("/");
            }}
          >
            进入学习空间
          </Button>
        </div>
      </section>
    </>
  );
}
export function RequireTextbook({ children }: { children: React.ReactNode }) {
  const a = useAuth();
  if (a.catalogLoading)
    return <StatusPanel state="loading" title="正在加载教材" />;
  if (!a.selected) return <Navigate to="/select" replace />;
  return children;
}
