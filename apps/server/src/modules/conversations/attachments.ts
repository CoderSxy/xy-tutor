import type { PoolClient } from "pg";
import { z } from "zod";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  IMAGE_READ_CONCURRENCY,
  IMAGE_READ_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  type ImageAttachmentDTO,
} from "../../../../../packages/contracts/src/conversation-images.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { FileStore } from "../../infra/oss.js";
import type { AuthService } from "../auth/service.js";

type FileRow = {
  id: string;
  name: string;
  content_type: string;
  size: string | number;
  width: number | null;
  height: number | null;
  status: string;
  purpose: string;
  student_id: string | null;
  conversation_id: string | null;
};

export type LoadedImage = {
  fileId: string;
  mimeType: string;
  data: string;
  size: number;
};

export class ImageEvidenceReader {
  private cache = new Map<string, LoadedImage>();

  constructor(
    private db: Database,
    private store: FileStore,
  ) {}

  release(): void {
    this.cache.clear();
  }

  async load(
    fileIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<LoadedImage[]> {
    const unique = [...new Set(fileIds)];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(IMAGE_READ_CONCURRENCY, unique.length) },
      async () => {
        while (next < unique.length) {
          const fileId = unique[next++]!;
          if (!this.cache.has(fileId)) await this.loadOne(fileId, signal);
        }
      },
    );
    await Promise.all(workers);
    return fileIds.map((fileId) => this.cache.get(fileId)!);
  }

  private async loadOne(fileId: string, signal?: AbortSignal): Promise<void> {
    const row = (
      await this.db.pool.query<{
        object_key: string;
        content_type: string;
        status: string;
      }>("SELECT object_key,content_type,status FROM files WHERE id=$1", [
        fileId,
      ])
    ).rows[0];
    if (
      !row ||
      row.status !== "ready" ||
      !row.content_type.startsWith("image/")
    )
      throw new AppError("CONFLICT", 409, "图片尚未就绪");
    let bytes: Buffer;
    try {
      bytes = await this.readWithDeadline(row.object_key, signal);
    } catch (error) {
      if (signal?.aborted || error instanceof AppError) throw error;
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        503,
        "图片读取失败，请稍后重试",
      );
    }
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new AppError("VALIDATION", 422, "图片超过大小限制");
    this.cache.set(fileId, {
      fileId,
      mimeType: row.content_type,
      data: bytes.toString("base64"),
      size: bytes.length,
    });
  }

  private readWithDeadline(key: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () =>
        finish(() =>
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError")),
        );
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new AppError(
                "UPSTREAM_UNAVAILABLE",
                503,
                "图片读取超时，请稍后重试",
              ),
            ),
          ),
        IMAGE_READ_TIMEOUT_MS,
      );
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.store.read(key).then(
        (bytes) => finish(() => resolve(bytes)),
        (error) => finish(() => reject(error)),
      );
    });
  }
}

export class ConversationAttachmentService {
  constructor(
    private db: Database,
    private auth: AuthService,
    readonly store?: FileStore,
  ) {}

  async validateAndBind(
    tx: PoolClient,
    scope: StudentScope,
    conversationId: string,
    versionId: string,
    fileIds: readonly string[],
  ): Promise<ImageAttachmentDTO[]> {
    const access = await tx.query(
      "SELECT 1 FROM student_access WHERE student_id=$1 AND user_id=$2",
      [scope.studentId, scope.actor.userId],
    );
    if (!access.rowCount)
      throw new AppError("NOT_FOUND", 404, "学习记录不存在");
    await this.requireConversation(tx, scope, conversationId);
    if (new Set(fileIds).size !== fileIds.length)
      throw new AppError("VALIDATION", 422, "图片不能重复");
    if (fileIds.length > MAX_MESSAGE_IMAGES)
      throw new AppError("VALIDATION", 422, "每条消息最多 3 张图片");
    if (!fileIds.length) return [];
    const version = await tx.query(
      "SELECT 1 FROM message_versions mv JOIN messages m ON m.id=mv.message_id WHERE mv.id=$1 AND m.conversation_id=$2",
      [versionId, conversationId],
    );
    if (!version.rowCount) throw new AppError("NOT_FOUND", 404, "消息不存在");
    const rows = (
      await tx.query<FileRow>(
        "SELECT id,name,content_type,size,width,height,status,purpose,student_id,conversation_id FROM files WHERE id = ANY($1::uuid[]) FOR SHARE",
        [fileIds],
      )
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    let total = 0;
    const ordered = fileIds.map((fileId) => {
      const row = byId.get(fileId);
      if (
        !row ||
        row.purpose !== "conversation_image" ||
        row.student_id !== scope.studentId ||
        row.conversation_id !== conversationId
      )
        throw new AppError("NOT_FOUND", 404, "图片不存在");
      if (
        row.status !== "ready" ||
        !row.content_type.startsWith("image/") ||
        !row.width ||
        !row.height
      )
        throw new AppError("CONFLICT", 409, "图片尚未就绪");
      const size = Number(row.size);
      if (size > MAX_IMAGE_BYTES)
        throw new AppError("VALIDATION", 422, "图片超过大小限制");
      total += size;
      return row;
    });
    if (total > MAX_MESSAGE_IMAGE_BYTES)
      throw new AppError("VALIDATION", 422, "图片总大小超过限制");
    let inserted: { file_id: string; position: number }[];
    try {
      inserted = (
        await tx.query<{ file_id: string; position: number }>(
          "INSERT INTO message_attachments(message_version_id,file_id,position) SELECT $1, item.file_id, item.position - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS item(file_id,position) RETURNING file_id,position",
          [versionId, fileIds],
        )
      ).rows;
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new AppError("CONFLICT", 409, "图片已绑定到该消息");
      throw error;
    }
    const positions = new Map(
      inserted.map((row) => [row.file_id, row.position]),
    );
    return ordered.map((row) => ({
      fileId: row.id,
      name: row.name,
      mimeType: row.content_type,
      width: row.width!,
      height: row.height!,
      position: positions.get(row.id)!,
    }));
  }

  async listForVersions(
    scope: StudentScope,
    conversationId: string,
    versionIds: readonly string[],
  ): Promise<Map<string, ImageAttachmentDTO[]>> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    await this.requireConversation(this.db.pool, scope, conversationId);
    const grouped = new Map<string, ImageAttachmentDTO[]>(
      versionIds.map((id) => [id, []]),
    );
    if (!versionIds.length) return grouped;
    const rows = (
      await this.db.pool.query<{
        message_version_id: string;
        file_id: string;
        name: string;
        content_type: string;
        width: number;
        height: number;
        position: number;
      }>(
        "SELECT ma.message_version_id,f.id AS file_id,f.name,f.content_type,f.width,f.height,ma.position FROM message_attachments ma JOIN message_versions mv ON mv.id=ma.message_version_id JOIN messages m ON m.id=mv.message_id JOIN files f ON f.id=ma.file_id WHERE m.conversation_id=$1 AND ma.message_version_id = ANY($2::uuid[]) ORDER BY ma.message_version_id,ma.position",
        [conversationId, versionIds],
      )
    ).rows;
    for (const row of rows)
      grouped.get(row.message_version_id)?.push({
        fileId: row.file_id,
        name: row.name,
        mimeType: row.content_type,
        width: row.width,
        height: row.height,
        position: row.position,
      });
    return grouped;
  }

  private async requireConversation(
    queryable: Pick<PoolClient, "query">,
    scope: StudentScope,
    conversationId: string,
  ): Promise<void> {
    z.uuid().parse(conversationId);
    const owned = await queryable.query(
      "SELECT 1 FROM conversations WHERE id=$1 AND student_id=$2",
      [conversationId, scope.studentId],
    );
    if (!owned.rowCount) throw new AppError("NOT_FOUND", 404, "会话不存在");
  }
}
