import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import {
  profileSchema,
  type EfficiencyObservation,
  type HabitObservation,
  type ProfileDTO,
  type TrainingBand,
} from "../../../../../packages/contracts/src/learning-profile.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { AuthService } from "../auth/service.js";
import {
  baselineFor,
  observeEfficiency,
  type EfficiencyBaselinePlan,
  type EfficiencySample,
} from "./efficiency.js";

const EMPTY_EFFICIENCY: EfficiencyObservation = {
  status: "insufficient_samples",
  baselineId: null,
  sampleCount: 0,
  medianMs: null,
  timeRatio: null,
  direction: null,
  reasonCodes: ["SAMPLES_BELOW_MINIMUM"],
};

type AttemptRow = {
  attempt_id: string;
  question_version_id: string;
  assessment_id: string | null;
  attempt_at: Date;
  difficulty_band: string;
  complexity_band: number;
  template_family: string | null;
  answer_type: string | null;
  correctness: string | null;
  verification: string;
  hint_dependency: string | null;
  first_attempt_ms: number | null;
  quality: string | null;
  exposure: string | null;
  prior_exposure: boolean | null;
  prior_attempts: string;
  invalidated: boolean;
};

type EvidenceCandidate = {
  attemptId: string;
  questionVersionId: string;
  assessmentId: string | null;
  attemptAt: Date;
  determinable: boolean;
  independentCorrect: boolean;
};

type BandedEvidence = EvidenceCandidate & { band: TrainingBand };

type Tx = Parameters<Parameters<typeof inTransaction>[1]>[0];

export const ATTEMPT_SQL = `
SELECT a.id AS attempt_id,
       a.question_version_id,
       s.id AS assessment_id,
       a.created_at AS attempt_at,
       qb.difficulty_band,
       qb.complexity_band,
       qb.template_family,
       r.answer_type,
       s.correctness,
       COALESCE(s.verification, v.verification) AS verification,
       s.hint_dependency,
       t.first_attempt_ms,
       t.quality,
       e.exposure,
       e.prior_exposure,
       (SELECT count(*) FROM attempts p
         WHERE p.student_id = a.student_id
           AND p.question_version_id = a.question_version_id
           AND (p.created_at < a.created_at
                OR (p.created_at = a.created_at AND p.id < a.id))) AS prior_attempts,
       EXISTS(SELECT 1 FROM evidence_invalidations i
         WHERE i.student_id = a.student_id
           AND (i.evidence_version_id = a.question_version_id
                OR i.evidence_version_id = a.message_version_id)) AS invalidated
  FROM attempts a
  JOIN question_versions v ON v.id = a.question_version_id
  JOIN LATERAL (
    SELECT b.difficulty_band, b.complexity_band, b.template_family
      FROM question_bank_entries b
      JOIN question_skill_links l
        ON l.entry_id = b.id AND l.is_primary AND l.skill_id = $2
     WHERE b.question_version_id = a.question_version_id
     ORDER BY b.version DESC, b.created_at DESC
     LIMIT 1
  ) qb ON true
  LEFT JOIN LATERAL (
    SELECT x.* FROM assessments x
     WHERE x.attempt_id = a.id
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT x.* FROM attempt_timing_snapshots x
     WHERE x.attempt_id = a.id
     ORDER BY x.version DESC
     LIMIT 1
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT x.* FROM question_references x
     WHERE x.question_version_id = a.question_version_id
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT x.* FROM tutoring_episodes x
     WHERE x.student_id = a.student_id
       AND x.question_version_id = a.question_version_id
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
  ) e ON true
 WHERE a.student_id = $1
 ORDER BY a.created_at ASC, a.id ASC`;

function nextBand(band: TrainingBand): TrainingBand {
  if (band === "repair") return "consolidation";
  if (band === "consolidation") return "advance";
  return "advance";
}

function replayPromotions(rows: EvidenceCandidate[]) {
  let band: TrainingBand = "repair";
  let bandEnteredAt = new Date(0);
  const consumedAttemptIds: string[] = [];
  let window: EvidenceCandidate[] = [];
  const banded: BandedEvidence[] = [];
  for (const row of rows) {
    banded.push({ ...row, band });
    window.push(row);
    if (window.length > 5) window.shift();
    const determinate = window.every((item) => item.determinable);
    const independentCorrect = window.filter(
      (item) => item.independentCorrect,
    ).length;
    if (
      band !== "advance" &&
      window.length === 5 &&
      determinate &&
      independentCorrect >= 4
    ) {
      band = nextBand(band);
      bandEnteredAt = row.attemptAt;
      consumedAttemptIds.push(...window.map((item) => item.attemptId));
      window = [];
    }
  }
  return { band, bandEnteredAt, consumedAttemptIds, window, banded };
}

function hintDependency(value: string | null): EfficiencySample["hintDependency"] {
  return value === "none" ||
    value === "guided" ||
    value === "solution_exposed"
    ? value
    : "unknown";
}

function exposure(value: string | null): EfficiencySample["exposure"] {
  return value === "none" ||
    value === "guided" ||
    value === "solution_exposed"
    ? value
    : "unknown";
}

function quality(value: string | null): EfficiencySample["quality"] {
  return value === "reliable" ||
    value === "partial" ||
    value === "unusable"
    ? value
    : "missing";
}

function difficulty(
  value: string,
): EfficiencySample["difficultyBand"] {
  return value === "easy" || value === "medium" || value === "challenge"
    ? value
    : "medium";
}

function sampleFrom(
  row: AttemptRow,
  studentId: string,
  skillId: string,
): EfficiencySample {
  const priorAttempts = Number(row.prior_attempts);
  return {
    id: row.attempt_id,
    studentId,
    skillId,
    questionVersionId: row.question_version_id,
    difficultyBand: difficulty(row.difficulty_band),
    answerType: row.answer_type ?? "unknown",
    complexityBand: row.complexity_band,
    templateFamily: row.template_family ?? "unknown",
    attemptAt: row.attempt_at,
    firstAttemptMs: row.first_attempt_ms,
    quality: quality(row.quality),
    verification: row.verification,
    correctness: row.correctness ?? "pending",
    hintDependency: hintDependency(row.hint_dependency),
    exposure: exposure(row.exposure),
    firstEncounter: priorAttempts === 0 && row.prior_exposure !== true,
    redo: priorAttempts > 0,
  };
}

function defaultProfile(studentId: string, skillId: string): ProfileDTO {
  return {
    studentId,
    skillId,
    version: 1,
    stale: false,
    trainingBand: "repair",
    recentIndependentCorrect: 0,
    recentDeterminateCount: 0,
    efficiency: { ...EMPTY_EFFICIENCY, reasonCodes: [...EMPTY_EFFICIENCY.reasonCodes] },
    evidence: [],
  };
}

export class LearningProfileService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}

  async get(scope: StudentScope, skillId: string): Promise<ProfileDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.db.pool.query(
        `SELECT * FROM learning_profiles WHERE student_id=$1 AND skill_id=$2`,
        [scope.studentId, skillId],
      )
    ).rows[0];
    if (!row) {
      return {
        ...defaultProfile(scope.studentId, skillId),
        habits: await this.habits(scope.studentId, skillId),
      };
    }
    return profileSchema.parse({
      ...this.toDTO(scope.studentId, skillId, row, []),
      habits: await this.habits(scope.studentId, skillId),
    });
  }

  async list(scope: StudentScope): Promise<ProfileDTO[]> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const rows = (
      await this.db.pool.query(
        `SELECT * FROM learning_profiles WHERE student_id=$1 ORDER BY skill_id`,
        [scope.studentId],
      )
    ).rows;
    const habits = await this.habits(scope.studentId, null);
    return rows.map((row) =>
      profileSchema.parse({
        ...this.toDTO(scope.studentId, row.skill_id, row, []),
        habits: habits.filter((habit) => habit.skillId === row.skill_id),
      }),
    );
  }

  private async habits(
    studentId: string,
    skillId: string | null,
  ): Promise<(HabitObservation & { skillId: string })[]> {
    const rows = (
      await this.db.pool.query<{
        skill_id: string;
        anchor_code: string;
        independent_check_count: number;
        successful_correction_count: number;
      }>(
        `SELECT skill_id, anchor_code, independent_check_count,
                successful_correction_count
           FROM learning_habits
          WHERE student_id=$1 AND ($2::uuid IS NULL OR skill_id=$2)
          ORDER BY anchor_code`,
        [studentId, skillId],
      )
    ).rows;
    return rows.map((row) => ({
      skillId: row.skill_id,
      anchorCode: row.anchor_code,
      independentCheckCount: Number(row.independent_check_count),
      successfulCorrectionCount: Number(row.successful_correction_count),
    }));
  }

  async rebuild(scope: StudentScope, skillId: string): Promise<ProfileDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return this.rebuildSystem(scope.studentId, skillId);
  }

  async rebuildSystem(
    studentId: string,
    skillId: string,
  ): Promise<ProfileDTO> {
    return inTransaction(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO learning_profiles(student_id,skill_id) VALUES($1,$2)
         ON CONFLICT (student_id,skill_id) DO NOTHING`,
        [studentId, skillId],
      );
      const current = (
        await tx.query(
          `SELECT * FROM learning_profiles WHERE student_id=$1 AND skill_id=$2 FOR UPDATE`,
          [studentId, skillId],
        )
      ).rows[0];

      const rows = (
        (await tx.query(ATTEMPT_SQL, [studentId, skillId])).rows as AttemptRow[]
      ).filter(
        (row) => !row.invalidated && Number(row.prior_attempts) === 0,
      );

      const candidates: EvidenceCandidate[] = rows.map((row) => ({
        attemptId: row.attempt_id,
        questionVersionId: row.question_version_id,
        assessmentId: row.assessment_id,
        attemptAt: row.attempt_at,
        determinable:
          row.verification === "verified" &&
          (row.correctness === "correct" || row.correctness === "incorrect"),
        independentCorrect:
          row.verification === "verified" &&
          row.correctness === "correct" &&
          row.hint_dependency === "none" &&
          (row.exposure ?? "unknown") === "none" &&
          row.prior_exposure !== true,
      }));

      const replay = replayPromotions(candidates);

      await tx.query(
        `DELETE FROM learning_profile_evidence WHERE profile_id=$1`,
        [current.id],
      );
      for (const evidence of replay.banded) {
        await tx.query(
          `INSERT INTO learning_profile_evidence(
             student_id,skill_id,profile_id,attempt_id,question_version_id,
             assessment_id,band,independent_correct,determinable,attempt_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (student_id,skill_id,question_version_id) DO NOTHING`,
          [
            studentId,
            skillId,
            current.id,
            evidence.attemptId,
            evidence.questionVersionId,
            evidence.assessmentId,
            evidence.band,
            evidence.independentCorrect,
            evidence.determinable,
            evidence.attemptAt,
          ],
        );
      }

      const samples = rows.map((row) => sampleFrom(row, studentId, skillId));
      // 当前样本按作答时间取最后一条，重做或无效计时由效率规则判定为 ineligible。
      let observation: EfficiencyObservation = EMPTY_EFFICIENCY;
      let baselineId: string | null = current.baseline_id;
      const latest = samples[samples.length - 1];
      if (latest) {
        observation = observeEfficiency(latest, samples, baselineId);
        if (observation.status === "observed") {
          const plan = baselineFor(latest, samples);
          baselineId = await this.freezeBaseline(tx, studentId, skillId, plan);
          observation = observeEfficiency(latest, samples, baselineId);
        }
      }

      const knowledgeStats = {
        correct: rows.filter((row) => row.correctness === "correct").length,
        incorrect: rows.filter((row) => row.correctness === "incorrect").length,
        pending: rows.filter((row) => row.correctness === null).length,
        independentCorrect: candidates.filter((item) => item.independentCorrect)
          .length,
        determinable: candidates.filter((item) => item.determinable).length,
        recentIndependentCorrect: replay.window.filter(
          (item) => item.independentCorrect,
        ).length,
        recentDeterminateCount: replay.window.filter(
          (item) => item.determinable,
        ).length,
      };
      const hintStats = {
        none: rows.filter((row) => row.hint_dependency === "none").length,
        guided: rows.filter((row) => row.hint_dependency === "guided").length,
        solutionExposed: rows.filter(
          (row) => row.hint_dependency === "solution_exposed",
        ).length,
        unknown: rows.filter(
          (row) =>
            row.hint_dependency !== "none" &&
            row.hint_dependency !== "guided" &&
            row.hint_dependency !== "solution_exposed",
        ).length,
      };

      const promoted = replay.band !== current.training_band;
      const version =
        promoted || current.stale || baselineId !== current.baseline_id
          ? current.version + 1
          : current.version;

      if (replay.consumedAttemptIds.length > 0) {
        await tx.query(
          `UPDATE learning_profile_evidence SET consumed_by_version=$3
            WHERE profile_id=$1 AND attempt_id = ANY($2::uuid[])`,
          [current.id, replay.consumedAttemptIds, version],
        );
      }

      await tx.query(
        `UPDATE learning_profiles
            SET version=$2, training_band=$3, band_entered_at=$4,
                consumed_promotion_evidence_ids=$5, stale=false,
                knowledge_stats=$6, hint_stats=$7, efficiency=$8,
                baseline_id=$9, updated_at=now()
          WHERE id=$1`,
        [
          current.id,
          version,
          replay.band,
          replay.bandEnteredAt,
          JSON.stringify(replay.consumedAttemptIds),
          JSON.stringify(knowledgeStats),
          JSON.stringify(hintStats),
          JSON.stringify(observation),
          baselineId,
        ],
      );

      return profileSchema.parse({
        studentId,
        skillId,
        version,
        stale: false,
        trainingBand: replay.band,
        recentIndependentCorrect: replay.window.filter(
          (item) => item.independentCorrect,
        ).length,
        recentDeterminateCount: replay.window.filter(
          (item) => item.determinable,
        ).length,
        efficiency: observation,
        evidence: replay.window.slice(-5).map((item) => ({
          kind: "attempt",
          id: item.attemptId,
          versionId: item.questionVersionId,
        })),
      });
    });
  }

  private async freezeBaseline(
    tx: Tx,
    studentId: string,
    skillId: string,
    plan: EfficiencyBaselinePlan,
  ): Promise<string> {
    const existing = await tx.query(
      `SELECT id FROM learning_profile_baselines
        WHERE student_id=$1 AND skill_id=$2 AND bucket_key=$3
          AND as_of=$4 AND policy_version=$5
        ORDER BY created_at DESC LIMIT 1`,
      [studentId, skillId, plan.bucketKey, plan.windowEnd, plan.policyVersion],
    );
    if (existing.rowCount) return existing.rows[0].id;
    const inserted = await tx.query(
      `INSERT INTO learning_profile_baselines(
         student_id,skill_id,bucket_key,window_start,window_end,
         median_ms,sample_ids,as_of,policy_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        studentId,
        skillId,
        plan.bucketKey,
        plan.windowStart,
        plan.windowEnd,
        plan.medianMs,
        JSON.stringify(plan.sampleIds),
        plan.windowEnd,
        plan.policyVersion,
      ],
    );
    return inserted.rows[0].id;
  }

  private toDTO(
    studentId: string,
    skillId: string,
    row: Record<string, unknown>,
    evidence: ProfileDTO["evidence"],
  ): ProfileDTO {
    const stats = (row.knowledge_stats ?? {}) as Record<string, number>;
    const stored = (row.efficiency ?? {}) as Partial<EfficiencyObservation>;
    return {
      studentId,
      skillId,
      version: Number(row.version),
      stale: Boolean(row.stale),
      trainingBand: row.training_band as TrainingBand,
      recentIndependentCorrect: Number(stats.recentIndependentCorrect ?? 0),
      recentDeterminateCount: Number(stats.recentDeterminateCount ?? 0),
      efficiency: {
        status: stored.status ?? "insufficient_samples",
        baselineId: stored.baselineId ?? null,
        sampleCount: stored.sampleCount ?? 0,
        medianMs: stored.medianMs ?? null,
        timeRatio: stored.timeRatio ?? null,
        direction: stored.direction ?? null,
        reasonCodes: stored.reasonCodes ?? [],
      },
      evidence,
    };
  }
}
