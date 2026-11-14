import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Field, Select, Textarea } from "../../components/ui/field";
import { errorMessage } from "../../lib/api";
import type { DiagnosisRecordDTO } from "../../../../../packages/contracts/src/student-insights.js";
import { submitDiagnosisReview } from "./api";
import { dateTime } from "./format";

const CODE_LABELS: Record<string, string> = {
  execution_slip: "操作失误",
  condition_omission: "条件遗漏",
  concept_gap: "知识缺口",
  rule_misuse: "规则误用",
  strategy_gap: "策略不足",
  expression_gap: "表达缺口",
  input_issue: "作答输入问题",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待确认",
  needs_probe: "需追问",
  confirmed: "已确认",
  unsupported: "证据不足",
  invalidated: "已失效",
};

const DECISION_LABELS: Record<string, string> = {
  accept: "认可当前结论",
  correct: "更正错因",
  insufficient: "证据不足，暂不确认",
};

const EVIDENCE_LABELS: Record<string, string> = {
  message_version: "对话消息",
  probe_response: "追问回答",
  question_version: "题目版本",
  process_step: "作答步骤",
  knowledge_snapshot: "知识点快照",
  assessment: "核验记录",
  diagnosis: "历史诊断",
};

function evidenceKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function DiagnosisReview({
  studentId,
  diagnosis,
  onReviewed,
}: {
  studentId: string;
  diagnosis: DiagnosisRecordDTO;
  onReviewed: () => void;
}) {
  const [decision, setDecision] =
    useState<"accept" | "correct" | "insufficient">("accept");
  const [code, setCode] = useState(diagnosis.primaryCode ?? "");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string[]>(
    diagnosis.evidence.map((ref) => evidenceKey(ref.kind, ref.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const chosenEvidence = diagnosis.evidence.filter((ref) =>
    selected.includes(evidenceKey(ref.kind, ref.id)),
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await submitDiagnosisReview(studentId, {
        diagnosisId: diagnosis.id,
        expectedVersion: diagnosis.version,
        decision,
        correctedCode: decision === "correct" ? code || null : null,
        reason: reason.trim(),
        evidence: decision === "correct" ? chosenEvidence : [],
        requestKey: crypto.randomUUID(),
      });
      setStatus(`已记录复核，诊断更新到第 ${result.diagnosisVersion} 版。`);
      setReason("");
      onReviewed();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    reason.trim().length > 0 &&
    (decision !== "correct" || (!!code && chosenEvidence.length > 0));

  return (
    <div className="insight-diagnosis">
      <div className="insight-diagnosis-current">
        <span className="muted">
          诊断第 {diagnosis.version} 版 ·{" "}
          {STATUS_LABELS[diagnosis.status] ?? diagnosis.status}
        </span>
        <p>
          {diagnosis.primaryCode
            ? (CODE_LABELS[diagnosis.primaryCode] ?? diagnosis.primaryCode)
            : "错因未确认"}
          {": "}
          {diagnosis.summary}
        </p>
        {diagnosis.evidence.length > 0 && (
          <ul className="insight-diagnosis-evidence">
            {diagnosis.evidence.map((ref) => (
              <li key={evidenceKey(ref.kind, ref.id)}>
                {EVIDENCE_LABELS[ref.kind] ?? ref.kind}
                {" · "}
                <code>{ref.id.slice(0, 8)}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      {diagnosis.reviews.length > 0 && (
        <ol className="insight-diagnosis-reviews">
          {diagnosis.reviews.map((review) => (
            <li key={review.id}>
              <span className="muted">{dateTime(review.createdAt)}</span>
              <strong>{DECISION_LABELS[review.decision] ?? review.decision}</strong>
              {review.correctedCode && (
                <span>
                  更正为{CODE_LABELS[review.correctedCode] ?? review.correctedCode}
                </span>
              )}
              <p>{review.reason}</p>
            </li>
          ))}
        </ol>
      )}

      <form className="form-stack insight-diagnosis-form" onSubmit={submit}>
        <p className="muted">
          复核只调整错因结论，不会改变学生作答的正误，也不会补出未经核验的掌握证据。
        </p>
        <Field label="复核结论">
          <Select
            value={decision}
            onChange={(event) =>
              setDecision(event.target.value as typeof decision)
            }
          >
            <option value="accept">认可当前结论</option>
            <option value="correct">更正错因</option>
            <option value="insufficient">证据不足，暂不确认</option>
          </Select>
        </Field>
        {decision === "correct" && (
          <>
            <Field label="纠正后的错因">
              <Select
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              >
                <option value="">选择错因</option>
                {Object.entries(CODE_LABELS).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <fieldset className="insight-diagnosis-pick">
              <legend>作为依据的证据</legend>
              {diagnosis.evidence.length ? (
                diagnosis.evidence.map((ref) => {
                  const key = evidenceKey(ref.kind, ref.id);
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={selected.includes(key)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, key]
                              : current.filter((item) => item !== key),
                          )
                        }
                      />
                      {EVIDENCE_LABELS[ref.kind] ?? ref.kind}
                      {" · "}
                      <code>{ref.id.slice(0, 8)}</code>
                    </label>
                  );
                })
              ) : (
                <small>该诊断没有可用证据，无法直接更正错因。</small>
              )}
            </fieldset>
          </>
        )}
        <Field label="复核说明">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明判断依据，例如学生把进位漏掉了，步骤里能看到"
            required
          />
        </Field>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {status && <p role="status">{status}</p>}
        <div className="form-actions">
          <Button type="submit" disabled={!canSubmit}>
            {busy ? "正在提交" : "提交复核"}
          </Button>
        </div>
      </form>
    </div>
  );
}
