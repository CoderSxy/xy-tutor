import { useAuth } from "../../lib/auth";
import { useRemote } from "../../lib/useRemote";
import type { DiagnosisCode, DiagnosisStatus } from "../../../../../packages/contracts/src/tutoring.js";

type StudentDiagnosis = {
  id: string;
  attemptId: string;
  version: number;
  status: DiagnosisStatus;
  primaryCode: DiagnosisCode | null;
  summary: string;
  nextStep: string;
  evidence: { kind: string; id: string }[];
};

const codeLabels: Record<DiagnosisCode, string> = {
  execution_slip: "步骤执行失误",
  condition_omission: "漏看条件",
  concept_gap: "知识点缺口",
  rule_misuse: "规则误用",
  strategy_gap: "思路选择问题",
  expression_gap: "表达不完整",
  input_issue: "题干或识别问题",
};

const statusLabels: Record<DiagnosisStatus, string> = {
  pending: "错因待确认",
  needs_probe: "需要补充过程",
  confirmed: "已确认",
  unsupported: "暂不支持自动归因",
  invalidated: "证据已修改，原诊断失效",
};

export function DiagnosisSummary({ attemptId }: { attemptId: string }) {
  const a = useAuth();
  const remote = useRemote<{ diagnosis: StudentDiagnosis | null }>(
    a.scoped(`/api/attempts/${attemptId}/diagnosis`),
  );
  const diagnosis = remote.data?.diagnosis ?? null;
  return (
    <section className="diagnosis-summary" aria-label="错因诊断摘要">
      <h3>错因诊断</h3>
      {remote.loading && <p className="muted">正在读取诊断…</p>}
      {remote.error && (
        <p className="muted">诊断暂时读不到，不影响查看原作答。</p>
      )}
      {!remote.loading && !remote.error && !diagnosis && (
        <p className="muted">
          还没有错因诊断：可能还没核验、过程证据不足，或自动归因未开启。
        </p>
      )}
      {diagnosis && (
        <>
          <div className="section-head">
            <span className="badge">
              {statusLabels[diagnosis.status] ?? diagnosis.status}
              {diagnosis.status === "confirmed" && diagnosis.primaryCode
                ? ` · ${codeLabels[diagnosis.primaryCode]}`
                : ""}
            </span>
            <span className="muted text-small">
              依据 {diagnosis.evidence.length} 条
            </span>
          </div>
          <p>{diagnosis.summary}</p>
          <p className="muted text-small">下一步：{diagnosis.nextStep}</p>
          <p className="muted text-small">
            诊断会随新证据更新，不代表教师复核结论。
          </p>
        </>
      )}
    </section>
  );
}
