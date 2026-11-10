import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles, users } from "./auth.js";
import { learningTasks } from "./learning.js";
import { revisions } from "./catalog.js";
import { jobs } from "./jobs.js";

export const studentLearningEvents = pgTable(
  "student_learning_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    actorId: uuid("actor_id").references(() => users.id),
    eventType: text("event_type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    taskId: uuid("task_id").references(() => learningTasks.id, {
      onDelete: "set null",
    }),
    revisionId: uuid("revision_id").references(() => revisions.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sourceOrigin: text("source_origin").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "student_learning_events_event_type_check",
      sql`${t.eventType} IN ('answer_submitted','learning_message_sent','material_submitted')`,
    ),
    check(
      "student_learning_events_source_type_check",
      sql`${t.sourceType} IN ('attempt','message','material')`,
    ),
    check(
      "student_learning_events_origin_check",
      sql`${t.sourceOrigin} IN ('live','historical_inferred')`,
    ),
    uniqueIndex("student_learning_events_source_unique").on(
      t.studentId,
      t.eventType,
      t.sourceType,
      t.sourceId,
    ),
    index("student_learning_events_student_time").on(t.studentId, t.occurredAt),
    index("student_learning_events_time_student").on(t.occurredAt, t.studentId),
    index("student_learning_events_student_revision_time").on(
      t.studentId,
      t.revisionId,
      t.occurredAt,
    ),
  ],
);

export const studentDailyVisits = pgTable(
  "student_daily_visits",
  {
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    localDate: date("local_date").notNull(),
    timezone: text().notNull().default("Asia/Shanghai"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.localDate, t.timezone] }),
    index("student_daily_visits_date_student").on(t.localDate, t.studentId),
  ],
);

export const studentInsightBackfills = pgTable("student_insight_backfills", {
  id: uuid().primaryKey().defaultRandom(),
  version: text().notNull().unique(),
  fromDate: date("from_date").notNull(),
  toDate: date("to_date").notNull(),
  lastSourceCursor: jsonb("last_source_cursor"),
  status: text().notNull().default("pending"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const studentInsightCollectionState = pgTable(
  "student_insight_collection_state",
  {
    id: integer().primaryKey(),
    learningStartedAt: timestamp("learning_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    visitsStartedAt: timestamp("visits_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("student_insight_collection_state_singleton", sql`${t.id} = 1`)],
);

export const studentInsightReports = pgTable(
  "student_insight_reports",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    timezone: text().notNull().default("Asia/Shanghai"),
    revisionId: uuid("revision_id").references(() => revisions.id),
    metricVersion: text("metric_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    snapshot: jsonb().notNull(),
    evidenceCatalog: jsonb("evidence_catalog").notNull(),
    content: jsonb(),
    status: text().notNull().default("queued"),
    jobId: uuid("job_id").references(() => jobs.id),
    generation: integer().notNull().default(1),
    model: text(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "student_insight_reports_status_check",
      sql`${t.status} IN ('queued','running','completed','failed')`,
    ),
    index("student_insight_reports_history").on(t.studentId, t.createdAt, t.id),
    index("student_insight_reports_active").on(t.studentId, t.status),
  ],
);
