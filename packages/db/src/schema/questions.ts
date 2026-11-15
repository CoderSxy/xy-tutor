import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles } from "./auth.js";
import { revisions } from "./catalog.js";
export const questions = pgTable("questions", {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid("student_id").references(() => studentProfiles.id),
  revisionId: uuid("revision_id").references(() => revisions.id),
  sourceType: text("source_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const questionVersions = pgTable(
  "question_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id),
    versionNo: integer("version_no").notNull(),
    stem: text().notNull(),
    referenceAnswer: text("reference_answer"),
    knowledgePoint: text("knowledge_point"),
    rubric: jsonb().notNull().default({}),
    verification: text().notNull().default("pending"),
    questionType: text("question_type").notNull().default("legacy"),
    presentation: jsonb().notNull().default({}),
    answerSpec: jsonb("answer_spec").notNull().default({}),
    languageStatus: text("language_status").notNull().default("unchecked"),
    languagePolicyVersion: text("language_policy_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("question_version_number").on(t.questionId, t.versionNo),
    check(
      "question_version_type_check",
      sql`${t.questionType} IN ('single_choice','multiple_choice','fill_blank','worked','legacy')`,
    ),
    check(
      "question_version_language_status_check",
      sql`${t.languageStatus} IN ('unchecked','accepted','repair_required')`,
    ),
  ],
);
