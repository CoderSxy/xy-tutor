import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles, users } from "./auth.js";
import { learningTasks } from "./learning.js";
import { attempts, hints, messageVersions } from "./conversations.js";
import { files } from "./files.js";
import { questionVersions } from "./questions.js";
import { assessments } from "./assessments.js";

const time = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const tutoringEpisodes = pgTable(
  "tutoring_episodes",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => learningTasks.id),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    requestKey: text("request_key").notNull(),
    state: text().notNull().default("active"),
    teachingState: text("teaching_state")
      .notNull()
      .default("awaiting_evidence"),
    version: integer().notNull().default(1),
    leaseEpoch: integer("lease_epoch").notNull().default(1),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeq: integer("last_seq").notNull().default(0),
    exposure: text().notNull().default("none"),
    priorExposure: boolean("prior_exposure").notNull().default(false),
    startedAt: time("started_at"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    firstSubmittedAt: timestamp("first_submitted_at", { withTimezone: true }),
    createdAt: time("created_at"),
    updatedAt: time("updated_at"),
  },
  (t) => [
    uniqueIndex("tutoring_episode_request_key").on(t.studentId, t.requestKey),
    uniqueIndex("tutoring_episode_active_lease")
      .on(t.studentId)
      .where(sql`${t.state} IN ('active', 'paused')`),
    index("tutoring_episode_student_task_time").on(
      t.studentId,
      t.taskId,
      t.createdAt,
    ),
    index("tutoring_episode_question").on(t.studentId, t.questionVersionId),
    check(
      "tutoring_episode_state_check",
      sql`${t.state} IN ('active', 'paused', 'finished')`,
    ),
    check(
      "tutoring_episode_exposure_check",
      sql`${t.exposure} IN ('none', 'guided', 'solution_exposed', 'unknown')`,
    ),
    check(
      "tutoring_episode_teaching_state_check",
      sql`${t.teachingState} IN ('awaiting_evidence','self_check','focused_check','micro_probe','explanation','independent_check','scheduled_review')`,
    ),
    check(
      "tutoring_episode_positive_counters",
      sql`${t.version} > 0 AND ${t.leaseEpoch} > 0 AND ${t.lastSeq} >= 0`,
    ),
  ],
);

export const timingEvents = pgTable(
  "timing_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => tutoringEpisodes.id),
    eventId: uuid("event_id").notNull(),
    seq: integer().notNull(),
    segmentId: uuid("segment_id").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    kind: text().notNull(),
    cumulativeActiveMs: integer("cumulative_active_ms").notNull(),
    acceptedMs: integer("accepted_ms").notNull(),
    phase: text().notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("timing_event_key").on(t.episodeId, t.eventId),
    uniqueIndex("timing_event_seq").on(t.episodeId, t.seq),
    index("timing_event_episode_time").on(t.episodeId, t.receivedAt),
    check(
      "timing_event_kind_check",
      sql`${t.kind} IN ('start','checkpoint','pause','resume','finish')`,
    ),
    check(
      "timing_event_phase_check",
      sql`${t.phase} IN ('initial','self_check','post_hint')`,
    ),
    check(
      "timing_event_non_negative",
      sql`${t.cumulativeActiveMs} >= 0 AND ${t.acceptedMs} >= 0 AND ${t.seq} > 0 AND ${t.leaseEpoch} > 0`,
    ),
  ],
);

export const timingSegments = pgTable(
  "timing_segments",
  {
    id: uuid().primaryKey(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => tutoringEpisodes.id),
    phase: text().notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    acceptedMs: integer("accepted_ms").notNull().default(0),
    quality: text().notNull().default("reliable"),
    reasonCodes: jsonb("reason_codes").notNull().default([]),
    createdAt: time("created_at"),
  },
  (t) => [
    index("timing_segment_episode").on(t.episodeId, t.startAt),
    check(
      "timing_segment_phase_check",
      sql`${t.phase} IN ('initial','self_check','post_hint')`,
    ),
    check(
      "timing_segment_quality_check",
      sql`${t.quality} IN ('reliable','partial','unusable')`,
    ),
    check("timing_segment_accepted_ms", sql`${t.acceptedMs} >= 0`),
  ],
);

export const attemptTimingSnapshots = pgTable(
  "attempt_timing_snapshots",
  {
    id: uuid().primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id),
    episodeId: uuid("episode_id").references(() => tutoringEpisodes.id),
    version: integer().notNull().default(1),
    firstAttemptMs: integer("first_attempt_ms"),
    selfCheckMs: integer("self_check_ms"),
    postHintMs: integer("post_hint_ms"),
    totalActiveMs: integer("total_active_ms"),
    wallMs: integer("wall_ms"),
    quality: text().notNull().default("missing"),
    reasonCodes: jsonb("reason_codes").notNull().default([]),
    firstSubmittedAt: timestamp("first_submitted_at", { withTimezone: true }),
    evidenceBoundary: jsonb("evidence_boundary").notNull().default({}),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("attempt_timing_snapshot_version").on(t.attemptId, t.version),
    index("attempt_timing_snapshot_episode").on(t.episodeId),
    check(
      "attempt_timing_snapshot_quality_check",
      sql`${t.quality} IN ('reliable','partial','unusable','missing')`,
    ),
    check(
      "attempt_timing_snapshot_non_negative",
      sql`(${t.firstAttemptMs} IS NULL OR ${t.firstAttemptMs} >= 0) AND (${t.selfCheckMs} IS NULL OR ${t.selfCheckMs} >= 0) AND (${t.postHintMs} IS NULL OR ${t.postHintMs} >= 0) AND (${t.totalActiveMs} IS NULL OR ${t.totalActiveMs} >= 0) AND (${t.wallMs} IS NULL OR ${t.wallMs} >= 0)`,
    ),
  ],
);

export const attemptProcessEvidence = pgTable(
  "attempt_process_evidence",
  {
    id: uuid().primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id),
    messageVersionId: uuid("message_version_id").references(
      () => messageVersions.id,
    ),
    fileId: uuid("file_id").references(() => files.id),
    kind: text().notNull(),
    content: text(),
    contentHash: text("content_hash").notNull(),
    stepRefs: jsonb("step_refs").notNull().default([]),
    createdAt: time("created_at"),
  },
  (t) => [
    index("attempt_process_evidence_attempt").on(t.attemptId),
    uniqueIndex("attempt_process_evidence_source").on(
      t.attemptId,
      t.kind,
      t.contentHash,
    ),
  ],
);

export const errorDiagnoses = pgTable(
  "error_diagnoses",
  {
    id: uuid().primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id),
    assessmentId: uuid("assessment_id").references(() => assessments.id),
    questionVersionId: uuid("question_version_id")
      .notNull()
      .references(() => questionVersions.id),
    version: integer().notNull(),
    status: text().notNull().default("pending"),
    primaryCode: text("primary_code"),
    summary: text().notNull().default(""),
    evidence: jsonb().notNull().default([]),
    ruleVersion: text("rule_version").notNull(),
    modelVersion: text("model_version"),
    createdBy: uuid("created_by").references(() => users.id),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidReason: text("invalid_reason"),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("error_diagnosis_version").on(t.attemptId, t.version),
    index("error_diagnosis_attempt").on(t.attemptId, t.createdAt),
    index("error_diagnosis_question").on(t.questionVersionId),
    check(
      "error_diagnosis_status_check",
      sql`${t.status} IN ('pending','needs_probe','confirmed','unsupported','invalidated')`,
    ),
    check(
      "error_diagnosis_primary_code_check",
      sql`${t.primaryCode} IS NULL OR ${t.primaryCode} IN ('execution_slip','condition_omission','concept_gap','rule_misuse','strategy_gap','expression_gap','input_issue')`,
    ),
  ],
);

export const diagnosisCandidates = pgTable(
  "diagnosis_candidates",
  {
    id: uuid().primaryKey().defaultRandom(),
    diagnosisId: uuid("diagnosis_id")
      .notNull()
      .references(() => errorDiagnoses.id),
    code: text().notNull(),
    skillId: uuid("skill_id"),
    status: text().notNull().default("hypothesis"),
    earliestError: jsonb("earliest_error"),
    supports: jsonb().notNull().default([]),
    contradicts: jsonb().notNull().default([]),
    probe: text(),
    createdAt: time("created_at"),
  },
  (t) => [
    index("diagnosis_candidate_diagnosis").on(t.diagnosisId),
    check(
      "diagnosis_candidate_code_check",
      sql`${t.code} IN ('execution_slip','condition_omission','concept_gap','rule_misuse','strategy_gap','expression_gap','input_issue')`,
    ),
    check(
      "diagnosis_candidate_status_check",
      sql`${t.status} IN ('hypothesis','supported','confirmed','rejected')`,
    ),
  ],
);

export const tutoringStates = pgTable(
  "tutoring_states",
  {
    id: uuid().primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => tutoringEpisodes.id),
    version: integer().notNull(),
    state: text().notNull(),
    exposure: text().notNull(),
    failedChecks: integer("failed_checks").notNull().default(0),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("tutoring_state_version").on(t.episodeId, t.version),
    check(
      "tutoring_state_state_check",
      sql`${t.state} IN ('awaiting_evidence','self_check','focused_check','micro_probe','explanation','independent_check','scheduled_review')`,
    ),
    check(
      "tutoring_state_exposure_check",
      sql`${t.exposure} IN ('none','guided','solution_exposed','unknown')`,
    ),
    check("tutoring_state_failed_checks", sql`${t.failedChecks} >= 0`),
  ],
);

export const tutoringActions = pgTable(
  "tutoring_actions",
  {
    id: uuid().primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => tutoringEpisodes.id),
    requestKey: text("request_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    kind: text().notNull(),
    stateVersion: integer("state_version").notNull(),
    state: text().notNull(),
    exposure: text().notNull(),
    displayStatus: text("display_status").notNull().default("created"),
    content: text().notNull().default(""),
    evidence: jsonb().notNull().default([]),
    hintId: uuid("hint_id").references(() => hints.id),
    messageVersionId: uuid("message_version_id").references(
      () => messageVersions.id,
    ),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("tutoring_action_request_key").on(t.episodeId, t.requestKey),
    index("tutoring_action_episode_time").on(t.episodeId, t.createdAt),
    check(
      "tutoring_action_kind_check",
      sql`${t.kind} IN ('request_hint','request_probe','request_example','request_explanation','acknowledge_display','pause','resume')`,
    ),
    check(
      "tutoring_action_display_status_check",
      sql`${t.displayStatus} IN ('created','sent','acknowledged','unknown')`,
    ),
    check(
      "tutoring_action_exposure_check",
      sql`${t.exposure} IN ('none','guided','solution_exposed','unknown')`,
    ),
  ],
);

export const selfCheckOutcomes = pgTable(
  "self_check_outcomes",
  {
    id: uuid().primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => tutoringEpisodes.id),
    roundNo: integer("round_no").notNull(),
    actionId: uuid("action_id").references(() => tutoringActions.id),
    beforeAttemptId: uuid("before_attempt_id").references(() => attempts.id),
    afterAttemptId: uuid("after_attempt_id").references(() => attempts.id),
    outcome: text().notNull(),
    evidence: jsonb().notNull().default([]),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("self_check_outcome_round").on(t.episodeId, t.roundNo),
    check(
      "self_check_outcome_check",
      sql`${t.outcome} IN ('resolved','unresolved','exited')`,
    ),
  ],
);
