import { createHash } from "node:crypto";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import {
  practiceDecisionSchema,
  selectionRequestSchema,
  type EfficiencyObservation,
  type PracticeDecisionDTO,
  type ProfileDTO,
  type SelectionRequest,
  type TrainingBand,
} from "../../../../../packages/contracts/src/learning-profile.js";
import type {
  BankCandidate,
  PracticeGoal,
} from "../../../../../packages/contracts/src/question-bank.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
import { searchEligibleQuestions } from "../question-bank/search.js";
import {
  choosePractice,
  goalFor,
  SELECTION_POLICY_VERSION,
  type RecentDecision,
  type ReviewCandidate,
} from "./selection-policy.js";

const MAX_FORMAL_ITEMS = 5;
const RECENT_WINDOW = 20;
const CANDIDATE_LIMIT = 50;

const GOAL_ITEM_ROLE: Record<PracticeGoal, "original" | "variant" | "diagnostic"> = {
  diagnostic: "diagnostic",
  review: "variant",
  repair: "original",
  transfer: "original",
};

type DecisionRow = {
  id: string;
  status: string;
  goal: string;
  difficulty: string | null;
  question_version_id: string | null;
  policy_version: string;
  profile_version: number;
  explanation: string;
  baseline_id: string | null;
};

function requestHash(input: SelectionRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({ expectedProfileVersion: input.expectedProfileVersion }))
    .digest("hex");
}

function explain(
  status: "selected" | "insufficient_pool" | "awaiting_diagnosis",
  goal: PracticeGoal,
  reasonCodes: string[],
): string {
  if (status === "awaiting_diagnosis")
    return "学情证据还在整理，先完成诊断或等画像更新后再安排新题。";
  if (status === "insufficient_pool")
    return "当前题库没有符合条件的题目，可以继续讲解，或等题库补充后再练。";
  const base: Record<PracticeGoal, string> = {
    diagnostic: "先完成当前题相关的诊断追问，再继续新的练习。",
    review: "这道题对应的知识到期了，先复习一遍再往前学。",
    repair: "最近这部分还有没稳住的地方，先补上这一步。",
    transfer: "这部分已经比较稳，换一种情境再验证一次。",
  };
  const extra = reasonCodes.includes("relaxed_difficulty")
    ? "题库暂时没有对应难度的新题，先安排相近难度。"
    : reasonCodes.includes("method_optimization")
      ? "答案正确但偏慢，这次可以留意更省时间的做法。"
      : "";
  return base[goal] + extra;
}

function toDTO(row: DecisionRow): PracticeDecisionDTO {
  return practiceDecisionSchema.parse({
    id: row.id,
    status: row.status,
    questionVersionId: row.question_version_id,
    goal: row.goal,
    difficulty: row.difficulty,
    policyVersion: row.policy_version,
    profileVersion: Number(row.profile_version),
    explanation: row.explanation,
    baselineId: row.baseline_id,
  });
}

export class SelectionService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}

  async next(
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ): Promise<PracticeDecisionDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const request = selectionRequestSchema.parse(input);
    const hash = requestHash(request);
    return inTransaction(this.db, async (tx) => {
      const task = (
        await tx.query(
          `SELECT id FROM learning_tasks
            WHERE id=$1 AND student_id=$2 AND deleted_at IS NULL
            FOR UPDATE`,
          [taskId, scope.studentId],
        )
      ).rows[0];
      if (!task) throw new AppError("NOT_FOUND", 404, "任务不存在");

      const replay = (
        await tx.query<DecisionRow>(
          `SELECT id,status,goal,difficulty,question_version_id,policy_version,
                  profile_version,explanation,baseline_id
             FROM practice_decisions
            WHERE student_id=$1 AND task_id=$2 AND request_key=$3`,
          [scope.studentId, taskId, request.requestKey],
        )
      ).rows[0];
      if (replay) {
        const stored = (
          await tx.query(
            `SELECT request_hash FROM practice_decisions
              WHERE student_id=$1 AND task_id=$2 AND request_key=$3`,
            [scope.studentId, taskId, request.requestKey],
          )
        ).rows[0]!;
        if (stored.request_hash !== hash)
          throw new AppError("CONFLICT", 409, "同一请求标识的参数不一致");
        return toDTO(replay);
      }

      const profileRow = (
        await tx.query(
          `SELECT * FROM learning_profiles
            WHERE student_id=$1 AND version=$2
            ORDER BY CASE training_band
                       WHEN 'repair' THEN 0
                       WHEN 'consolidation' THEN 1
                       ELSE 2 END,
                     COALESCE((knowledge_stats->>'recentIndependentCorrect')::int,0) ASC,
                     skill_id
            LIMIT 1
            FOR UPDATE`,
          [scope.studentId, request.expectedProfileVersion],
        )
      ).rows[0];
      const anyProfile = (
        await tx.query(
          `SELECT 1 FROM learning_profiles WHERE student_id=$1 LIMIT 1`,
          [scope.studentId],
        )
      ).rowCount;
      if (!profileRow && anyProfile)
        throw new AppError("CONFLICT", 409, "学情版本已更新，请刷新后重试");

      const profile = profileRow
        ? this.profileFromRow(scope.studentId, profileRow)
        : null;
      const skillId = profile?.skillId ?? null;

      const openDiagnosis = Boolean(
        (
          await tx.query(
            `SELECT 1 FROM task_items
              WHERE task_id=$1 AND role='diagnostic' AND status='pending'`,
            [taskId],
          )
        ).rowCount,
      );

      const recentRows = (
        await tx.query(
          `SELECT d.goal, d.difficulty, d.question_version_id, e.template_family
             FROM practice_decisions d
             LEFT JOIN question_bank_entries e
               ON e.question_version_id = d.question_version_id
            WHERE d.student_id=$1
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT $2`,
          [scope.studentId, RECENT_WINDOW],
        )
      ).rows;
      const recentDecisions: RecentDecision[] = recentRows
        .reverse()
        .map((row) => ({
          goal: row.goal as PracticeGoal,
          difficulty: row.difficulty,
          questionVersionId: row.question_version_id,
          templateFamily: row.template_family,
        }));

      const dueReviews = skillId
        ? (
            await tx.query(
              `SELECT DISTINCT ON (v.id) v.id AS question_version_id,
                      l.skill_id, m.due_at, m.question_id
                 FROM student_mistakes m
                 JOIN LATERAL (
                   SELECT qv.id FROM question_versions qv
                    WHERE qv.question_id = m.question_id
                    ORDER BY qv.version_no DESC, qv.created_at DESC, qv.id DESC
                    LIMIT 1
                 ) v ON true
                 JOIN question_bank_entries e
                   ON e.question_version_id = v.id AND e.status='published'
                 JOIN question_skill_links l
                   ON l.entry_id = e.id AND l.is_primary AND l.skill_id=$2
                WHERE m.student_id=$1
                  AND m.due_at IS NOT NULL AND m.due_at <= now()
                  AND m.status <> 'mastered'
                ORDER BY v.id, m.due_at`,
              [scope.studentId, skillId],
            )
          ).rows.map(
            (row): ReviewCandidate => ({
              questionVersionId: row.question_version_id,
              skillId: row.skill_id,
              dueAt: new Date(row.due_at).toISOString(),
              sourceQuestionId: row.question_id,
            }),
          )
        : [];

      let candidates: BankCandidate[] = [];
      if (profile && !profile.stale) {
        const excludeVersionIds = recentDecisions
          .map((item) => item.questionVersionId)
          .filter((id): id is string => !!id);
        candidates = await searchEligibleQuestions(tx, scope, {
          skillId: profile.skillId,
          goal: goalFor(profile, openDiagnosis, dueReviews).goal,
          excludeVersionIds,
          limit: CANDIDATE_LIMIT,
        });
      }

      const choice = profile
        ? choosePractice({
            profile,
            recentDecisions,
            candidates,
            dueReviews,
            openDiagnosis,
          })
        : {
            status: "awaiting_diagnosis" as const,
            goal: "repair" as PracticeGoal,
            difficulty: null,
            candidateId: null,
            reasonCodes: ["no_profile"],
          };

      let questionVersionId: string | null = null;
      let entryId: string | null = null;
      if (choice.status === "selected") {
        const formal = (
          await tx.query(
            `SELECT count(*)::int AS total FROM task_items
              WHERE task_id=$1 AND role IN ('original','variant')`,
            [taskId],
          )
        ).rows[0].total as number;
        if (formal >= MAX_FORMAL_ITEMS)
          throw new AppError("CONFLICT", 409, "本次每日5练已安排5题");
        const chosen = candidates.find(
          (item) => item.questionVersionId === choice.candidateId,
        );
        questionVersionId = choice.candidateId;
        entryId = chosen?.entryId ?? null;
        const position = (
          await tx.query(
            `SELECT COALESCE(max(position),0) + 1 AS next FROM task_items WHERE task_id=$1`,
            [taskId],
          )
        ).rows[0].next as number;
        await tx.query(
          `INSERT INTO task_items(task_id,question_version_id,position,role)
           VALUES($1,$2,$3,$4)`,
          [taskId, questionVersionId, position, GOAL_ITEM_ROLE[choice.goal]],
        );
      }

      const explanation = explain(
        choice.status,
        choice.goal,
        choice.reasonCodes,
      );
      const inserted = (
        await tx.query<DecisionRow>(
          `INSERT INTO practice_decisions(
             student_id,task_id,request_key,request_hash,policy_version,
             profile_version,status,goal,difficulty,entry_id,question_version_id,
             skill_id,baseline_id,explanation,reason_codes,candidate_snapshot,
             exclusions,recent_window)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           RETURNING id,status,goal,difficulty,question_version_id,policy_version,
                     profile_version,explanation,baseline_id`,
          [
            scope.studentId,
            taskId,
            request.requestKey,
            hash,
            SELECTION_POLICY_VERSION,
            profile?.version ?? request.expectedProfileVersion,
            choice.status,
            choice.goal,
            choice.difficulty,
            entryId,
            questionVersionId,
            skillId,
            profile?.efficiency.baselineId ?? null,
            explanation,
            JSON.stringify(choice.reasonCodes),
            JSON.stringify(
              candidates.map((item) => ({
                entryId: item.entryId,
                questionVersionId: item.questionVersionId,
                difficulty: item.difficulty,
                templateFamily: item.templateFamily,
                matchedCauseCount: item.matchedCauseCount,
                seenCount: item.seenCount,
              })),
            ),
            JSON.stringify(
              candidates.length === 0
                ? [{ reason: choice.reasonCodes.at(-1) ?? "no_candidates" }]
                : [],
            ),
            JSON.stringify(recentDecisions),
          ],
        )
      ).rows[0]!;
      return toDTO(inserted);
    });
  }

  async replay(
    scope: StudentScope,
    decisionId: string,
  ): Promise<PracticeDecisionDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.db.pool.query<DecisionRow>(
        `SELECT id,status,goal,difficulty,question_version_id,policy_version,
                profile_version,explanation,baseline_id
           FROM practice_decisions
          WHERE id=$1 AND student_id=$2`,
        [decisionId, scope.studentId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "推荐记录不存在");
    return toDTO(row);
  }

  private profileFromRow(
    studentId: string,
    row: Record<string, unknown>,
  ): ProfileDTO {
    const stats = (row.knowledge_stats ?? {}) as Record<string, number>;
    const stored = (row.efficiency ?? {}) as Partial<EfficiencyObservation>;
    return {
      studentId,
      skillId: row.skill_id as string,
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
      evidence: [],
    };
  }
}
