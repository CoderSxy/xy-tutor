import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { useRemote } from "../lib/useRemote";
import type { TaskDTO } from "../lib/types";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { DocumentViewer } from "../features/uploads/DocumentViewer";
import {
  QuestionEditor,
  type EditableQuestion,
} from "../features/uploads/QuestionEditor";
type Extraction = {
  version: number;
  status: string;
  fileId: string;
  revisionId: string;
  confirmedQuestionVersionIds: string[];
  payload?: {
    pages: { pdfPageIndex: number; status: string; text: string }[];
    questions: {
      candidateId: string;
      stem: string;
      studentAnswer?: string;
      teacherAnnotation?: string;
      sources: { pageIndex: number; bbox: number[] }[];
    }[];
  };
};

export function MaterialReview() {
  const { id } = useParams();
  const a = useAuth(),
    navigate = useNavigate();
  const remote = useRemote<Extraction>(
    id ? a.scoped(`/api/materials/${id}`) : null,
  );
  const [questions, setQuestions] = useState<EditableQuestion[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState<string[]>([]),
    [source, setSource] = useState<{
      fileId: string;
      pageIndex: number;
      bbox: number[];
    }>();
  useEffect(() => {
    if (remote.data?.payload) {
      setQuestions(
        remote.data.payload.questions.map((q) => ({
          key: crypto.randomUUID(),
          candidateIds: [q.candidateId],
          stem: q.stem,
          studentAnswer: q.studentAnswer,
          teacherAnnotation: q.teacherAnnotation,
          sources: q.sources,
          selected: false,
        })),
      );
      setConfirmed(remote.data.confirmedQuestionVersionIds);
    }
  }, [remote.data]);
  useEffect(() => {
    if (remote.data?.status === "processing") {
      const timer = setTimeout(remote.reload, 2500);
      return () => clearTimeout(timer);
    }
  }, [remote.data, remote.reload]);
  const confirm = async () => {
    if (!remote.data) return;
    setBusy(true);
    setError("");
    try {
      const selected = questions.filter((q) => q.selected);
      if (!selected.length || selected.some((q) => !q.stem.trim()))
        throw Error("请选择题目，并补全所选题干");
      const result = await api<{ questionVersionIds: string[] }>(
        a.scoped(`/api/materials/${id}/confirm`),
        {
          method: "POST",
          ...jsonBody({
            extractionVersion: remote.data.version,
            questions: selected.map((q) => ({
              candidateIds: q.candidateIds,
              stem: q.stem,
              studentAnswer: q.studentAnswer,
              teacherAnnotation: q.teacherAnnotation,
              sources: q.sources,
            })),
          }),
        },
      );
      setConfirmed((prev) => [
        ...new Set([...prev, ...result.questionVersionIds]),
      ]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const study = async () => {
    if (!remote.data || !confirmed.length) return;
    setBusy(true);
    try {
      const task = await api<TaskDTO>(a.scoped("/api/tasks"), {
        method: "POST",
        ...jsonBody({
          revisionId: remote.data.revisionId,
          kind: "material_tutoring",
        }),
      });
      await api(a.scoped(`/api/tasks/${task.id}/attach-questions`), {
        method: "POST",
        ...jsonBody({ questionVersionIds: confirmed }),
      });
      navigate(`/study/${task.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const merge = () => {
    const selected = questions.filter((q) => q.selected);
    if (selected.length < 2) return;
    const merged: EditableQuestion = {
      key: crypto.randomUUID(),
      candidateIds: [...new Set(selected.flatMap((q) => q.candidateIds))],
      stem: selected.map((q) => q.stem).join("\n\n"),
      studentAnswer: selected
        .map((q) => q.studentAnswer)
        .filter(Boolean)
        .join("\n"),
      teacherAnnotation: selected
        .map((q) => q.teacherAnnotation)
        .filter(Boolean)
        .join("\n"),
      sources: selected.flatMap((q) => q.sources),
      selected: true,
    };
    setQuestions([...questions.filter((q) => !q.selected), merged]);
  };
  if (remote.loading && !remote.data)
    return <StatusPanel state="loading" title="正在加载识别结果" />;
  if (remote.error || !remote.data)
    return (
      <StatusPanel
        state="error"
        title={remote.error || "资料不存在"}
        onRetry={remote.reload}
      />
    );
  const data = remote.data;
  return (
    <>
      <div className="page-heading">
        <h1>确认识别结果</h1>
        <p>
          先核对题干和学生作答，再选择本次要辅导的题目。教师批注会单独保留。
        </p>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {confirmed.length > 0 && (
        <div className="notice">
          <span>已确认 {confirmed.length} 道题</span>
          <Button disabled={busy} onClick={() => void study()}>
            开始辅导已确认题目
          </Button>
        </div>
      )}
      {data.status === "processing" ? (
        <StatusPanel state="queued" title="资料正在识别，请稍候">
          处理完成后会显示候选题目。
        </StatusPanel>
      ) : data.status === "failed" ? (
        <StatusPanel
          state="error"
          title="资料处理失败"
          onRetry={async () => {
            await api(a.scoped(`/api/materials/${id}/retry`), {
              method: "POST",
            });
            remote.reload();
          }}
        />
      ) : (
        <>
          {data.payload?.pages.some((p) => p.status === "needs_ocr") && (
            <div className="notice">
              部分页面尚未启用
              OCR。请参考原图手动补充题干，确认后也可以开始辅导。
            </div>
          )}
          <div className="section-head">
            <h2>候选题目 · {questions.length} 道</h2>
            <Button
              variant="outline"
              disabled={questions.filter((q) => q.selected).length < 2}
              onClick={merge}
            >
              合并所选题目
            </Button>
          </div>
          {questions.map((q, index) => (
            <QuestionEditor
              key={q.key}
              question={q}
              index={index}
              onChange={(patch) =>
                setQuestions((prev) =>
                  prev.map((item) =>
                    item.key === q.key ? { ...item, ...patch } : item,
                  ),
                )
              }
              onSplit={() =>
                setQuestions((prev) => {
                  const at = prev.findIndex((item) => item.key === q.key);
                  return [
                    ...prev.slice(0, at + 1),
                    {
                      ...q,
                      key: crypto.randomUUID(),
                      stem: "",
                      studentAnswer: "",
                      selected: true,
                    },
                    ...prev.slice(at + 1),
                  ];
                })
              }
              onView={() =>
                setSource({
                  fileId: data.fileId,
                  pageIndex: q.sources[0]?.pageIndex ?? 0,
                  bbox: q.sources[0]?.bbox ?? [0, 0, 1, 1],
                })
              }
            />
          ))}
          <div className="form-actions sticky-actions">
            <Button
              disabled={busy || !questions.some((q) => q.selected)}
              onClick={() => void confirm()}
            >
              {busy ? "正在保存…" : "确认所选题目"}
            </Button>
            <small className="muted">
              确认只保存题目和来源，不会自动判定所有题目都是错题。
            </small>
          </div>
        </>
      )}
      <DocumentViewer
        fileId={source?.fileId}
        pageIndex={source?.pageIndex}
        bbox={source?.bbox}
        onClose={() => setSource(undefined)}
      />
    </>
  );
}
