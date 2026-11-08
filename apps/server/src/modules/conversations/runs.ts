import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
import { EventStore } from "./events.js";
export interface RunExecutor {
  execute(runId: string, signal: AbortSignal): Promise<void>;
}
export type RunDTO = {
  id: string;
  status: string;
  conversationId: string;
  inputVersionId: string | null;
  outputVersionId: string | null;
  content: string | null;
};
export class RunService {
  readonly events: EventStore;
  private ticking = false;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
  ) {
    this.events = new EventStore(db, auth);
  }
  async latest(
    scope: StudentScope,
    conversationId: string,
  ): Promise<RunDTO | null> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(conversationId);
    const c = await this.db.pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND student_id=$2",
      [conversationId, scope.studentId],
    );
    if (!c.rowCount) throw new AppError("NOT_FOUND", 404, "会话不存在");
    const row = (
      await this.db.pool.query(
        "SELECT id FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1",
        [conversationId],
      )
    ).rows[0];
    return row ? this.get(scope, row.id) : null;
  }
  async submit(
    scope: StudentScope,
    input: unknown,
  ): Promise<{ runId: string }> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({
        conversationId: z.uuid(),
        requestKey: z.string().min(1).max(120),
        message: z.string().trim().min(1).max(20000),
        mode: z.enum(["reply", "opening"]).default("reply"),
        questionVersionId: z.uuid().optional(),
      })
      .strict()
      .parse(input);
    return inTransaction(this.db, async (tx) => {
      const c = (
        await tx.query(
          "SELECT * FROM conversations WHERE id=$1 AND student_id=$2 FOR UPDATE",
          [v.conversationId, scope.studentId],
        )
      ).rows[0];
      if (!c) throw new AppError("NOT_FOUND", 404, "会话不存在");
      const prev = (
        await tx.query(
          "SELECT id,input_text,question_version_id FROM agent_runs WHERE conversation_id=$1 AND request_key=$2",
          [c.id, v.requestKey],
        )
      ).rows[0];
      if (prev) {
        if (
          prev.input_text !== v.message ||
          (prev.question_version_id ?? undefined) !== v.questionVersionId
        )
          throw new AppError("CONFLICT", 409, "请求内容与原执行不同");
        return { runId: prev.id };
      }
      if (
        (
          await tx.query(
            "SELECT 1 FROM agent_runs WHERE conversation_id=$1 AND status IN ('queued','running')",
            [c.id],
          )
        ).rowCount
      )
        throw new AppError("CONFLICT", 409, "请等待当前回答完成或先停止");
      let versionId: string | null = null;
      if (v.mode === "reply") {
        const m = (
          await tx.query(
            "INSERT INTO messages(conversation_id,role,request_key) VALUES($1,'user',$2) RETURNING id",
            [c.id, `run:${v.requestKey}`],
          )
        ).rows[0];
        versionId = (
          await tx.query(
            "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
            [m.id, v.message],
          )
        ).rows[0].id;
      }
      if (v.questionVersionId) {
        if (!c.task_id || v.mode !== "reply" || !versionId)
          throw new AppError("VALIDATION", 422, "作答需要关联学习任务");
        const valid = (
          await tx.query(
            "SELECT i.id FROM task_items i JOIN learning_tasks t ON t.id=i.task_id WHERE i.task_id=$1 AND i.question_version_id=$2 AND t.student_id=$3 AND t.status='active'",
            [c.task_id, v.questionVersionId, scope.studentId],
          )
        ).rows[0];
        if (!valid) throw new AppError("NOT_FOUND", 404, "当前题目不存在");
        await tx.query(
          "INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer) VALUES($1,$2,$3,$4,$5,$6)",
          [
            scope.studentId,
            c.task_id,
            v.questionVersionId,
            versionId,
            `run:${v.requestKey}`,
            v.message,
          ],
        );
        await tx.query("UPDATE task_items SET status='answered' WHERE id=$1", [
          valid.id,
        ]);
      }
      const r = (
        await tx.query(
          "INSERT INTO agent_runs(student_id,actor_id,conversation_id,request_key,input_text,input_version_id,mode,question_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [
            scope.studentId,
            scope.actor.userId,
            c.id,
            v.requestKey,
            v.message,
            versionId,
            v.mode,
            v.questionVersionId ?? null,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO run_events(run_id,type,data) VALUES($1,'queued','{}')",
        [r.id],
      );
      return { runId: r.id };
    });
  }
  async get(scope: StudentScope, id: string): Promise<RunDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(id);
    const row = (
      await this.db.pool.query<RunDTO>(
        'SELECT r.id,r.status,r.conversation_id AS "conversationId",r.input_version_id AS "inputVersionId",r.output_version_id AS "outputVersionId",v.content FROM agent_runs r LEFT JOIN message_versions v ON v.id=r.output_version_id WHERE r.id=$1 AND r.student_id=$2',
        [id, scope.studentId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "执行不存在");
    return row;
  }
  async cancel(scope: StudentScope, id: string): Promise<void> {
    await this.get(scope, id);
    const changed = await this.db.pool.query(
      "UPDATE agent_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND status IN ('queued','running') RETURNING id",
      [id],
    );
    this.active.get(id)?.controller.abort();
    if (changed.rowCount)
      await this.events.append(id, {
        type: "cancelled",
        data: { partial: true },
      });
  }
  async recoverExpired(now: Date): Promise<void> {
    await this.db.pool.query(
      "UPDATE agent_runs SET status='interrupted',lease_token=NULL,lease_expires_at=NULL WHERE status='running' AND lease_expires_at<$1",
      [now],
    );
  }
  async tick(executor: RunExecutor): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recoverExpired(new Date());
      while (this.active.size < 2) {
        const token = randomUUID();
        const r = (
          await this.db.pool.query(
            "WITH candidate AS(SELECT id FROM agent_runs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE agent_runs r SET status='running',lease_token=$1,lease_expires_at=now()+interval '30 seconds' FROM candidate c WHERE r.id=c.id RETURNING r.id",
            [token],
          )
        ).rows[0];
        if (!r) break;
        const controller = new AbortController();
        const promise = this.executeClaimed(r.id, token, controller, executor);
        this.active.set(r.id, { controller, promise });
        void promise.then(
          () => this.active.delete(r.id),
          () => this.active.delete(r.id),
        );
      }
    } finally {
      this.ticking = false;
    }
  }
  private async executeClaimed(
    id: string,
    token: string,
    controller: AbortController,
    executor: RunExecutor,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.db.pool
        .query(
          "UPDATE agent_runs SET lease_expires_at=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
          [id, token],
        )
        .then((r) => {
          if (!r.rowCount) controller.abort();
        })
        .catch(() => controller.abort());
    }, 10000);
    heartbeat.unref();
    try {
      await this.events.append(id, { type: "started", data: {} });
      await executor.execute(id, controller.signal);
      const updated = await this.db.pool.query(
        "UPDATE agent_runs SET status='succeeded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
        [id, token],
      );
      if (updated.rowCount)
        await this.events.append(id, { type: "done", data: {} });
    } catch {
      const updated = await this.db.pool.query(
        "UPDATE agent_runs SET status='failed',lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
        [id, token],
      );
      if (updated.rowCount)
        await this.events.append(id, {
          type: "failed",
          data: { message: "回答暂时中断，可稍后继续" },
        });
    } finally {
      clearInterval(heartbeat);
    }
  }
  start(executor: RunExecutor) {
    this.timer = setInterval(() => {
      void this.tick(executor).catch(() => {});
    }, 300);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }
}
