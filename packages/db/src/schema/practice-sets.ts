import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles } from "./auth.js";
import { learningTasks, taskItems } from "./learning.js";
import { attempts } from "./conversations.js";
import { questionVersions } from "./questions.js";
import { assessments } from "./assessments.js";

export const practiceSets = pgTable(
  "practice_sets",
  {
    id: uuid().primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => learningTasks.id),
    mode: text().notNull().default("step"),
    strategy: text().notNull().default("mixed"),
    examProfileId: text("exam_profile_id"),
    examProfileVersion: text("exam_profile_version"),
    policyVersion: text("policy_version").notNull().default("mixed-v1"),
    seed: text().notNull().default(""),
    scopeSnapshot: jsonb("scope_snapshot").notNull().default({}),
    blueprint: jsonb().notNull().default({}),
    generationStatus: text("generation_status").notNull().default("preparing"),
    submissionStatus: text("submission_status").notNull().default("open"),
    previousSetId: uuid("previous_set_id").references(
      (): AnyPgColumn => practiceSets.id,
    ),
    version: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_set_task_unique").on(t.taskId),
    index("practice_set_previous").on(t.previousSetId),
    index("practice_set_generation").on(t.generationStatus),
    check(
      "practice_set_mode_check",
      sql`${t.mode} IN ('step','batch')`,
    ),
    check(
      "practice_set_strategy_check",
      sql`${t.strategy} IN ('mixed','exam')`,
    ),
    check(
      "practice_set_generation_check",
      sql`${t.generationStatus} IN ('awaiting_scope','preparing','ready','insufficient_pool','failed')`,
    ),
    check(
      "practice_set_submission_check",
      sql`${t.submissionStatus} IN ('open','grading','needs_review','completed')`,
    ),
    check("practice_set_version_check", sql`${t.version} > 0`),
    check(
      "practice_set_exam_profile_required",
      sql`${t.strategy} <> 'exam' OR ${t.examProfileId} IS NOT NULL`,
    ),
  ],
);

export const practiceSetSlots = pgTable(
  "practice_set_slots",
  {
    id: uuid().primaryKey().defaultRandom(),
    setId: uuid("set_id")
      .notNull()
      .references(() => practiceSets.id),
    position: integer().notNull(),
    questionType: text("question_type").notNull(),
    taskItemId: uuid("task_item_id").references(() => taskItems.id),
    state: text().notNull().default("pending"),
    reasonCode: text("reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_set_slot_position").on(t.setId, t.position),
    uniqueIndex("practice_set_slot_item").on(t.taskItemId),
    check(
      "practice_set_slot_position_check",
      sql`${t.position} BETWEEN 0 AND 4`,
    ),
    check(
      "practice_set_slot_type_check",
      sql`${t.questionType} IN ('single_choice','multiple_choice','fill_blank','worked','legacy')`,
    ),
    check(
      "practice_set_slot_state_check",
      sql`${t.state} IN ('pending','bound','failed')`,
    ),
  ],
);

export const practiceAnswerDrafts = pgTable(
  "practice_answer_drafts",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    taskItemId: uuid("task_item_id")
      .notNull()
      .references(() => taskItems.id),
    payload: jsonb().notNull().default({}),
    version: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_answer_draft_item").on(t.studentId, t.taskItemId),
    check("practice_answer_draft_version_check", sql`${t.version} > 0`),
  ],
);

export const practiceSubmissions = pgTable(
  "practice_submissions",
  {
    id: uuid().primaryKey().defaultRandom(),
    setId: uuid("set_id")
      .notNull()
      .references(() => practiceSets.id),
    requestKey: text("request_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text().notNull().default("grading"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_submission_request").on(t.setId, t.requestKey),
    check(
      "practice_submission_state_check",
      sql`${t.state} IN ('grading','needs_review','completed')`,
    ),
  ],
);

export const practiceSubmissionItems = pgTable(
  "practice_submission_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => practiceSubmissions.id),
    taskItemId: uuid("task_item_id")
      .notNull()
      .references(() => taskItems.id),
    attemptId: uuid("attempt_id").references(() => attempts.id),
    state: text().notNull().default("submitted"),
    gradingState: text("grading_state").notNull().default("queued"),
    mistakeSyncState: text("mistake_sync_state").notNull().default("not_required"),
    latestAssessmentId: uuid("latest_assessment_id").references(
      () => assessments.id,
    ),
    reasonCode: text("reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_submission_item_unique").on(
      t.submissionId,
      t.taskItemId,
    ),
    index("practice_submission_item_attempt").on(t.attemptId),
    check(
      "practice_submission_item_state_check",
      sql`${t.state} IN ('submitted','skipped')`,
    ),
    check(
      "practice_submission_item_grading_check",
      sql`${t.gradingState} IN ('none','queued','running','verified','pending','failed')`,
    ),
    check(
      "practice_submission_item_sync_check",
      sql`${t.mistakeSyncState} IN ('not_required','queued','synced','failed')`,
    ),
  ],
);

export const practiceSetContinuations = pgTable(
  "practice_set_continuations",
  {
    id: uuid().primaryKey().defaultRandom(),
    previousSetId: uuid("previous_set_id")
      .notNull()
      .references(() => practiceSets.id),
    requestKey: text("request_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    newSetId: uuid("new_set_id")
      .notNull()
      .references(() => practiceSets.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_set_continuation_previous").on(t.previousSetId),
    uniqueIndex("practice_set_continuation_new").on(t.newSetId),
  ],
);

export const studentPracticePreferences = pgTable(
  "student_practice_preferences",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    mode: text(),
    strategy: text().notNull().default("mixed"),
    examProfileId: text("exam_profile_id"),
    version: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("student_practice_preference_student").on(t.studentId),
    check(
      "student_practice_preference_mode_check",
      sql`${t.mode} IS NULL OR ${t.mode} IN ('step','batch')`,
    ),
    check(
      "student_practice_preference_strategy_check",
      sql`${t.strategy} IN ('mixed','exam')`,
    ),
    check("student_practice_preference_version_check", sql`${t.version} > 0`),
  ],
);

export const questionLocalizations = pgTable(
  "question_localizations",
  {
    id: uuid().primaryKey().defaultRandom(),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    policyVersion: text("policy_version").notNull(),
    payload: jsonb().notNull().default({}),
    status: text().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("question_localization_version_policy").on(
      t.questionVersionId,
      t.policyVersion,
    ),
    check(
      "question_localization_status_check",
      sql`${t.status} IN ('pending','ready','failed')`,
    ),
  ],
);
