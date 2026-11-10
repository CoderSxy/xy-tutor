import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import type { AuthService } from "../modules/auth/service.js";
import type { CatalogService } from "../modules/catalog/service.js";
import type { RunService } from "../modules/conversations/runs.js";
import { nextActions } from "./prompts.js";
export class BootstrapService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private catalog: CatalogService,
    private runs: RunService,
    private modelAvailable = false,
  ) {}
  async open(
    scope: StudentScope,
    input: unknown,
  ): Promise<{
    conversationId: string;
    actions: typeof nextActions;
    runId?: string;
    fallback: string;
  }> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({
        revisionId: z.uuid().optional(),
        entryKey: z.string().min(1).max(80),
      })
      .strict()
      .parse(input);
    const conversationId = await inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM student_profiles WHERE id=$1 FOR UPDATE", [
        scope.studentId,
      ]);
      const prev = (
        await tx.query(
          "SELECT conversation_id FROM learning_entries WHERE student_id=$1 AND entry_key=$2",
          [scope.studentId, v.entryKey],
        )
      ).rows[0];
      if (prev) return prev.conversation_id as string;
      const c = (
        await tx.query(
          "INSERT INTO conversations(student_id,revision_id) VALUES($1,NULL) RETURNING id",
          [scope.studentId],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO learning_entries(student_id,revision_id,entry_key,conversation_id) VALUES($1,NULL,$2,$3)",
        [scope.studentId, v.entryKey, c.id],
      );
      return c.id as string;
    });
    const run = this.modelAvailable
      ? await this.runs.submit(scope, {
          conversationId,
          requestKey: `opening:${v.entryKey}`,
          message:
            "请根据学生真实进度开启学习引导，进度未知先问最近学到哪里，给出学习入口，不提前批量出题。",
          mode: "opening",
        })
      : undefined;
    return {
      conversationId,
      actions: nextActions,
      runId: run?.runId,
      fallback: "今天想从哪里开始？你可以继续上次学习，或选择一个学习任务。",
    };
  }
}
