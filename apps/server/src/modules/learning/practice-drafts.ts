import { z } from "zod";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  draftInputSchema,
  type DraftDTO,
} from "../../../../../packages/contracts/src/practice-sets.js";
import { answerPayloadSchema } from "../../../../../packages/contracts/src/question-presentation.js";
import type { AuthService } from "../auth/service.js";
import type { PracticeSetService } from "./practice-sets.js";
import {
  assertAnswerMatchesPresentation,
  PresentationValidationError,
} from "../question-bank/presentation.js";

export class PracticeDraftService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private sets: PracticeSetService,
  ) {}

  async put(
    scope: StudentScope,
    setId: string,
    itemId: string,
    input: unknown,
  ): Promise<DraftDTO> {
    const parsed = draftInputSchema.parse(input);
    const set = await this.sets.get(scope, setId);
    z.uuid().parse(itemId);
    const item = set.items.find((entry) => entry.itemId === itemId);
    if (!item?.itemId || !item.presentation)
      throw new AppError("NOT_FOUND", 404, "题目不存在");
    const existing = (
      await this.db.pool.query<{ version: number }>(
        "SELECT version FROM practice_answer_drafts WHERE student_id=$1 AND task_item_id=$2",
        [scope.studentId, itemId],
      )
    ).rows[0];
    if (existing && existing.version !== parsed.expectedVersion)
      throw new AppError("CONFLICT", 409, "草稿已更新，请刷新后重试");
    try {
      assertAnswerMatchesPresentation(item.presentation, parsed.answer);
    } catch (error) {
      if (error instanceof PresentationValidationError)
        throw new AppError("NOT_FOUND", 404, error.message);
      throw error;
    }
    if (!existing) {
      if (parsed.expectedVersion !== 1)
        throw new AppError("CONFLICT", 409, "草稿已更新，请刷新后重试");
      const row = (
        await this.db.pool.query<{
          version: number;
          updated_at: Date;
        }>(
          `INSERT INTO practice_answer_drafts(student_id,task_item_id,payload,version)
           VALUES($1,$2,$3::jsonb,1)
           RETURNING version, updated_at`,
          [scope.studentId, itemId, JSON.stringify(parsed.answer)],
        )
      ).rows[0]!;
      return {
        itemId,
        answer: parsed.answer,
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      };
    }
    const row = (
      await this.db.pool.query<{
        version: number;
        updated_at: Date;
        payload: unknown;
      }>(
        `UPDATE practice_answer_drafts
         SET payload=$3::jsonb, version=version+1, updated_at=now()
         WHERE student_id=$1 AND task_item_id=$2 AND version=$4
         RETURNING version, updated_at, payload`,
        [
          scope.studentId,
          itemId,
          JSON.stringify(parsed.answer),
          parsed.expectedVersion,
        ],
      )
    ).rows[0];
    if (!row) throw new AppError("CONFLICT", 409, "草稿已更新，请刷新后重试");
    return {
      itemId,
      answer: answerPayloadSchema.parse(row.payload),
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async list(scope: StudentScope, setId: string): Promise<DraftDTO[]> {
    const set = await this.sets.get(scope, setId);
    const ids = set.items
      .map((item) => item.itemId)
      .filter((id): id is string => !!id);
    if (!ids.length) return [];
    const rows = (
      await this.db.pool.query<{
        task_item_id: string;
        payload: unknown;
        version: number;
        updated_at: Date;
      }>(
        `SELECT task_item_id, payload, version, updated_at
         FROM practice_answer_drafts
         WHERE student_id=$1 AND task_item_id = ANY($2::uuid[])
         ORDER BY updated_at`,
        [scope.studentId, ids],
      )
    ).rows;
    return rows.map((row) => ({
      itemId: row.task_item_id,
      answer: answerPayloadSchema.parse(row.payload),
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    }));
  }
}
