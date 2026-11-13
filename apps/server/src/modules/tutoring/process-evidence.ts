import { createHash } from "node:crypto";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { DiagnosisEvidenceRef } from "../../../../../packages/contracts/src/tutoring.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { AuthService } from "../auth/service.js";

export type StepRef = { index: number; text: string; contentHash: string };

const MAX_STEPS = 20;

export function splitSteps(content: string): StepRef[] {
  return content
    .split(/\n+|；|;/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .slice(0, MAX_STEPS)
    .map((text, index) => ({
      index,
      text,
      contentHash: createHash("sha256").update(text).digest("hex"),
    }));
}

const contentHash = (content: string) =>
  createHash("sha256").update(content).digest("hex");

type ProcessRow = {
  id: string;
  message_version_id: string | null;
  kind: string;
  content: string | null;
  step_refs: StepRef[];
};

/**
 * Turns an attempt's saved work into locatable evidence references. Steps are
 * stored beside the original content so later edits cannot rewrite history.
 */
export class ProcessEvidenceService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}

  async collect(
    scope: StudentScope,
    attemptId: string,
  ): Promise<DiagnosisEvidenceRef[]> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const attempt = (
      await this.db.pool.query<{
        id: string;
        answer: string;
        message_version_id: string | null;
        question_version_id: string;
      }>(
        "SELECT a.id,a.answer,a.message_version_id,a.question_version_id FROM attempts a JOIN question_versions v ON v.id=a.question_version_id JOIN questions q ON q.id=v.question_id WHERE a.id=$1 AND a.student_id=$2 AND (q.student_id=$2 OR q.student_id IS NULL)",
        [attemptId, scope.studentId],
      )
    ).rows[0];
    if (!attempt) throw new AppError("NOT_FOUND", 404, "作答不存在");

    const answerSteps = splitSteps(attempt.answer);
    await this.db.pool.query(
      "INSERT INTO attempt_process_evidence(attempt_id,message_version_id,kind,content,content_hash,step_refs) VALUES($1,$2,'answer_text',$3,$4,$5::jsonb) ON CONFLICT (attempt_id,kind,content_hash) DO UPDATE SET step_refs=EXCLUDED.step_refs",
      [
        attempt.id,
        attempt.message_version_id,
        attempt.answer,
        contentHash(attempt.answer),
        JSON.stringify(answerSteps),
      ],
    );

    const rows = (
      await this.db.pool.query<ProcessRow>(
        "SELECT id,message_version_id,kind,content,step_refs FROM attempt_process_evidence WHERE attempt_id=$1 AND kind IN ('student_work','answer_text') ORDER BY created_at,id",
        [attempt.id],
      )
    ).rows;
    for (const row of rows) {
      if (row.step_refs.length || !row.content) continue;
      const steps = splitSteps(row.content);
      row.step_refs = steps;
      await this.db.pool.query(
        "UPDATE attempt_process_evidence SET step_refs=$2::jsonb WHERE id=$1",
        [row.id, JSON.stringify(steps)],
      );
    }

    const refs: DiagnosisEvidenceRef[] = rows.map((row) => ({
      kind: "process_step",
      id: row.id,
      ...(row.message_version_id ? { versionId: row.message_version_id } : {}),
    }));

    const messageVersions = [
      ...new Set([
        ...rows.flatMap((row) =>
          row.message_version_id ? [row.message_version_id] : [],
        ),
        ...(attempt.message_version_id ? [attempt.message_version_id] : []),
      ]),
    ];
    if (messageVersions.length) {
      const images = (
        await this.db.pool.query<{ file_id: string }>(
          "SELECT file_id FROM message_attachments WHERE message_version_id=ANY($1::uuid[]) ORDER BY message_version_id,position",
          [messageVersions],
        )
      ).rows;
      for (const image of images)
        refs.push({ kind: "image", id: image.file_id });
    }
    return refs;
  }
}
