import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles } from "./auth.js";
import { skills } from "./question-bank.js";
import { attempts } from "./conversations.js";
import { questionVersions } from "./questions.js";

const time = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const learningProfileBaselines = pgTable(
  "learning_profile_baselines",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    bucketKey: text("bucket_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    medianMs: integer("median_ms").notNull(),
    sampleIds: jsonb("sample_ids").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: time("created_at"),
  },
  (t) => [
    index("learning_profile_baseline_student_skill").on(
      t.studentId,
      t.skillId,
      t.bucketKey,
      t.asOf,
    ),
    check(
      "learning_profile_baseline_median_check",
      sql`${t.medianMs} > 0`,
    ),
  ],
);

export const learningProfiles = pgTable(
  "learning_profiles",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer().notNull().default(1),
    trainingBand: text("training_band").notNull().default("repair"),
    bandEnteredAt: time("band_entered_at"),
    consumedPromotionEvidenceIds: jsonb(
      "consumed_promotion_evidence_ids",
    )
      .notNull()
      .default([]),
    stale: boolean().notNull().default(false),
    knowledgeStats: jsonb("knowledge_stats").notNull().default({}),
    hintStats: jsonb("hint_stats").notNull().default({}),
    efficiency: jsonb().notNull().default({}),
    baselineId: uuid("baseline_id").references(
      () => learningProfileBaselines.id,
    ),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (t) => [
    uniqueIndex("learning_profile_student_skill").on(
      t.studentId,
      t.skillId,
    ),
    check(
      "learning_profile_training_band_check",
      sql`${t.trainingBand} IN ('repair','consolidation','advance')`,
    ),
    check("learning_profile_version_check", sql`${t.version} > 0`),
  ],
);

export const learningProfileEvidence = pgTable(
  "learning_profile_evidence",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => learningProfiles.id),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    assessmentId: uuid("assessment_id"),
    band: text().notNull(),
    independentCorrect: boolean("independent_correct").notNull(),
    determinable: boolean().notNull(),
    attemptAt: timestamp("attempt_at", { withTimezone: true }).notNull(),
    consumedByVersion: integer("consumed_by_version"),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("learning_profile_evidence_version").on(
      t.studentId,
      t.skillId,
      t.questionVersionId,
    ),
    index("learning_profile_evidence_profile").on(t.profileId, t.attemptAt),
    check(
      "learning_profile_evidence_band_check",
      sql`${t.band} IN ('repair','consolidation','advance')`,
    ),
  ],
);

export const practiceDecisions = pgTable(
  "practice_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    taskId: uuid("task_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    profileVersion: integer("profile_version").notNull(),
    status: text().notNull(),
    goal: text().notNull(),
    difficulty: text(),
    entryId: uuid("entry_id"),
    questionVersionId: uuid("question_version_id").references(
      () => questionVersions.id,
    ),
    skillId: uuid("skill_id").references(() => skills.id),
    baselineId: uuid("baseline_id").references(
      () => learningProfileBaselines.id,
    ),
    explanation: text().notNull(),
    reasonCodes: jsonb("reason_codes").notNull().default([]),
    candidateSnapshot: jsonb("candidate_snapshot").notNull().default([]),
    exclusions: jsonb().notNull().default([]),
    recentWindow: jsonb("recent_window").notNull().default([]),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidReason: text("invalid_reason"),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("practice_decision_request").on(
      t.studentId,
      t.taskId,
      t.requestKey,
    ),
    index("practice_decision_student_created").on(t.studentId, t.createdAt),
    index("practice_decision_student_question").on(
      t.studentId,
      t.questionVersionId,
    ),
    check(
      "practice_decision_status_check",
      sql`${t.status} IN ('selected','insufficient_pool','awaiting_diagnosis')`,
    ),
    check(
      "practice_decision_goal_check",
      sql`${t.goal} IN ('diagnostic','repair','transfer','review')`,
    ),
    check(
      "practice_decision_difficulty_check",
      sql`${t.difficulty} IS NULL OR ${t.difficulty} IN ('easy','medium','challenge')`,
    ),
    check("practice_decision_version_check", sql`${t.profileVersion} > 0`),
    check(
      "practice_decision_selected_question_check",
      sql`(${t.status} = 'selected') = (${t.questionVersionId} IS NOT NULL)`,
    ),
  ],
);

export const learningHabits = pgTable(
  "learning_habits",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    anchorCode: text("anchor_code").notNull(),
    observation: jsonb().notNull().default({}),
    independentCheckCount: integer("independent_check_count")
      .notNull()
      .default(0),
    successfulCorrectionCount: integer("successful_correction_count")
      .notNull()
      .default(0),
    evidence: jsonb().notNull().default([]),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (t) => [
    uniqueIndex("learning_habit_anchor").on(
      t.studentId,
      t.skillId,
      t.anchorCode,
    ),
    check(
      "learning_habit_count_check",
      sql`${t.independentCheckCount} >= 0 AND ${t.successfulCorrectionCount} >= 0`,
    ),
  ],
);
