import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useRemote } from "../lib/useRemote";
import { api, jsonBody, errorMessage } from "../lib/api";
import type { MistakeDTO } from "../lib/types";
import { stateLabels } from "../lib/types";
import { StatusPanel } from "../components/StatusPanel";
import { Button } from "../components/ui/button";
import { Field, Textarea } from "../components/ui/field";
import { Markdown } from "../components/Markdown";
import { DocumentViewer } from "../features/uploads/DocumentViewer";
type StateEvent = {
  id: string;
  assessmentId?: string;
  attemptId?: string;
  fromState: string;
  toState: string;
  reason: string;
  evidenceAt: string;
  type: string;
};
type Source = {
  fileId: string;
  pageIndex: number;
  bbox: number[];
  teacherAnnotation?: string;
};
export function MistakeDetail() {
  const { id } = useParams();
  const a = useAuth();
  const detail = useRemote<MistakeDTO>(
    id ? a.scoped(`/api/mistakes/${id}`) : null,
  );
  const history = useRemote<StateEvent[]>(
    id ? a.scoped(`/api/mistakes/${id}/history`) : null,
  );
  const sources = useRemote<Source[]>(
    detail.data
      ? a.scoped(
          `/api/question-versions/${detail.data.questionVersionId}/sources`,
        )
      : null,
  );
  const [source, setSource] = useState<Source>(),
    [editing, setEditing] = useState(false),
    [stem, setStem] = useState(""),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState<{
      answer: string;
      questionStem: string;
      messageContent: string | null;
      hints: { level: string; content: string }[];
      attachments?: {
        fileId: string;
        name: string;
        mimeType: string;
        width: number | null;
        height: number | null;
        position: number;
      }[];
    }>();
  const correction = async () => {
    if (!detail.data) return;
    try {
      const v = await api<{ questionId: string; versionNo: number }>(
        a.scoped(`/api/question-versions/${detail.data.questionVersionId}`),
      );
      await api(a.scoped(`/api/questions/${v.questionId}`), {
        method: "PATCH",
        ...jsonBody({ expectedVersion: v.versionNo, stem }),
      });
      setEditing(false);
      detail.reload();
      history.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (detail.loading)
    return <StatusPanel state="loading" title="正在读取错题历史" />;
  if (detail.error || !detail.data)
    return <StatusPanel state="error" title={detail.error || "错题不存在"} />;
  return (
    <>
      <div className="page-heading">
        <h1>错题详情</h1>
        <p>每次状态变化都能追溯到对应作答和提示。</p>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <section className="panel">
        <div className="section-head">
          <span className="badge">{stateLabels[detail.data.status]}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setStem(detail.data!.stem);
              setEditing(!editing);
            }}
          >
            修正题干识别
          </Button>
        </div>
        {editing ? (
          <>
            <Field label="修正题干">
              <Textarea
                value={stem}
                onChange={(e) => setStem(e.target.value)}
              />
            </Field>
            <div className="form-actions">
              <Button onClick={() => void correction()}>保存新版本</Button>
            </div>
          </>
        ) : (
          <Markdown>{detail.data.stem}</Markdown>
        )}
        <div className="form-actions">
          {sources.data?.map((s, i) => (
            <Button variant="outline" key={i} onClick={() => setSource(s)}>
              查看原图 · 第 {s.pageIndex + 1} 页
            </Button>
          ))}
        </div>
      </section>
      <section className="panel section-spacer">
        <h2>状态与证据</h2>
        {history.data?.length ? (
          history.data.map((e) => (
            <div className="history-event" key={e.id}>
              <div>
                <strong>{stateLabels[e.toState] ?? e.toState}</strong>
                <span className="muted text-small">
                  {new Date(e.evidenceAt).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                </span>
              </div>
              <p>{e.reason}</p>
              {e.attemptId && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      setEvidence(
                        await api(a.scoped(`/api/attempts/${e.attemptId}`)),
                      );
                    } catch (err) {
                      setError(errorMessage(err));
                    }
                  }}
                >
                  查看本次作答与提示
                </Button>
              )}
            </div>
          ))
        ) : (
          <p className="muted">尚未开始订正，原始题目已保留。</p>
        )}
      </section>
      {evidence && (
        <section className="panel section-spacer">
          <h2>作答证据</h2>
          <h3>当时的题目</h3>
          <Markdown>{evidence.questionStem}</Markdown>
          <h3 className="section-spacer">学生作答</h3>
          {evidence.answer ? (
            <Markdown>{evidence.answer}</Markdown>
          ) : (
            <p className="muted">本次作答未填写文字，以下图片为作答证据。</p>
          )}
          {!!evidence.attachments?.length && (
            <>
              <h3 className="section-spacer">作答图片</h3>
              <div className="form-actions">
                {evidence.attachments.map((att) => (
                  <span className="badge" key={att.fileId}>
                    {att.name}
                    {att.width && att.height
                      ? `（${att.width}×${att.height}）`
                      : ""}
                  </span>
                ))}
              </div>
              <p className="muted text-small">
                图片与这条消息版本绑定，判题读取的是同一份已封存文件。
              </p>
            </>
          )}
          <h3 className="section-spacer">作答前的提示</h3>
          {evidence.hints.length ? (
            evidence.hints.map((h, i) => (
              <div key={i}>
                <span className="badge">
                  {h.level === "solution_exposed" ? "已接触解法" : "引导提示"}
                </span>
                <Markdown>{h.content}</Markdown>
              </div>
            ))
          ) : (
            <p className="muted">
              没有已记录的提示；导入作答的独立性仍可能未知。
            </p>
          )}
        </section>
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
