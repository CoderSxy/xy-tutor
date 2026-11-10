import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  AdminInsightScope,
  InsightEvidence,
  InsightFilter,
  InsightSnapshot,
} from "../../../../../packages/contracts/src/student-insights.js";
import { LATEST_ASSESSMENT, VALID_ATTEMPT } from "./facts.js";
import { readStudentOverview } from "./queries.js";

export type EvidenceLimits = {
  maxItems: number;
  maxSummaryChars: number;
  maxTotalChars: number;
};

export const EVIDENCE_LIMITS: EvidenceLimits = {
  maxItems: 100,
  maxSummaryChars: 500,
  maxTotalChars: 30_000,
};

// 每条查询单独限流，避免一次报告把整段历史读进内存。
const SOURCE_LIMIT = 500;

type AttemptEvidenceRow = {
  id: string;
  taskId: string | null;
  questionVersionId: string;
  stem: string;
  answer: string;
  correctness: string | null;
  verification: string | null;
  hintDependency: string | null;
  mistaken: boolean;
};

type MistakeEventRow = {
  id: string;
  mistakeId: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  stem: string;
};

type MessageRow = {
  messageId: string;
  versionId: string;
  content: string;
};

type MaterialRow = {
  id: string;
  name: string;
  type: string;
  status: string;
};

function truncate(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  return `${chars.slice(0, max - 1).join("")}…`;
}

function nonEmpty(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join("；");
}

export function selectInsightEvidence(
  candidates: InsightEvidence[],
  limits: EvidenceLimits = EVIDENCE_LIMITS,
): { evidence: InsightEvidence[]; sample: InsightSnapshot["sample"] } {
  const seen = new Set<string>();
  const evidence: InsightEvidence[] = [];
  let total = 0;
  for (const candidate of candidates) {
    if (evidence.length >= limits.maxItems) break;
    if (seen.has(candidate.key)) continue;
    const summary = truncate(candidate.summary, limits.maxSummaryChars);
    if (total + summary.length > limits.maxTotalChars) break;
    seen.add(candidate.key);
    evidence.push({ ...candidate, summary });
    total += summary.length;
  }
  return {
    evidence,
    sample: {
      actual: candidates.length,
      selected: evidence.length,
      truncated: candidates.length > evidence.length,
    },
  };
}

async function readAttemptEvidence(
  tx: PoolClient,
  scope: AdminInsightScope,
  filter: InsightFilter,
  start: Date,
  endExclusive: Date,
): Promise<InsightEvidence[]> {
  const rows = (
    await tx.query<AttemptEvidenceRow>(
      `SELECT a.id, a.task_id AS "taskId",
         a.question_version_id AS "questionVersionId",
         left(v.stem, 200) AS stem, left(a.answer, 1000) AS answer,
         s.correctness, s.verification, s.hint_dependency AS "hintDependency",
         EXISTS (
           SELECT 1 FROM student_mistakes m
           WHERE m.student_id = a.student_id AND m.question_id = v.question_id
         ) AS mistaken
       FROM attempts a
       JOIN question_versions v ON v.id = a.question_version_id
       JOIN questions q ON q.id = v.question_id
       LEFT JOIN learning_tasks t ON t.id = a.task_id
       ${LATEST_ASSESSMENT}
       WHERE a.student_id = $1
         AND a.created_at >= $2 AND a.created_at < $3
         AND (a.task_id IS NULL OR t.deleted_at IS NULL)
         AND ($4::uuid IS NULL OR q.revision_id = $4)
         AND ${VALID_ATTEMPT}
       ORDER BY mistaken DESC, a.created_at DESC, a.id
       LIMIT ${SOURCE_LIMIT}`,
      [scope.studentId, start, endExclusive, filter.revisionId ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    key: `attempt:${row.id}`,
    kind: "attempt",
    id: row.id,
    versionId: row.questionVersionId,
    summary: truncate(
      nonEmpty(
        `作答「${row.stem}」：${row.answer}`,
        row.verification
          ? `核验：${row.correctness ?? "未知"}/${row.verification}`
          : "尚未核验",
        row.hintDependency ? `提示依赖：${row.hintDependency}` : null,
      ),
      EVIDENCE_LIMITS.maxSummaryChars,
    ),
  }));
}

async function readMistakeEvidence(
  tx: PoolClient,
  scope: AdminInsightScope,
  filter: InsightFilter,
  start: Date,
  endExclusive: Date,
): Promise<InsightEvidence[]> {
  const rows = (
    await tx.query<MistakeEventRow>(
      `SELECT e.id, e.mistake_id AS "mistakeId", e.type,
         e.from_state AS "fromState", e.to_state AS "toState", e.reason,
         left(v.stem, 200) AS stem
       FROM mistake_state_events e
       JOIN student_mistakes m ON m.id = e.mistake_id
       JOIN questions q ON q.id = m.question_id
       JOIN LATERAL (
         SELECT stem FROM question_versions
         WHERE question_id = q.id
         ORDER BY version_no DESC LIMIT 1
       ) v ON true
       WHERE m.student_id = $1
         AND e.evidence_at >= $2 AND e.evidence_at < $3
         AND ($4::uuid IS NULL OR q.revision_id = $4)
       ORDER BY e.evidence_at DESC, e.id
       LIMIT ${SOURCE_LIMIT}`,
      [scope.studentId, start, endExclusive, filter.revisionId ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    key: `mistake_event:${row.id}`,
    kind: "mistake_event",
    id: row.id,
    summary: truncate(
      nonEmpty(
        `错题「${row.stem}」状态变化：${row.fromState ?? "无"} → ${row.toState ?? "无"}`,
        row.reason ? `原因：${row.reason}` : null,
      ),
      EVIDENCE_LIMITS.maxSummaryChars,
    ),
  }));
}

async function readMessageEvidence(
  tx: PoolClient,
  scope: AdminInsightScope,
  filter: InsightFilter,
  start: Date,
  endExclusive: Date,
): Promise<InsightEvidence[]> {
  const rows = (
    await tx.query<MessageRow>(
      `SELECT m.id AS "messageId", v.id AS "versionId",
         left(v.content, 1000) AS content
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN message_versions v
         ON v.message_id = m.id AND v.version_no = m.current_version
       LEFT JOIN learning_tasks t ON t.id = c.task_id
       WHERE c.student_id = $1 AND m.role = 'user'
         AND m.created_at >= $2 AND m.created_at < $3
         AND (c.task_id IS NULL OR t.deleted_at IS NULL)
         AND ($4::uuid IS NULL OR c.revision_id = $4)
         AND NOT EXISTS (
           SELECT 1 FROM evidence_invalidations i
           WHERE i.student_id = $1 AND i.evidence_version_id = v.id
         )
       ORDER BY m.created_at DESC, m.id
       LIMIT ${SOURCE_LIMIT}`,
      [scope.studentId, start, endExclusive, filter.revisionId ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    key: `message_version:${row.versionId}`,
    kind: "message_version",
    id: row.messageId,
    versionId: row.versionId,
    summary: truncate(`学生提问：${row.content}`, EVIDENCE_LIMITS.maxSummaryChars),
  }));
}

async function readMaterialEvidence(
  tx: PoolClient,
  scope: AdminInsightScope,
  filter: InsightFilter,
  start: Date,
  endExclusive: Date,
): Promise<InsightEvidence[]> {
  const rows = (
    await tx.query<MaterialRow>(
      `SELECT m.id, f.name, m.type, m.status
       FROM materials m
       JOIN files f ON f.id = m.file_id
       WHERE m.student_id = $1
         AND m.created_at >= $2 AND m.created_at < $3
         AND ($4::uuid IS NULL OR m.revision_id = $4)
       ORDER BY m.created_at DESC, m.id
       LIMIT ${SOURCE_LIMIT}`,
      [scope.studentId, start, endExclusive, filter.revisionId ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    key: `material:${row.id}`,
    kind: "material",
    id: row.id,
    summary: truncate(
      `资料《${row.name}》（${row.type}，${row.status}）`,
      EVIDENCE_LIMITS.maxSummaryChars,
    ),
  }));
}

export async function buildInsightSnapshot(
  tx: PoolClient,
  scope: AdminInsightScope,
  filter: InsightFilter,
  now: Date,
): Promise<InsightSnapshot> {
  const { overview, meta } = await readStudentOverview(tx, scope, filter, now);
  const start = new Date(`${filter.from}T00:00:00+08:00`);
  const endExclusive = new Date(
    new Date(`${filter.to}T00:00:00+08:00`).getTime() + 86_400_000,
  );
  const [mistakes, attempts, materials, messages] = await Promise.all([
    readMistakeEvidence(tx, scope, filter, start, endExclusive),
    readAttemptEvidence(tx, scope, filter, start, endExclusive),
    readMaterialEvidence(tx, scope, filter, start, endExclusive),
    readMessageEvidence(tx, scope, filter, start, endExclusive),
  ]);
  const { evidence, sample } = selectInsightEvidence([
    ...mistakes,
    ...attempts,
    ...materials,
    ...messages,
  ]);
  return {
    filter: {
      from: filter.from,
      to: filter.to,
      ...(filter.revisionId ? { revisionId: filter.revisionId } : {}),
    },
    meta,
    overview,
    evidence,
    sample,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

// 快照哈希只覆盖业务事实：请求时刻（dataAsOf）与随机 ID 都不参与。
export function hashInsightSnapshot(snapshot: InsightSnapshot): string {
  const meta: Record<string, unknown> = { ...snapshot.meta };
  delete meta.dataAsOf;
  return createHash("sha256")
    .update(
      stableStringify({
        filter: snapshot.filter,
        meta,
        overview: snapshot.overview,
        evidence: snapshot.evidence,
        sample: snapshot.sample,
      }),
    )
    .digest("hex");
}
