import type {
  DiagnosisCandidate,
  DiagnosisCode,
  DiagnosisContext,
  DiagnosisDTO,
  DiagnosisEvidenceRef,
} from "../../../../../packages/contracts/src/tutoring.js";

export const DIAGNOSIS_RULE_VERSION = "diagnosis-rules-v1";

const CODE_LABELS: Record<DiagnosisCode, string> = {
  execution_slip: "执行疏漏",
  condition_omission: "条件遗漏",
  concept_gap: "概念缺口",
  rule_misuse: "规则误用",
  strategy_gap: "策略缺口",
  expression_gap: "表达缺口",
  input_issue: "输入问题",
};

/** 这些错因仅凭一个步骤无法确认，需要一次针对性追问。 */
const PROBE_REQUIRED = new Set<DiagnosisCode>([
  "execution_slip",
  "rule_misuse",
  "concept_gap",
  "strategy_gap",
]);

/** 概念与规则缺口还要求存在已发布的知识依据。 */
const KNOWLEDGE_REQUIRED = new Set<DiagnosisCode>(["concept_gap", "rule_misuse"]);

const DEFAULT_PROBE = "请把这一步的中间过程写出来，我再判断是哪一类错误。";

type Decision = Omit<DiagnosisDTO, "id" | "version">;

const refKey = (ref: DiagnosisEvidenceRef) => `${ref.kind}:${ref.id}`;

function normalizeRef(ref: DiagnosisEvidenceRef): DiagnosisEvidenceRef {
  return ref.versionId
    ? { kind: ref.kind, id: ref.id, versionId: ref.versionId }
    : { kind: ref.kind, id: ref.id };
}

function collectEvidence(
  context: DiagnosisContext,
  candidates: DiagnosisCandidate[],
  assessmentId: string | null,
): DiagnosisEvidenceRef[] {
  const refs = new Map<string, DiagnosisEvidenceRef>();
  const add = (ref: DiagnosisEvidenceRef | null | undefined) => {
    if (!ref) return;
    refs.set(refKey(ref), normalizeRef(ref));
  };
  for (const ref of [
    ...context.processEvidence,
    ...context.probeEvidence,
  ])
    add(ref);
  for (const candidate of candidates) {
    add(candidate.earliestError);
    for (const ref of candidate.supports) add(ref);
    for (const ref of candidate.contradicts) add(ref);
  }
  add({
    kind: "question_version",
    id: context.questionVersionId,
    versionId: context.questionVersionId,
  });
  if (assessmentId) add({ kind: "assessment", id: assessmentId });
  return [...refs.values()].sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  );
}

function normalizeCandidates(
  context: DiagnosisContext,
  candidates: DiagnosisCandidate[],
): {
  candidates: DiagnosisCandidate[];
  knowledgeBlocked: boolean;
} {
  const allowed = new Map<string, DiagnosisEvidenceRef>();
  for (const ref of [...context.processEvidence, ...context.probeEvidence])
    allowed.set(refKey(ref), ref);

  const keep = (ref: DiagnosisEvidenceRef) => allowed.get(refKey(ref));
  const seen = new Set<DiagnosisCode>();
  const output: DiagnosisCandidate[] = [];
  let knowledgeBlocked = false;

  for (const input of candidates) {
    if (output.length >= 3 || seen.has(input.code)) continue;
    seen.add(input.code);

    const supports = input.supports
      .map(keep)
      .filter((ref): ref is DiagnosisEvidenceRef => !!ref);
    const contradicts = input.contradicts
      .map(keep)
      .filter((ref): ref is DiagnosisEvidenceRef => !!ref);
    const earliestError = input.earliestError
      ? (keep(input.earliestError) ?? null)
      : null;

    const located = earliestError?.kind === "process_step";
    const probeSupported = supports.some(
      (ref) => ref.kind === "probe_response",
    );
    const knowledgeOk =
      !KNOWLEDGE_REQUIRED.has(input.code) || context.knowledgeAvailable;
    if (
      !knowledgeOk &&
      (located || probeSupported) &&
      input.status !== "rejected"
    )
      knowledgeBlocked = true;

    let status: DiagnosisCandidate["status"];
    if (input.status === "rejected" || input.code === "input_issue")
      status = "rejected";
    else if (contradicts.length)
      // 有真实反证时最多算"有支持"，不能因模型自称确认就晋级。
      status = located || probeSupported ? "supported" : "hypothesis";
    else if (!knowledgeOk) status = located || probeSupported ? "supported" : "hypothesis";
    else if (located && (!PROBE_REQUIRED.has(input.code) || probeSupported))
      status = "confirmed";
    else if (located || probeSupported) status = "supported";
    else status = "hypothesis";

    output.push({
      ...input,
      status,
      earliestError,
      supports,
      contradicts,
      probe: input.probe?.trim() || null,
    });
  }

  return { candidates: output, knowledgeBlocked };
}

/**
 * Pure decision rules: the model may only propose candidates. Whether a
 * candidate is confirmed is decided here from locatable evidence, verified
 * assessment results, and published knowledge. Time never confirms anything.
 */
export function decideDiagnosis(
  context: DiagnosisContext,
  input: DiagnosisCandidate[],
): Decision {
  const { candidates, knowledgeBlocked } = normalizeCandidates(
    context,
    input,
  );
  const evidence = collectEvidence(context, candidates, context.assessmentId);
  const decidedAt = {
    attemptId: context.attemptId,
    candidates,
    evidence,
    ruleVersion: DIAGNOSIS_RULE_VERSION,
  };
  const rejected = (summary: string): Decision => ({
    ...decidedAt,
    status: "unsupported",
    primaryCode: null,
    summary,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      status: "rejected",
    })),
  });

  if (context.manualPrimaryCode) {
    const code = context.manualPrimaryCode;
    const manual = candidates.find((candidate) => candidate.code === code);
    const rest = candidates.filter((candidate) => candidate.code !== code);
    const confirmed: DiagnosisCandidate = manual ?? {
      code,
      skillId: null,
      status: "confirmed",
      earliestError: null,
      supports: [],
      contradicts: [],
      probe: null,
    };
    return {
      ...decidedAt,
      status: "confirmed",
      primaryCode: code,
      summary: `老师已人工确认主要错因是${CODE_LABELS[code]}。`,
      candidates: [
        { ...confirmed, status: "confirmed" as const },
        ...rest,
      ].slice(0, 3),
    };
  }

  if (!context.stemConfirmed)
    return {
      ...decidedAt,
      status: "pending",
      primaryCode: null,
      summary: "题干或附件还没确认，暂不能把错误归到学生身上。",
      candidates: candidates.map((candidate) => ({
        ...candidate,
        status:
          candidate.status === "rejected"
            ? ("rejected" as const)
            : ("hypothesis" as const),
      })),
    };

  if (context.supportedQuestionType === false)
    return rejected("这类题型暂不在可归因范围内，先保留原作答，不做错因判断。");

  if (
    !context.assessment ||
    context.assessment.verification !== "verified" ||
    context.assessment.correctness === "uncertain"
  )
    return {
      ...decidedAt,
      status: "pending",
      primaryCode: null,
      summary: "判题结果还没核验，暂不能诊断错因。",
    };

  if (context.assessment.correctness === "correct")
    return rejected("判题结果是正确，说明这种解法同样成立，暂不需要归因错因。");

  const confirmed = candidates.filter(
    (candidate) => candidate.status === "confirmed",
  );
  if (new Set(confirmed.map((candidate) => candidate.code)).size === 1) {
    const code = confirmed[0]!.code;
    return {
      ...decidedAt,
      status: "confirmed",
      primaryCode: code,
      summary: `已确认主要错因是${CODE_LABELS[code]}，下一步按这一处做针对性练习。`,
    };
  }

  if (knowledgeBlocked)
    return {
      ...decidedAt,
      status: "pending",
      primaryCode: null,
      summary: "已发布资料里还没有这道题的知识点依据，暂不能确认错因。",
    };

  if (candidates.every((candidate) => candidate.status === "rejected"))
    return {
      ...decidedAt,
      status: "pending",
      primaryCode: null,
      summary: "现有证据不足以归因，先保留判断，等更多过程证据。",
    };

  if (candidates.some((candidate) => candidate.contradicts.length))
    return {
      ...decidedAt,
      status: "needs_probe",
      primaryCode: null,
      summary: "现有证据互相冲突，需要再做一次针对性检查。",
      candidates: candidates.map((candidate) =>
        candidate.status === "confirmed"
          ? { ...candidate, status: "supported" }
          : candidate,
      ),
    };

  const probe =
    candidates.find(
      (candidate) =>
        candidate.status !== "rejected" &&
        candidate.probe &&
        candidate.probe.length > 0,
    )?.probe ?? DEFAULT_PROBE;
  return {
    ...decidedAt,
    status: "needs_probe",
    primaryCode: null,
    summary: `暂时无法在几种可能之间确认，先做一次区分性追问：${probe}`,
  };
}
