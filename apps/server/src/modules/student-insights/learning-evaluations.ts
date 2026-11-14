import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import {
  learningEvaluationSchema,
  type EvaluationBaselineFact,
  type EvaluationDelayedReviewFact,
  type EvaluationDiagnosisFact,
  type EvaluationFirstAttemptFact,
  type EvaluationGroupSampleFact,
  type EvaluationSelfCheckFact,
  type EvaluationWindow,
  type LearningEvaluationDTO,
} from "../../../../../packages/contracts/src/learning-evaluation.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import {
  BASELINE_POLICY_VERSION,
  efficiencyBucketKey,
} from "../learning-profile/efficiency.js";
import { computeGroupReference, computeLearningMetrics } from "./learning-metrics.js";
import { resolveInsightRange } from "./metrics.js";
import { requireAdminInsightScope } from "./policy.js";

export const LEARNING_EVALUATION_VERSION = "learning-evaluation-v1";

const VALID_ATTEMPT = `NOT EXISTS (
  SELECT 1 FROM evidence_invalidations i
  WHERE i.student_id = a.student_id
    AND (i.evidence_version_id = a.question_version_id
      OR i.evidence_version_id = a.message_version_id)
)`;

const FIRST_ATTEMPT_SQL = `
  SELECT a.id AS "attemptId",
    a.question_version_id AS "questionVersionId",
    skill.skill_id AS "skillId",
    qbe.difficulty_band AS "difficultyBand",
    qbe.complexity_band AS "complexityBand",
    qr.answer_type AS "answerType",
    COALESCE(e.exposure, 'unknown') AS exposure,
    COALESCE(e.prior_exposure, false) AS "priorExposure",
    NOT EXISTS (
      SELECT 1 FROM attempts p
      WHERE p.student_id = a.student_id
        AND p.question_version_id = a.question_version_id
        AND (p.created_at < a.created_at
          OR (p.created_at = a.created_at AND p.id < a.id))
    ) AS "firstEncounter",
    s.correctness, s.verification,
    t.quality AS "timingQuality",
    t.first_attempt_ms AS "timingMs",
    COALESCE(t.reason_codes, '[]'::jsonb) AS "timingReasonCodes"
  FROM attempts a
  LEFT JOIN LATERAL (
    SELECT x.correctness, x.verification FROM assessments x
    WHERE x.attempt_id = a.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT x.exposure, x.prior_exposure FROM tutoring_episodes x
    WHERE x.student_id = a.student_id AND x.question_version_id = a.question_version_id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) e ON true
  LEFT JOIN question_bank_entries qbe ON qbe.question_version_id = a.question_version_id
  LEFT JOIN LATERAL (
    SELECT l.skill_id FROM question_skill_links l
    WHERE l.entry_id = qbe.id AND l.is_primary
    ORDER BY l.skill_id LIMIT 1
  ) skill ON true
  LEFT JOIN LATERAL (
    SELECT x.answer_type FROM question_references x
    WHERE x.question_version_id = a.question_version_id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) qr ON true
  LEFT JOIN LATERAL (
    SELECT x.quality, x.first_attempt_ms, x.reason_codes
    FROM attempt_timing_snapshots x
    WHERE x.attempt_id = a.id
    ORDER BY x.version DESC LIMIT 1
  ) t ON true
  WHERE a.student_id = $1 AND a.created_at >= $2 AND a.created_at < $3
    AND ${VALID_ATTEMPT}
  ORDER BY a.created_at, a.id
`;

const SELF_CHECK_SQL = `
  SELECT o.episode_id AS "episodeId", o.round_no AS "roundNo", o.outcome,
    CASE WHEN o.after_attempt_id IS NULL THEN false ELSE EXISTS (
      SELECT 1 FROM assessments s
      WHERE s.attempt_id = o.after_attempt_id
        AND s.verification = 'verified' AND s.correctness = 'correct'
    ) END AS "verifiedCorrection",
    CASE
      WHEN jsonb_typeof(o.evidence) = 'object' THEN o.evidence ->> 'anchorCode'
      WHEN jsonb_typeof(o.evidence) = 'array' AND jsonb_array_length(o.evidence) > 0
        THEN o.evidence -> 0 ->> 'anchorCode'
      ELSE NULL
    END AS "anchorCode",
    CASE
      WHEN act.id IS NULL OR h.id IS NULL THEN 'none'
      WHEN h.level ILIKE '%answer%' THEN 'answer'
      ELSE 'hint'
    END AS "hintLevel"
  FROM self_check_outcomes o
  JOIN tutoring_episodes e ON e.id = o.episode_id
  LEFT JOIN tutoring_actions act ON act.id = o.action_id
  LEFT JOIN hints h ON h.id = act.hint_id
  WHERE e.student_id = $1 AND o.created_at >= $2 AND o.created_at < $3
  ORDER BY o.created_at, o.id
`;

const DELAYED_REVIEW_SQL = `
  SELECT m.id AS "mistakeId", m.due_at AS "dueAt",
    EXISTS (
      SELECT 1 FROM mistake_state_events ev
      JOIN attempts ea ON ea.id = ev.attempt_id
      WHERE ev.mistake_id = m.id
        AND ev.assessment_id IS NOT NULL
        AND ev.evidence_at >= m.due_at
        AND ea.student_id = m.student_id
        AND NOT EXISTS (
          SELECT 1 FROM evidence_invalidations i
          WHERE i.student_id = ea.student_id
            AND (i.evidence_version_id = ea.question_version_id
              OR i.evidence_version_id = ea.message_version_id)
        )
    ) AS completed,
    EXISTS (
      SELECT 1 FROM mistake_state_events ev
      JOIN attempts ea ON ea.id = ev.attempt_id
      JOIN assessments s ON s.id = ev.assessment_id
      WHERE ev.mistake_id = m.id
        AND ev.to_state = 'mastered'
        AND ev.evidence_at >= m.due_at
        AND ea.student_id = m.student_id
        AND s.verification = 'verified' AND s.correctness = 'correct'
        AND s.hint_dependency = 'none'
        AND NOT EXISTS (
          SELECT 1 FROM evidence_invalidations i
          WHERE i.student_id = ea.student_id
            AND (i.evidence_version_id = ea.question_version_id
              OR i.evidence_version_id = ea.message_version_id)
        )
    ) AS "independentPass"
  FROM student_mistakes m
  WHERE m.student_id = $1 AND m.due_at >= $2 AND m.due_at < $3
  ORDER BY m.due_at, m.id
`;

const DIAGNOSIS_SQL = `
  SELECT a.id AS "attemptId",
    COALESCE(d.status, 'pending') AS status,
    d.primary_code AS "primaryCode",
    COALESCE(d.rule_version, 'diagnosis-v1') AS "ruleVersion",
    COALESCE(qr.answer_type, 'unknown') AS "questionType",
    COALESCE(qbe.source_type, 'unknown') AS source,
    r.decision AS "reviewDecision"
  FROM attempts a
  LEFT JOIN LATERAL (
    SELECT x.correctness, x.verification FROM assessments x
    WHERE x.attempt_id = a.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT x.status, x.primary_code, x.rule_version FROM error_diagnoses x
    WHERE x.attempt_id = a.id AND x.invalidated_at IS NULL
    ORDER BY x.version DESC, x.created_at DESC, x.id DESC LIMIT 1
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT x.decision FROM diagnosis_reviews x
    WHERE x.attempt_id = a.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) r ON true
  LEFT JOIN question_bank_entries qbe ON qbe.question_version_id = a.question_version_id
  LEFT JOIN LATERAL (
    SELECT x.answer_type FROM question_references x
    WHERE x.question_version_id = a.question_version_id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) qr ON true
  WHERE a.student_id = $1 AND a.created_at >= $2 AND a.created_at < $3
    AND s.verification = 'verified' AND s.correctness = 'incorrect'
    AND ${VALID_ATTEMPT}
  ORDER BY a.created_at, a.id
`;

const BASELINE_SQL = `
  SELECT DISTINCT ON (bucket_key)
    bucket_key AS "bucketKey", skill_id AS "skillId", median_ms AS "medianMs",
    COALESCE(jsonb_array_length(sample_ids), 0) AS "sampleCount",
    as_of AS "asOf", policy_version AS "policyVersion"
  FROM learning_profile_baselines
  WHERE student_id = $1
  ORDER BY bucket_key, as_of DESC, created_at DESC
`;

const GROUP_SAMPLE_SQL = `
  SELECT a.student_id AS "studentId", a.id AS "sampleKey"
  FROM attempts a
  JOIN LATERAL (
    SELECT x.correctness, x.verification FROM assessments x
    WHERE x.attempt_id = a.id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) s ON true
  JOIN LATERAL (
    SELECT x.quality, x.first_attempt_ms FROM attempt_timing_snapshots x
    WHERE x.attempt_id = a.id
    ORDER BY x.version DESC LIMIT 1
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT x.exposure, x.prior_exposure FROM tutoring_episodes x
    WHERE x.student_id = a.student_id AND x.question_version_id = a.question_version_id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) e ON true
  JOIN question_bank_entries qbe ON qbe.question_version_id = a.question_version_id
  JOIN LATERAL (
    SELECT l.skill_id FROM question_skill_links l
    WHERE l.entry_id = qbe.id AND l.is_primary
    ORDER BY l.skill_id LIMIT 1
  ) skill ON true
  JOIN LATERAL (
    SELECT x.answer_type FROM question_references x
    WHERE x.question_version_id = a.question_version_id
    ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) qr ON true
  WHERE a.created_at >= $1 AND a.created_at < $2
    AND CONCAT(skill.skill_id, '|', qbe.difficulty_band, '|', qr.answer_type, '|',
      qbe.complexity_band) = ANY($3::text[])
    AND s.verification = 'verified' AND s.correctness = 'correct'
    AND t.quality = 'reliable' AND t.first_attempt_ms IS NOT NULL
    AND COALESCE(e.exposure, 'unknown') = 'none'
    AND COALESCE(e.prior_exposure, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM attempts p
      WHERE p.student_id = a.student_id
        AND p.question_version_id = a.question_version_id
        AND (p.created_at < a.created_at
          OR (p.created_at = a.created_at AND p.id < a.id))
    )
    AND NOT EXISTS (
      SELECT 1 FROM evidence_invalidations i
      WHERE i.student_id = a.student_id
        AND (i.evidence_version_id = a.question_version_id
          OR i.evidence_version_id = a.message_version_id)
    )
`;

const STALE_SQL = `
  SELECT count(*)::int AS count
  FROM attempts a
  WHERE a.student_id = $1 AND a.created_at >= $2 AND a.created_at < $3
    AND EXISTS (
      SELECT 1 FROM evidence_invalidations i
      WHERE i.student_id = a.student_id
        AND (i.evidence_version_id = a.question_version_id
          OR i.evidence_version_id = a.message_version_id)
    )
`;

type AttemptRow = {
  attemptId: string;
  questionVersionId: string;
  skillId: string | null;
  difficultyBand: string | null;
  complexityBand: number | null;
  answerType: string | null;
  exposure: string;
  priorExposure: boolean;
  firstEncounter: boolean;
  correctness: string | null;
  verification: string | null;
  timingQuality: string;
  timingMs: number | null;
  timingReasonCodes: string[] | null;
};

type SelfCheckRow = {
  episodeId: string;
  roundNo: number;
  outcome: string;
  verifiedCorrection: boolean;
  anchorCode: string | null;
  hintLevel: string;
};

type ReviewRow = {
  mistakeId: string;
  dueAt: Date;
  completed: boolean;
  independentPass: boolean;
};

type DiagnosisRow = {
  attemptId: string;
  status: string;
  primaryCode: string | null;
  ruleVersion: string;
  questionType: string;
  source: string;
  reviewDecision: string | null;
};

function toFirstAttempt(row: AttemptRow): EvaluationFirstAttemptFact {
  const determinable =
    row.verification === "verified" &&
    (row.correctness === "correct" || row.correctness === "incorrect");
  return {
    attemptId: row.attemptId,
    questionVersionId: row.questionVersionId,
    skillId: row.skillId,
    bucketKey:
      row.skillId && row.difficultyBand && row.answerType && row.complexityBand !== null
        ? efficiencyBucketKey({
            skillId: row.skillId,
            difficultyBand: row.difficultyBand,
            answerType: row.answerType,
            complexityBand: row.complexityBand,
          })
        : null,
    exposure: (row.exposure ?? "unknown") as EvaluationFirstAttemptFact["exposure"],
    priorExposure: row.priorExposure,
    firstEncounter: row.firstEncounter,
    determinable,
    correct: row.correctness === "correct",
    timingQuality: row.timingQuality as EvaluationFirstAttemptFact["timingQuality"],
    timingMs: row.timingMs,
    timingReasonCodes: row.timingReasonCodes ?? [],
  };
}

function toSelfCheck(row: SelfCheckRow): EvaluationSelfCheckFact {
  return {
    episodeId: row.episodeId,
    roundNo: row.roundNo,
    outcome: row.outcome as EvaluationSelfCheckFact["outcome"],
    verifiedCorrection: row.verifiedCorrection,
    anchorCode: row.anchorCode,
    hintLevel: row.hintLevel as EvaluationSelfCheckFact["hintLevel"],
  };
}

function toReview(row: ReviewRow): EvaluationDelayedReviewFact {
  return {
    mistakeId: row.mistakeId,
    dueAt: row.dueAt,
    completed: row.completed,
    independentPass: row.completed ? row.independentPass : null,
  };
}

function toDiagnosis(row: DiagnosisRow): EvaluationDiagnosisFact {
  return {
    attemptId: row.attemptId,
    diagnosable: true,
    status: row.status as EvaluationDiagnosisFact["status"],
    primaryCode: row.primaryCode,
    questionType: row.questionType,
    source: row.source,
    ruleVersion: row.ruleVersion,
    reviewDecision: row.reviewDecision as EvaluationDiagnosisFact["reviewDecision"],
    reviewedAcceptedPrimary: row.reviewDecision === "accept",
  };
}

export type LearningEvaluationOptions = {
  groupReferenceEnabled?: boolean;
  now?: () => Date;
};

export class LearningEvaluationService {
  constructor(
    private readonly database: Database,
    private readonly options: LearningEvaluationOptions = {},
  ) {}

  async snapshot(
    actor: Actor,
    studentId: string,
    window: EvaluationWindow,
  ): Promise<LearningEvaluationDTO> {
    const scope = await requireAdminInsightScope(
      this.database,
      actor,
      studentId,
    );
    const now = this.options.now?.() ?? new Date();
    const range = resolveInsightRange(window, now);
    const pool = this.database.pool;

    const [attemptRows, selfCheckRows, reviewRows, diagnosisRows, baselineRows, stale] =
      await Promise.all([
        pool.query<AttemptRow>(FIRST_ATTEMPT_SQL, [
          studentId,
          range.start,
          range.endExclusive,
        ]),
        pool.query<SelfCheckRow>(SELF_CHECK_SQL, [
          studentId,
          range.start,
          range.endExclusive,
        ]),
        pool.query<ReviewRow>(DELAYED_REVIEW_SQL, [
          studentId,
          range.start,
          range.endExclusive,
        ]),
        pool.query<DiagnosisRow>(DIAGNOSIS_SQL, [
          studentId,
          range.start,
          range.endExclusive,
        ]),
        pool.query<EvaluationBaselineFact>(BASELINE_SQL, [studentId]),
        pool.query<{ count: number }>(STALE_SQL, [
          studentId,
          range.start,
          range.endExclusive,
        ]),
      ]);

    const groupReferenceEnabled = this.options.groupReferenceEnabled ?? false;
    const firstAttempts = attemptRows.rows.map(toFirstAttempt);
    const buckets = [...new Set(firstAttempts.map((row) => row.bucketKey))]
      .filter((key): key is string => key !== null)
      .sort();
    const groupSamples: EvaluationGroupSampleFact[] =
      groupReferenceEnabled && buckets.length > 0
        ? (
            await pool.query<EvaluationGroupSampleFact>(GROUP_SAMPLE_SQL, [
              range.start,
              range.endExclusive,
              buckets,
            ])
          ).rows
        : [];

    const baselines = baselineRows.rows.map((row) => ({
      bucketKey: row.bucketKey,
      skillId: row.skillId,
      medianMs: row.medianMs,
      sampleCount: row.sampleCount,
      asOf: new Date(row.asOf).toISOString(),
      policyVersion: row.policyVersion,
    }));

    const diagnosisVersion =
      diagnosisRows.rows[0]?.ruleVersion ?? "diagnosis-v1";
    const facts = {
      firstAttempts,
      selfCheckRounds: selfCheckRows.rows.map(toSelfCheck),
      delayedReviews: reviewRows.rows.map(toReview),
      diagnoses: diagnosisRows.rows.map(toDiagnosis),
      baselines: baselines.map((row) => ({
        bucketKey: row.bucketKey,
        skillId: row.skillId,
        medianMs: row.medianMs,
        sampleCount: row.sampleCount,
        asOf: new Date(row.asOf),
        policyVersion: row.policyVersion,
      })),
      questionQuality: [],
      groupSamples,
      groupReferenceEnabled,
      versions: {},
      dataAsOf: now,
      staleEvidenceCount: stale.rows[0]?.count ?? 0,
    };

    const metrics = computeLearningMetrics(facts);
    const groupReference = computeGroupReference(facts);
    const versions = {
      metrics: LEARNING_EVALUATION_VERSION,
      efficiency: BASELINE_POLICY_VERSION,
      diagnosis: diagnosisVersion,
    };

    const dto = learningEvaluationSchema.parse({
      studentId: scope.studentId,
      from: range.from,
      to: range.to,
      metrics,
      sampleSize: firstAttempts.length,
      baselines,
      groupReference,
      versions,
      dataAsOf: now.toISOString(),
      generatedAt: now.toISOString(),
      staleEvidenceCount: facts.staleEvidenceCount,
    });

    await pool.query(
      `INSERT INTO learning_evaluations
        (student_id, from_date, to_date, metric_version, metrics, sample_size,
         versions, stale_evidence_count, generated_at, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10)`,
      [
        studentId,
        range.from,
        range.to,
        LEARNING_EVALUATION_VERSION,
        JSON.stringify(metrics),
        dto.sampleSize,
        JSON.stringify(versions),
        dto.staleEvidenceCount,
        now,
        scope.actor.userId,
      ],
    );

    return dto;
  }
}
