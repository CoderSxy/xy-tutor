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
import { files } from "./files.js";
import { revisions } from "./catalog.js";
import { questionVersions } from "./questions.js";
import { attempts } from "./conversations.js";
export const materials = pgTable("materials", {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => studentProfiles.id),
  fileId: uuid("file_id")
    .notNull()
    .references(() => files.id),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => revisions.id),
  type: text().notNull(),
  status: text().notNull().default("processing"),
  extractionVersion: integer("extraction_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const materialPages = pgTable(
  "material_pages",
  {
    id: uuid().primaryKey().defaultRandom(),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id),
    pageIndex: integer("page_index").notNull(),
    text: text().notNull(),
    status: text().notNull(),
  },
  (t) => [uniqueIndex("material_page_index").on(t.materialId, t.pageIndex)],
);
export const extractions = pgTable(
  "extractions",
  {
    id: uuid().primaryKey().defaultRandom(),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id),
    versionNo: integer("version_no").notNull(),
    payload: jsonb().notNull(),
    model: text().notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("material_extraction_version").on(t.materialId, t.versionNo),
  ],
);
export const confirmations = pgTable(
  "material_confirmations",
  {
    id: uuid().primaryKey().defaultRandom(),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => extractions.id),
    requestHash: text("request_hash").notNull(),
    candidateIds: jsonb("candidate_ids").notNull(),
    questionVersionIds: jsonb("question_version_ids").notNull(),
  },
  (t) => [
    uniqueIndex("confirmed_extraction_request").on(
      t.extractionId,
      t.requestHash,
    ),
  ],
);
export const questionSources = pgTable("question_sources", {
  id: uuid().primaryKey().defaultRandom(),
  questionVersionId: uuid("question_version_id")
    .notNull()
    .references(() => questionVersions.id),
  extractionId: uuid("extraction_id")
    .notNull()
    .references(() => extractions.id),
  pageId: uuid("page_id")
    .notNull()
    .references(() => materialPages.id),
  bbox: jsonb().notNull(),
  teacherAnnotation: text("teacher_annotation"),
});
export const attemptEvidence = pgTable("attempt_evidence", {
  id: uuid().primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id),
  extractionId: uuid("extraction_id")
    .notNull()
    .references(() => extractions.id),
  sourceType: text("source_type").notNull(),
});
