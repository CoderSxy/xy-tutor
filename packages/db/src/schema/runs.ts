import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigserial,
  jsonb,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users, studentProfiles } from "./auth.js";
import { questionVersions } from "./questions.js";
import { conversations, messageVersions } from "./conversations.js";
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    requestKey: text("request_key").notNull(),
    inputText: text("input_text").notNull(),
    questionVersionId: uuid("question_version_id").references(
      () => questionVersions.id,
    ),
    mode: text().notNull().default("reply"),
    inputVersionId: uuid("input_version_id").references(
      () => messageVersions.id,
    ),
    outputVersionId: uuid("output_version_id").references(
      () => messageVersions.id,
    ),
    retryOfRunId: uuid("retry_of_run_id").references(
      (): AnyPgColumn => agentRuns.id,
    ),
    status: text().notNull().default("queued"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("run_request_key").on(t.conversationId, t.requestKey),
    uniqueIndex("one_active_conversation_run")
      .on(t.conversationId)
      .where(sql`status in ('queued','running')`),
  ],
);
export const runEvents = pgTable("run_events", {
  id: bigserial({ mode: "number" }).primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => agentRuns.id),
  type: text().notNull(),
  data: jsonb().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id),
    toolCallId: text("tool_call_id").notNull(),
    name: text().notNull(),
    args: jsonb().notNull(),
    result: jsonb(),
    status: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("run_tool_call").on(t.runId, t.toolCallId)],
);
