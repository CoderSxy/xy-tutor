import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { studentProfiles } from "./auth.js";
import { revisions } from "./catalog.js";
export const questions = pgTable("questions", {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid("student_id").references(() => studentProfiles.id),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => revisions.id),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("question_version_number").on(t.questionId, t.versionNo)],
);
