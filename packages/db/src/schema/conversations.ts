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
import { learningTasks } from "./learning.js";
import { revisions } from "./catalog.js";
import { questionVersions } from "./questions.js";
import { files } from "./files.js";
export const conversations = pgTable("conversations", {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => studentProfiles.id),
  taskId: uuid("task_id").references(() => learningTasks.id),
  revisionId: uuid("revision_id").references(() => revisions.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text().notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    requestKey: text("request_key"),
    regeneratedFrom: uuid("regenerated_from"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_request_key").on(t.conversationId, t.requestKey),
  ],
);
export const messageVersions = pgTable(
  "message_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    versionNo: integer("version_no").notNull(),
    content: text().notNull(),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("message_version_number").on(t.messageId, t.versionNo)],
);
export const attempts = pgTable(
  "attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    taskId: uuid("task_id").references(() => learningTasks.id),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    messageVersionId: uuid("message_version_id").references(
      () => messageVersions.id,
    ),
    requestKey: text("request_key").notNull(),
    answer: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("student_attempt_key").on(t.studentId, t.requestKey)],
);
export const hints = pgTable("hints", {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => learningTasks.id),
  questionVersionId: uuid("question_version_id")
    .notNull()
    .references(() => questionVersions.id),
  messageVersionId: uuid("message_version_id")
    .notNull()
    .references(() => messageVersions.id),
  level: text().notNull(),
  displayedAt: timestamp("displayed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid().primaryKey().defaultRandom(),
    messageVersionId: uuid("message_version_id")
      .notNull()
      .references(() => messageVersions.id),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    position: integer().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("message_attachment_position").on(
      t.messageVersionId,
      t.position,
    ),
    uniqueIndex("message_attachment_file").on(t.messageVersionId, t.fileId),
  ],
);
export const evidenceInvalidations = pgTable("evidence_invalidations", {
  id: uuid().primaryKey().defaultRandom(),
  studentId: uuid("student_id")
    .notNull()
    .references(() => studentProfiles.id),
  evidenceVersionId: uuid("evidence_version_id").notNull(),
  reason: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
