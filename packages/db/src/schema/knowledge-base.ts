import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { files } from "./files.js";

export const knowledgeBatches = pgTable("knowledge_batches", {
  id: uuid().primaryKey().defaultRandom(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => users.id),
  textContent: text("text_content"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const knowledgeBatchFiles = pgTable(
  "knowledge_batch_files",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeBatches.id),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    position: integer().notNull(),
  },
  (t) => [
    uniqueIndex("knowledge_batch_files_batch_id_file_id_unique").on(
      t.batchId,
      t.fileId,
    ),
    uniqueIndex("knowledge_batch_files_batch_id_position_unique").on(
      t.batchId,
      t.position,
    ),
  ],
);

export const knowledgeParseRuns = pgTable(
  "knowledge_parse_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeBatches.id),
    extraPrompt: text("extra_prompt"),
    model: text(),
    status: text().notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("knowledge_parse_runs_batch_created").on(t.batchId, t.createdAt),
    check(
      "knowledge_parse_runs_status_check",
      sql`${t.status} IN ('queued','processing','succeeded','failed')`,
    ),
  ],
);

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => knowledgeBatches.id),
    parseRunId: uuid("parse_run_id")
      .notNull()
      .references(() => knowledgeParseRuns.id),
    title: text().notNull(),
    summary: text().notNull(),
    status: text().notNull(),
    replacesItemId: uuid("replaces_item_id").references(
      (): AnyPgColumn => knowledgeItems.id,
    ),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("knowledge_items_status_updated").on(t.status, t.updatedAt),
    check(
      "knowledge_items_status_check",
      sql`${t.status} IN ('pending_review','published','discarded')`,
    ),
  ],
);
