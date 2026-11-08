import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { studentProfiles } from "./auth.js";
import { learningTasks } from "./learning.js";
import { revisions } from "./catalog.js";
import { assessments } from "./assessments.js";
export const learningSummaries = pgTable(
  "learning_summaries",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => learningTasks.id),
    versionNo: integer("version_no").notNull(),
    content: jsonb().notNull(),
    model: text().notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("task_summary_version").on(t.taskId, t.versionNo)],
);
export const summaryEvidence = pgTable("summary_evidence", {
  id: uuid().primaryKey().defaultRandom(),
  summaryId: uuid("summary_id")
    .notNull()
    .references(() => learningSummaries.id),
  kind: text().notNull(),
  sourceId: uuid("source_id").notNull(),
  versionId: uuid("version_id"),
});
export const knowledgeObservations = pgTable("knowledge_observations", {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => studentProfiles.id),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => revisions.id),
  assessmentId: uuid("assessment_id")
    .references(() => assessments.id)
    .unique(),
  knowledgePoint: text("knowledge_point").notNull(),
  fact: jsonb().notNull(),
  confidence: text().notNull().default("observation"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const knowledgeStates = pgTable(
  "student_knowledge_states",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    knowledgePoint: text("knowledge_point").notNull(),
    evidenceStats: jsonb("evidence_stats").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("student_revision_knowledge").on(
      t.studentId,
      t.revisionId,
      t.knowledgePoint,
    ),
  ],
);
