import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  date,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { studentProfiles, users } from "./auth.js";
import { attempts } from "./conversations.js";
import { errorDiagnoses } from "./tutoring.js";

const time = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const diagnosisReviews = pgTable(
  "diagnosis_reviews",
  {
    id: uuid().primaryKey().defaultRandom(),
    diagnosisId: uuid("diagnosis_id")
      .notNull()
      .references(() => errorDiagnoses.id),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id),
    decision: text().notNull(),
    correctedCode: text("corrected_code"),
    reason: text().notNull(),
    evidence: jsonb().notNull().default([]),
    expectedVersion: integer("expected_version").notNull(),
    resultVersion: integer("result_version").notNull(),
    requestKey: text("request_key").notNull(),
    createdAt: time("created_at"),
  },
  (t) => [
    uniqueIndex("diagnosis_review_request").on(
      t.reviewerId,
      t.studentId,
      t.requestKey,
    ),
    index("diagnosis_review_attempt").on(t.attemptId, t.createdAt),
    check(
      "diagnosis_review_decision_check",
      sql`${t.decision} IN ('accept','correct','insufficient')`,
    ),
    check(
      "diagnosis_review_corrected_code_check",
      sql`${t.correctedCode} IS NULL OR ${t.correctedCode} IN ('execution_slip','condition_omission','concept_gap','rule_misuse','strategy_gap','expression_gap','input_issue')`,
    ),
    check(
      "diagnosis_review_correction_code_required",
      sql`(${t.decision} = 'correct') = (${t.correctedCode} IS NOT NULL)`,
    ),
    check(
      "diagnosis_review_reason_length_check",
      sql`char_length(${t.reason}) BETWEEN 1 AND 2000`,
    ),
    check(
      "diagnosis_review_version_check",
      sql`${t.expectedVersion} > 0 AND ${t.resultVersion} > ${t.expectedVersion}`,
    ),
  ],
);

export const learningEvaluations = pgTable(
  "learning_evaluations",
  {
    id: uuid().primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    metricVersion: text("metric_version").notNull(),
    metrics: jsonb().notNull().default({}),
    sampleSize: integer("sample_size").notNull().default(0),
    versions: jsonb().notNull().default({}),
    staleEvidenceCount: integer("stale_evidence_count")
      .notNull()
      .default(0),
    generatedAt: time("generated_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: time("created_at"),
  },
  (t) => [
    index("learning_evaluation_student_window").on(
      t.studentId,
      t.fromDate,
      t.toDate,
      t.generatedAt,
    ),
    check(
      "learning_evaluation_window_check",
      sql`${t.fromDate} <= ${t.toDate}`,
    ),
    check(
      "learning_evaluation_non_negative",
      sql`${t.sampleSize} >= 0 AND ${t.staleEvidenceCount} >= 0`,
    ),
  ],
);
