import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  bigserial,
  boolean,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles } from "./auth.js";
import { questions, questionVersions } from "./questions.js";
import {
  attempts,
  conversations,
  messageVersions,
} from "./conversations.js";
import { learningTasks } from "./learning.js";
import { assessments } from "./assessments.js";
export const studentMistakes = pgTable(
  "student_mistakes",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id),
    originalAttemptId: uuid("original_attempt_id").references(
      () => attempts.id,
    ),
    status: text().notNull().default("pending_correction"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    consolidatedAt: timestamp("consolidated_at", { withTimezone: true }),
    lastConsolidatedQuestionId: uuid(
      "last_consolidated_question_id",
    ).references(() => questions.id),
    originCategory: text("origin_category").notNull().default("unknown"),
    originDetail: text("origin_detail").notNull().default("unknown"),
    originTaskId: uuid("origin_task_id").references(() => learningTasks.id),
    originConversationId: uuid("origin_conversation_id").references(
      () => conversations.id,
    ),
    originMessageVersionId: uuid("origin_message_version_id").references(
      () => messageVersions.id,
    ),
    originQuestionVersionId: uuid("origin_question_version_id").references(
      () => questionVersions.id,
    ),
    provenance: jsonb().notNull().default({}),
    lifecycle: text().notNull().default("active"),
    version: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("student_question_mistake").on(t.studentId, t.questionId),
    check(
      "student_mistake_origin_category_check",
      sql`${t.originCategory} IN ('uploaded','learning','unknown')`,
    ),
    check(
      "student_mistake_origin_detail_check",
      sql`${t.originDetail} IN ('material_import','daily_practice','knowledge_consolidation','free_question','mistake_review','unknown')`,
    ),
    check(
      "student_mistake_lifecycle_check",
      sql`${t.lifecycle} IN ('active','revoked')`,
    ),
  ],
);
export const mistakeStateEvents = pgTable(
  "mistake_state_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    sequence: bigserial({ mode: "number" }).notNull(),
    mistakeId: uuid("mistake_id")
      .notNull()
      .references(() => studentMistakes.id),
    assessmentId: uuid("assessment_id").references(() => assessments.id),
    attemptId: uuid("attempt_id").references(() => attempts.id),
    type: text().notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text().notNull(),
    ruleVersion: text("rule_version").notNull(),
    evidence: jsonb().notNull().default({}),
    evidenceAt: timestamp("evidence_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("mistake_assessment_applied").on(t.mistakeId, t.assessmentId),
  ],
);
export const questionRelations = pgTable("question_relations", {
  id: uuid().primaryKey().defaultRandom(),
  originQuestionId: uuid("origin_question_id")
    .notNull()
    .references(() => questions.id),
  originQuestionVersionId: uuid("origin_question_version_id")
    .notNull()
    .references(() => questionVersions.id),
  variantQuestionId: uuid("variant_question_id")
    .notNull()
    .references(() => questions.id)
    .unique(),
  knowledgePoint: text("knowledge_point").notNull(),
  verified: boolean().notNull(),
  evidence: jsonb().notNull(),
});
