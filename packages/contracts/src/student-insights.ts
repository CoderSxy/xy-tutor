import { z } from "zod";
import type { Actor } from "./domain.js";

export const METRIC_VERSION = "student-insights-v1" as const;
export const INSIGHT_TIMEZONE = "Asia/Shanghai" as const;
export const INSIGHT_PROMPT_VERSION = "student-insight-report-v1" as const;

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");

export const insightFilterSchema = z
  .object({
    from: dateOnly,
    to: dateOnly,
    revisionId: z.uuid().optional(),
  })
  .strict();

export const insightFilterInputSchema = insightFilterSchema.partial().strict();

export const pageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const attentionSchema = z.enum([
  "any",
  "inactive_7d",
  "pending_corrections_10",
]);
export const studentSortSchema = z.enum([
  "last_learning_at",
  "active_days",
  "first_attempt_accuracy",
]);

export const insightListQuerySchema = insightFilterInputSchema
  .extend({
    q: z.string().trim().max(80).optional(),
    sort: studentSortSchema.default("last_learning_at"),
    attention: attentionSchema.default("any"),
    limit: pageQuerySchema.shape.limit,
    offset: pageQuerySchema.shape.offset,
  })
  .strict();

export type InsightFilter = z.infer<typeof insightFilterSchema>;
export type InsightListQuery = z.infer<typeof insightListQuerySchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type AdminInsightScope = { actor: Actor; studentId: string };

const materialTypeList = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((value) =>
    value
      ? [
          ...new Set(
            value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
          ),
        ]
      : undefined,
  )
  .pipe(
    z.array(z.enum(["mistake", "exam", "homework", "other"])).max(4).optional(),
  );

export const taskListQuerySchema = insightFilterInputSchema
  .extend({
    status: z.string().trim().max(40).optional(),
    kind: z.string().trim().max(40).optional(),
    limit: pageQuerySchema.shape.limit,
    offset: pageQuerySchema.shape.offset,
  })
  .strict();

export const mistakeListQuerySchema = insightFilterInputSchema
  .extend({
    status: z.string().trim().max(40).optional(),
    chapterId: z.uuid().optional(),
    knowledgePoint: z.string().trim().max(120).optional(),
    limit: pageQuerySchema.shape.limit,
    offset: pageQuerySchema.shape.offset,
  })
  .strict();

export const materialListQuerySchema = insightFilterInputSchema
  .extend({
    types: materialTypeList,
    status: z.string().trim().max(40).optional(),
    limit: pageQuerySchema.shape.limit,
    offset: pageQuerySchema.shape.offset,
  })
  .strict();

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type MistakeListQuery = z.infer<typeof mistakeListQuerySchema>;
export type MaterialListQuery = z.infer<typeof materialListQuerySchema>;

export type InsightCoverage = {
  learning: "partial" | "complete";
  historicalInferred: boolean;
  visitsStartedAt: string | null;
  backfillVersion: string | null;
};

export type InsightMeta = {
  from: string;
  to: string;
  timezone: typeof INSIGHT_TIMEZONE;
  dataAsOf: string;
  metricVersion: typeof METRIC_VERSION;
  coverage: InsightCoverage;
};

export type InsightPage<T> = { items: T[]; total: number; meta: InsightMeta };

export type Rate = {
  numerator: number;
  denominator: number;
  value: number | null;
};

export type InsightEvidence = {
  key: string;
  kind:
    | "attempt"
    | "assessment"
    | "message_version"
    | "material"
    | "mistake_event";
  id: string;
  versionId?: string;
  summary: string;
};

export type Finding = { text: string; evidenceKeys: string[] };

export type Recommendation = {
  text: string;
  basisEvidenceKeys: string[];
  priority: "high" | "medium" | "low";
};

export type ReportContent = {
  summary: string;
  strengths: Finding[];
  difficulties: Finding[];
  habits: Finding[];
  recommendations: Recommendation[];
  limitations: string[];
};

export type InsightSnapshot = {
  filter: InsightFilter;
  meta: InsightMeta;
  overview: StudentOverviewDTO;
  evidence: InsightEvidence[];
  sample: { actual: number; selected: number; truncated: boolean };
};

export type ReportStatus = "queued" | "running" | "completed" | "failed";

export type ReportSummary = {
  id: string;
  studentId: string;
  status: ReportStatus;
  filter: InsightFilter;
  dataAsOf: string;
  generation: number;
  attempts: number;
  model: string | null;
  errorCode: string | null;
  evidenceCount: number;
  createdAt: string;
  completedAt: string | null;
};

export type ReportHistory = { items: ReportSummary[]; total: number };

export type ReportCreateResult = {
  reportId: string;
  status: ReportStatus;
  reused: boolean;
};

export type ReportRetryResult = {
  reportId: string;
  status: ReportStatus;
  generation: number;
};

export type InsightEvidenceDetail = {
  href: string;
  detail: InsightEvidence;
};

export type ReportDTO = {
  id: string;
  studentId: string;
  status: ReportStatus;
  filter: InsightFilter;
  dataAsOf: string;
  generation: number;
  attempts: number;
  content: ReportContent | null;
  model: string | null;
  errorCode: string | null;
  evidence: InsightEvidence[];
  createdAt: string;
  completedAt: string | null;
};

export type DailyPoint = {
  date: string;
  attempts: number;
  questions: number;
  firstAttempts: Rate;
};

export type KnowledgeSummary = {
  knowledgePoint: string;
  attempts: number;
  verified: number;
  correct: number;
  hintDependency: Record<string, number>;
};

export type MaterialCoverage = {
  materialId: string;
  name: string;
  type: string;
  status: string;
  totalQuestions: number;
  answeredQuestions: number;
  verifiedQuestions: number;
};

export type MistakeCounts = {
  pending_correction: number;
  correcting: number;
  corrected_pending_practice: number;
  consolidated_pending_review: number;
  mastered: number;
};

export type StudentOverviewDTO = {
  studentId: string;
  displayName: string;
  counts: {
    attempts: number;
    questions: number;
    newMistakes: number;
    tasks: number;
    completedTasks: number;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    firstAttemptPending: number;
    mistakes: MistakeCounts;
  };
  firstAttemptAccuracy: Rate;
  taskCompletion: Rate;
  daily: DailyPoint[];
  knowledge: KnowledgeSummary[];
  materials: MaterialCoverage[];
  lastLearningAt: string | null;
};

export type AttentionReason = {
  type: "inactive_7d" | "pending_corrections_10";
  label: string;
  value: number;
};

export type StudentRowDTO = {
  studentId: string;
  displayName: string;
  studentLogins: string[];
  lastLearningAt: string | null;
  activeDays: number;
  attempts: number;
  questions: number;
  firstAttemptAccuracy: Rate;
  pendingCorrections: number;
  pendingReviews: number;
  taskCompletion: Rate;
  attentionReasons: AttentionReason[];
};

export type InsightListSummary = {
  students: number;
  activeStudents: number;
  attempts: number;
  newMistakes: number;
};

export type InsightListDTO = {
  items: StudentRowDTO[];
  total: number;
  summary: InsightListSummary;
  meta: InsightMeta;
};

export type StudentOverviewResponse = {
  overview: StudentOverviewDTO;
  meta: InsightMeta;
};

export type TaskRecordDTO = {
  id: string;
  kind: string;
  title: string | null;
  status: string;
  revisionId: string;
  chapterId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  answeredCount: number;
};

export type TaskItemDTO = {
  id: string;
  questionId: string;
  questionVersionId: string;
  position: number;
  role: string;
  status: string;
  stem: string;
  knowledgePoint: string | null;
};

export type DiagnosisReviewRecordDTO = {
  id: string;
  decision: "accept" | "correct" | "insufficient";
  correctedCode: string | null;
  reason: string;
  expectedVersion: number;
  resultVersion: number;
  evidence: { kind: string; id: string; versionId?: string }[];
  createdAt: string;
};

export type DiagnosisRecordDTO = {
  id: string;
  attemptId: string;
  version: number;
  status: string;
  primaryCode: string | null;
  summary: string;
  evidence: { kind: string; id: string; versionId?: string }[];
  ruleVersion: string;
  createdAt: string;
  reviews: DiagnosisReviewRecordDTO[];
};

export type AttemptRecordDTO = {
  id: string;
  taskId: string | null;
  questionId: string;
  questionVersionId: string;
  messageVersionId: string | null;
  answer: string;
  createdAt: string;
  stem: string;
  knowledgePoint: string | null;
  hints: { level: string; content: string }[];
  assessment: {
    id: string;
    correctness: "correct" | "incorrect" | "pending" | "unknown";
    verification: string;
    hintDependency: string;
    feedback: string | null;
  } | null;
  diagnosis: DiagnosisRecordDTO | null;
};

export type MessageRecordDTO = {
  id: string;
  role: string;
  versionId: string;
  versionNo: number;
  content: string;
  createdAt: string;
  attachments: { fileId: string; name: string; contentType: string }[];
};

export type MistakeRecordDTO = {
  id: string;
  questionId: string;
  status: string;
  createdAt: string;
  dueAt: string | null;
  stem: string;
  knowledgePoint: string | null;
  revisionId: string;
};

export type MistakeEventDTO = {
  id: string;
  type: string;
  fromState: string;
  toState: string;
  reason: string;
  evidenceAt: string;
  attemptId: string | null;
  assessmentId: string | null;
  createdAt: string;
};

export type MaterialRecordDTO = {
  id: string;
  fileId: string;
  name: string;
  contentType: string;
  type: string;
  status: string;
  revisionId: string;
  createdAt: string;
  questions: number;
  answered: number;
  verified: number;
};

export type MaterialQuestionDTO = {
  questionId: string;
  questionVersionId: string;
  stem: string;
  knowledgePoint: string | null;
  answered: boolean;
  verified: boolean;
};

export type MaterialExtractionDTO = {
  id: string;
  versionNo: number;
  model: string;
  promptVersion: string;
  createdAt: string;
};

export type ActivityDay = {
  date: string;
  events: number;
  active: boolean;
  visits: number | null;
};

export type ActivityDTO = {
  days: ActivityDay[];
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  visitedDays: number;
  meta: InsightMeta;
};

export const findingSchema = z
  .object({
    text: z.string().trim().min(1).max(1500),
    evidenceKeys: z.array(z.string().min(1).max(200)).min(1).max(10),
  })
  .strict();

export const recommendationSchema = z
  .object({
    text: z.string().trim().min(1).max(1500),
    basisEvidenceKeys: z.array(z.string().min(1).max(200)).min(1).max(10),
    priority: z.enum(["high", "medium", "low"]),
  })
  .strict();

export const reportContentSchema = z
  .object({
    summary: z.string().trim().min(1).max(3000),
    strengths: z.array(findingSchema).max(10),
    difficulties: z.array(findingSchema).max(10),
    habits: z.array(findingSchema).max(10),
    recommendations: z.array(recommendationSchema).max(10),
    limitations: z.array(z.string().trim().min(1).max(1500)).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const total = JSON.stringify(value).length;
    if (total > 15000)
      ctx.addIssue({
        code: "custom",
        message: "报告正文超出长度限制",
      });
  });
