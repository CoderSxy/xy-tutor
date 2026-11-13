// 阶段一错因诊断离线评估。只在夹具上跑确定性规则，不调用模型、不连数据库。
// 用法：pnpm evaluate:tutoring --dataset=tests/fixtures/tutoring/development.json,tests/fixtures/tutoring/frozen-evaluation.json --output=/tmp/report.json
// 覆盖要求按整套语料计算，所以默认把开发集与冻结集一起传入；只传单个 split 会误报覆盖不足。
// 输出的 JSON 不含题干、作答原文与学生信息；教师认可率只由教师复核记录计算，不用规则自评代替。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideDiagnosis, DIAGNOSIS_RULE_VERSION } from "../apps/server/src/modules/tutoring/diagnosis-rules.js";
import type {
  DiagnosisCandidate,
  DiagnosisCode,
  DiagnosisContext,
  DiagnosisStatus,
} from "../packages/contracts/src/tutoring.js";

const CODES: DiagnosisCode[] = [
  "execution_slip",
  "condition_omission",
  "concept_gap",
  "rule_misuse",
  "strategy_gap",
  "expression_gap",
  "input_issue",
];

/** 阶段一验收门槛：至少 30 条 confirmed 经教师复核，且教师认可率不低于 90%。 */
const REQUIRED_REVIEWED_CONFIRMED = 30;
const REQUIRED_ACCEPTANCE_RATE = 0.9;

type FixtureCandidate = {
  code: DiagnosisCode;
  /** 候选是否指向一个可定位的过程步骤。 */
  locates?: boolean;
  /** 候选是否依赖追问回复的支持。 */
  usesProbe?: boolean;
  /** 追问回复是否与候选冲突。 */
  contradicts?: boolean;
  /** 模型自称的状态；规则层不会采信，只用来覆盖「模型自称已确认」。 */
  status?: DiagnosisCandidate["status"];
};

type FixtureSample = {
  id: string;
  split: "development" | "frozen";
  scenario: string;
  stem: string;
  answer: string;
  process: string;
  /** 可定位的过程步骤数量。 */
  steps: number;
  probe?: boolean;
  stemConfirmed?: boolean;
  knowledge?: "available" | "missing";
  questionType?: "supported" | "unsupported";
  assessment?:
    | "incorrect_verified"
    | "correct_verified"
    | "pending"
    | "uncertain"
    | "none";
  manual?: DiagnosisCode;
  candidates: FixtureCandidate[];
  expected: { status: DiagnosisStatus; primaryCode: DiagnosisCode | null };
  review: {
    status: "pending_review" | "approved" | "rejected";
    reviewer?: string;
    reviewedAt?: string;
    /** 教师复核时给出的错因，只有在 review.status 为 approved 时才参与认可率。 */
    primaryCode?: DiagnosisCode | null;
  };
};

type Fixture = {
  datasetVersion: string;
  modelVersion: string;
  note?: string;
  samples: FixtureSample[];
};

type Flags = { datasets: string[]; output: string };

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  const datasets: string[] = [];
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw Error(`未知参数：${arg}（请使用 --key=value）`);
    const [, key, value] = match;
    // 覆盖要求按整套语料计算，所以允许 --dataset 重复或一次给多个路径。
    if (key === "dataset") {
      datasets.push(...value!.split(",").map((p) => p.trim()).filter(Boolean));
    } else {
      flags.set(key!, value!);
    }
  }
  const output = flags.get("output");
  if (datasets.length === 0 || !output)
    throw Error("缺少参数：需要 --dataset=<path> 和 --output=<path>");
  return { datasets: datasets.map((path) => resolve(path)), output: resolve(output) };
}

function toContext(sample: FixtureSample): DiagnosisContext {
  const processEvidence = Array.from({ length: sample.steps }, (_, i) => ({
    kind: "process_step",
    id: `${sample.id}-step-${i + 1}`,
  }));
  const probeEvidence = sample.probe
    ? [{ kind: "probe_response", id: `${sample.id}-probe-1` }]
    : [];
  const assessment =
    !sample.assessment || sample.assessment === "none"
      ? null
      : sample.assessment === "incorrect_verified"
        ? { correctness: "incorrect" as const, verification: "verified" as const }
        : sample.assessment === "correct_verified"
          ? { correctness: "correct" as const, verification: "verified" as const }
          : sample.assessment === "uncertain"
            ? { correctness: "uncertain" as const, verification: "verified" as const }
            : { correctness: "incorrect" as const, verification: "pending" as const };
  return {
    assessmentId: `${sample.id}-assessment`,
    attemptId: `${sample.id}-attempt`,
    questionVersionId: `${sample.id}-question`,
    processEvidence,
    probeEvidence,
    assessment,
    stemConfirmed: sample.stemConfirmed !== false,
    knowledgeAvailable: sample.knowledge !== "missing",
    supportedQuestionType: sample.questionType !== "unsupported",
    ...(sample.manual ? { manualPrimaryCode: sample.manual } : {}),
  };
}

function toCandidates(sample: FixtureSample): DiagnosisCandidate[] {
  const firstStep = `${sample.id}-step-1`;
  const probeRef = { kind: "probe_response", id: `${sample.id}-probe-1` };
  return sample.candidates.map((candidate) => ({
    code: candidate.code,
    skillId: null,
    status: candidate.status ?? "hypothesis",
    earliestError:
      candidate.locates && sample.steps > 0
        ? { kind: "process_step", id: firstStep }
        : null,
    supports: candidate.usesProbe && sample.probe ? [probeRef] : [],
    // 反证必须落在允许的证据集合里，所以只用追问回复表达冲突。
    contradicts: candidate.contradicts && sample.probe ? [probeRef] : [],
    probe: null,
  }));
}

function sameWrongAnswerPairs(samples: FixtureSample[]) {
  const groups = new Map<string, Set<DiagnosisCode>>();
  for (const sample of samples) {
    if (sample.review.status !== "pending_review" && sample.review.status !== "approved")
      continue;
    const cause =
      sample.review.primaryCode ??
      (sample.expected.status === "confirmed" ? sample.expected.primaryCode : null);
    if (!cause) continue;
    const key = `${sample.split}:${sample.stem.trim()}::${sample.answer.trim()}`;
    const codes = groups.get(key) ?? new Set<DiagnosisCode>();
    codes.add(cause);
    groups.set(key, codes);
  }
  return [...groups.values()].filter((codes) => codes.size >= 2).length;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const files = flags.datasets.map((path) => ({
    path,
    fixture: JSON.parse(readFileSync(path, "utf8")) as Fixture,
  }));
  const samples = files.flatMap((file) => file.fixture.samples);
  const duplicateIds = samples
    .map((sample) => sample.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length)
    throw Error(`样例 id 重复：${[...new Set(duplicateIds)].join(", ")}`);

  const bySplit = { development: 0, frozen: 0 };
  const confirmedByCode = new Map<DiagnosisCode, number>();
  const results = samples.map((sample) => {
    bySplit[sample.split] += 1;
    const decision = decideDiagnosis(toContext(sample), toCandidates(sample));
    if (decision.status === "confirmed" && decision.primaryCode)
      confirmedByCode.set(
        decision.primaryCode,
        (confirmedByCode.get(decision.primaryCode) ?? 0) + 1,
      );
    const agrees =
      decision.status === sample.expected.status &&
      (decision.status !== "confirmed" ||
        decision.primaryCode === sample.expected.primaryCode);
    return { sample, decision, agrees };
  });

  const outcomesOf = (subset: typeof results) => ({
    confirmed: subset.filter((r) => r.decision.status === "confirmed").length,
    needsProbe: subset.filter((r) => r.decision.status === "needs_probe").length,
    pending: subset.filter((r) => r.decision.status === "pending").length,
    unsupported: subset.filter((r) => r.decision.status === "unsupported").length,
  });

  const reviewOf = (subset: typeof results) => {
    const approvedSubset = subset.filter((r) => r.sample.review.status === "approved");
    const approvedConfirmedSubset = approvedSubset.filter(
      (r) => r.decision.status === "confirmed",
    );
    const acceptedSubset = approvedConfirmedSubset.filter(
      (r) => r.sample.review.primaryCode === r.decision.primaryCode,
    );
    return {
      approved: approvedSubset.length,
      approvedConfirmed: approvedConfirmedSubset.length,
      accepted: acceptedSubset.length,
      acceptanceRate:
        approvedConfirmedSubset.length > 0
          ? Number(
              (acceptedSubset.length / approvedConfirmedSubset.length).toFixed(4),
            )
          : null,
      pendingReview: subset.filter((r) => r.sample.review.status === "pending_review")
        .length,
      rejected: subset.filter((r) => r.sample.review.status === "rejected").length,
    };
  };

  const confirmed = results.filter((r) => r.decision.status === "confirmed");
  const frozenResults = results.filter((r) => r.sample.split === "frozen");
  const frozenReview = reviewOf(frozenResults);
  // 验收门槛只看冻结集：开发集是用来调规则的，不能给自己算验收通过。
  const approved = results.filter((r) => r.sample.review.status === "approved");

  const missingCodes = CODES.filter((code) => !results.some((r) => r.sample.candidates.some((c) => c.code === code)));
  const uncoveredScenarios = [
    "过程可定位",
    "只有最终答案",
    "题干未确认",
    "题型暂不归因",
    "判题待核验",
    "判题结果正确",
    "缺已发布知识依据",
    "证据冲突",
    "模型输出无效",
    "输入问题",
  ].filter((scenario) => !samples.some((s) => s.scenario === scenario));

  const blockers: string[] = [];
  if (samples.length === 0) blockers.push("数据集为空");
  if (missingCodes.length)
    blockers.push(`错因类型未覆盖：${missingCodes.join(", ")}`);
  if (uncoveredScenarios.length)
    blockers.push(`异常场景未覆盖：${uncoveredScenarios.join(", ")}`);
  if (sameWrongAnswerPairs(samples) < 2)
    blockers.push("相同最终答案不同错因的样例少于两对");
  if (frozenReview.approved === 0)
    blockers.push("冻结集没有任何教师复核记录，认可率不可计算");
  if (frozenReview.approvedConfirmed < REQUIRED_REVIEWED_CONFIRMED)
    blockers.push(
      `冻结集经教师复核的 confirmed 只有 ${frozenReview.approvedConfirmed} 条，门槛是 ${REQUIRED_REVIEWED_CONFIRMED} 条`,
    );
  if (
    frozenReview.acceptanceRate !== null &&
    frozenReview.acceptanceRate < REQUIRED_ACCEPTANCE_RATE
  )
    blockers.push(
      `冻结集教师认可率 ${frozenReview.acceptanceRate.toFixed(3)} 低于 ${REQUIRED_ACCEPTANCE_RATE}`,
    );
  const agreement = results.filter((r) => r.agrees).length / Math.max(samples.length, 1);
  if (agreement < 1) blockers.push(`规则输出与夹具期望不一致 ${results.length - results.filter((r) => r.agrees).length} 条`);

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: {
      version: [...new Set(files.map((file) => file.fixture.datasetVersion))],
      files: files.map((file) => ({
        path: file.path,
        version: file.fixture.datasetVersion,
        samples: file.fixture.samples.length,
      })),
      samples: samples.length,
      development: bySplit.development,
      frozen: bySplit.frozen,
    },
    versions: {
      model: [...new Set(files.map((file) => file.fixture.modelVersion))],
      rules: DIAGNOSIS_RULE_VERSION,
    },
    coverage: {
      codes: CODES.map((code) => ({
        code,
        proposed: results.filter((r) => r.sample.candidates.some((c) => c.code === code)).length,
        confirmed: confirmedByCode.get(code) ?? 0,
      })),
      sameWrongAnswerPairs: sameWrongAnswerPairs(samples),
      scenarios: [...new Set(samples.map((s) => s.scenario))].sort(),
    },
    outcomes: {
      ...outcomesOf(results),
      /** 按 split 分开统计，冻结集的测量结果不被开发集的样例数量稀释。 */
      bySplit: {
        development: outcomesOf(results.filter((r) => r.sample.split === "development")),
        frozen: outcomesOf(results.filter((r) => r.sample.split === "frozen")),
      },
      /** 规则结论与夹具期望一致的比例；夹具期望未经教师复核，不能当作认可率。 */
      fixtureAgreement: Number(agreement.toFixed(4)),
    },
    review: {
      ...reviewOf(results),
      /** 验收门槛使用的冻结集复核结果；开发集复核不计入。 */
      bySplit: {
        development: reviewOf(results.filter((r) => r.sample.split === "development")),
        frozen: frozenReview,
      },
    },
    blockers,
    thresholds: {
      requiredReviewedConfirmed: REQUIRED_REVIEWED_CONFIRMED,
      requiredAcceptanceRate: REQUIRED_ACCEPTANCE_RATE,
      passed: blockers.length === 0,
    },
    samples: results.map((r) => ({
      id: r.sample.id,
      split: r.sample.split,
      scenario: r.sample.scenario,
      expected: r.sample.expected,
      actual: {
        status: r.decision.status,
        primaryCode: r.decision.primaryCode,
      },
      agrees: r.agrees,
    })),
  };

  writeFileSync(flags.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `已写出评估报告：${flags.output}\n样本 ${samples.length}（开发 ${bySplit.development} / 冻结 ${bySplit.frozen}），confirmed ${confirmed.length}，教师复核 ${approved.length}，阻断项 ${blockers.length}`,
  );
  if (blockers.length) {
    for (const blocker of blockers) console.log(`- ${blocker}`);
    process.exitCode = 1;
  }
}

main();
