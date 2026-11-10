import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
import { recordLearningEvent } from "../student-insights/activity.js";
import { ConversationAttachmentService } from "./attachments.js";
import type { MessageDTO, MessageHistory } from "./contracts.js";
export class MessageService {
  readonly attachments: ConversationAttachmentService;
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
  ) {
    this.attachments = new ConversationAttachmentService(db, auth);
  }
  async authorize(scope: StudentScope, conversationId: string): Promise<void> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(conversationId);
    if (
      !(
        await this.db.pool.query(
          "SELECT 1 FROM conversations WHERE id=$1 AND student_id=$2",
          [conversationId, scope.studentId],
        )
      ).rowCount
    )
      throw new AppError("NOT_FOUND", 404, "会话不存在");
  }
  async append(scope: StudentScope, input: unknown): Promise<MessageDTO> {
    const v = z
      .object({
        conversationId: z.uuid(),
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().max(100000),
        requestKey: z.string().min(1).max(120).optional(),
        regeneratedFrom: z.uuid().optional(),
      })
      .strict()
      .parse(input);
    await this.authorize(scope, v.conversationId);
    return inTransaction(this.db, async (tx) => {
      const conversation = (
        await tx.query(
          'SELECT id, task_id AS "taskId", revision_id AS "revisionId" FROM conversations WHERE id=$1 FOR UPDATE',
          [v.conversationId],
        )
      ).rows[0];
      if (v.requestKey) {
        const prev = (
          await tx.query(
            'SELECT m.id,m.role,m.regenerated_from AS "regeneratedFrom",v.id AS "versionId",v.version_no AS "versionNo",v.content FROM messages m JOIN message_versions v ON v.message_id=m.id AND v.version_no=m.current_version WHERE m.conversation_id=$1 AND m.request_key=$2',
            [v.conversationId, v.requestKey],
          )
        ).rows[0];
        if (prev) {
          if (prev.content !== v.content || prev.role !== v.role)
            throw new AppError("CONFLICT", 409, "重复请求内容不一致");
          return prev;
        }
      }
      const m = (
        await tx.query(
          "INSERT INTO messages(conversation_id,role,request_key,regenerated_from) VALUES($1,$2,$3,$4) RETURNING id",
          [
            v.conversationId,
            v.role,
            v.requestKey ?? null,
            v.regeneratedFrom ?? null,
          ],
        )
      ).rows[0];
      const mv = (
        await tx.query(
          "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
          [m.id, v.content],
        )
      ).rows[0];
      if (v.role === "user")
        await recordLearningEvent(tx, {
          studentId: scope.studentId,
          actorId: scope.actor.userId,
          eventType: "learning_message_sent",
          sourceType: "message",
          sourceId: m.id,
          taskId: conversation.taskId,
          revisionId: conversation.revisionId,
          occurredAt: new Date(),
          sourceOrigin: "live",
        });
      return {
        id: m.id,
        versionId: mv.id,
        versionNo: 1,
        content: v.content,
        role: v.role,
        regeneratedFrom: v.regeneratedFrom,
      };
    });
  }
  async edit(scope: StudentScope, input: unknown): Promise<MessageDTO> {
    const v = z
      .object({
        messageId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        content: z.string().max(100000),
      })
      .strict()
      .parse(input);
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return inTransaction(this.db, async (tx) => {
      const m = (
        await tx.query(
          "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND c.student_id=$2 FOR UPDATE OF m",
          [v.messageId, scope.studentId],
        )
      ).rows[0];
      if (!m) throw new AppError("NOT_FOUND", 404, "消息不存在");
      if (m.role !== "user")
        throw new AppError("FORBIDDEN", 403, "只能编辑学生消息");
      if (m.current_version !== v.expectedVersion)
        throw new AppError("CONFLICT", 409, "消息已更新");
      const old = (
        await tx.query(
          "SELECT id FROM message_versions WHERE message_id=$1 AND version_no=$2",
          [m.id, m.current_version],
        )
      ).rows[0];
      const next = m.current_version + 1;
      const mv = (
        await tx.query(
          "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,$2,$3) RETURNING id",
          [m.id, next, v.content],
        )
      ).rows[0];
      await tx.query("UPDATE messages SET current_version=$1 WHERE id=$2", [
        next,
        m.id,
      ]);
      await tx.query(
        "INSERT INTO message_attachments(message_version_id,file_id,position) SELECT $1,file_id,position FROM message_attachments WHERE message_version_id=$2",
        [mv.id, old.id],
      );
      await tx.query(
        "INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason) VALUES($1,$2,'message_edited')",
        [scope.studentId, old.id],
      );
      return {
        id: m.id,
        versionId: mv.id,
        versionNo: next,
        content: v.content,
        role: m.role,
      };
    });
  }
  async history(
    scope: StudentScope,
    conversationId: string,
  ): Promise<MessageHistory[]> {
    await this.authorize(scope, conversationId);
    const rows = (
      await this.db.pool.query(
        "SELECT m.id,m.role,m.current_version,m.regenerated_from,v.id AS version_id,v.version_no,v.content FROM messages m JOIN message_versions v ON v.message_id=m.id WHERE m.conversation_id=$1 ORDER BY m.created_at,m.id,v.version_no",
        [conversationId],
      )
    ).rows;
    const messages = new Map<string, MessageHistory>();
    for (const row of rows) {
      let m = messages.get(row.id);
      if (!m) {
        m = {
          id: row.id,
          role: row.role,
          versionId: "",
          versionNo: row.current_version,
          content: "",
          regeneratedFrom: row.regenerated_from,
          attachments: [],
          versions: [],
        };
        messages.set(row.id, m);
      }
      m.versions.push({
        id: row.version_id,
        versionNo: row.version_no,
        content: row.content,
        attachments: [],
      });
      if (row.version_no === row.current_version) {
        m.versionId = row.version_id;
        m.content = row.content;
      }
    }
    const list = [...messages.values()];
    const grouped = await this.attachments.listForVersions(
      scope,
      conversationId,
      list.flatMap((item) => item.versions.map((version) => version.id)),
    );
    for (const message of list) {
      for (const version of message.versions)
        version.attachments = grouped.get(version.id) ?? [];
      message.attachments =
        message.versions.find((version) => version.id === message.versionId)
          ?.attachments ?? [];
    }
    return list;
  }
  async regenerate(
    scope: StudentScope,
    input: { messageId: string; content: string },
  ): Promise<MessageDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(input.messageId);
    const original = (
      await this.db.pool.query(
        "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND c.student_id=$2",
        [input.messageId, scope.studentId],
      )
    ).rows[0];
    if (!original || original.role !== "assistant")
      throw new AppError("NOT_FOUND", 404, "原回答不存在");
    return this.append(scope, {
      conversationId: original.conversation_id,
      role: "assistant",
      content: input.content,
      regeneratedFrom: input.messageId,
    });
  }
}
