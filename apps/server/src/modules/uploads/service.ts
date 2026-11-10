import { fileTooLarge } from "../../../../../packages/contracts/src/file-limits.js";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
} from "../../../../../packages/contracts/src/conversation-images.js";
import { imageSize } from "image-size";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import { KNOWLEDGE_SOURCE_CONTENT_TYPES } from "../../../../../packages/contracts/src/knowledge-base.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { FileStore } from "../../infra/oss.js";
import type { AuthService } from "../auth/service.js";
import { requireAdmin } from "../auth/policy.js";
import { uploadInput, type UploadGrant } from "./contracts.js";
export type FileRecord = {
  id: string;
  owner_id: string;
  student_id: string | null;
  conversation_id: string | null;
  purpose: string;
  name: string;
  content_type: string;
  size: string;
  object_key: string;
  status: string;
};
function matchesMime(type: string, prefix: Buffer) {
  if (type === "application/pdf")
    return prefix.subarray(0, 5).toString() === "%PDF-";
  if (type === "image/png")
    return prefix
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg")
    return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  // 纯文本没有魔数，只拒绝混入 NUL 的二进制内容。
  if (type === "text/plain" || type === "text/markdown")
    return !prefix.includes(0);
  return (
    prefix.subarray(0, 4).toString() === "RIFF" &&
    prefix.subarray(8, 12).toString() === "WEBP"
  );
}
export class UploadService {
  constructor(
    private db: Database,
    private auth: AuthService,
    readonly store?: FileStore,
    private publicAccess?: (actor: Actor, fileId: string) => Promise<boolean>,
  ) {}
  private requireStore() {
    if (!this.store)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        503,
        "文件存储尚未配置，请联系管理员",
      );
    return this.store;
  }
  async create(actor: Actor, input: unknown): Promise<UploadGrant> {
    const parsed = uploadInput.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "文件参数不正确");
    const v = parsed.data;
    if (fileTooLarge(v.purpose, v.contentType, v.size))
      throw new AppError("VALIDATION", 422, "文件超过大小限制");
    if (v.purpose === "textbook") {
      requireAdmin(actor);
      if (
        v.contentType !== "application/pdf" ||
        v.studentId ||
        v.conversationId
      )
        throw new AppError("VALIDATION", 422, "教材须为PDF");
    } else if (v.purpose === "student_material") {
      if (!v.studentId) throw new AppError("VALIDATION", 422, "缺少学生信息");
      if (v.conversationId)
        throw new AppError("VALIDATION", 422, "学生材料不属于会话");
      if (!v.contentType.startsWith("image/") && v.contentType !== "application/pdf")
        throw new AppError("VALIDATION", 422, "学生材料须为PDF或图片");
      await this.auth.requireStudentAccess(actor, v.studentId);
    } else if (v.purpose === "knowledge_source") {
      requireAdmin(actor);
      if (v.studentId || v.conversationId)
        throw new AppError("VALIDATION", 422, "知识点资料不属于学生");
      if (
        !KNOWLEDGE_SOURCE_CONTENT_TYPES.includes(
          v.contentType as (typeof KNOWLEDGE_SOURCE_CONTENT_TYPES)[number],
        )
      )
        throw new AppError("VALIDATION", 422, "文件类型不支持");
    } else {
      if (!v.studentId) throw new AppError("VALIDATION", 422, "缺少学生信息");
      if (!v.conversationId)
        throw new AppError("VALIDATION", 422, "缺少会话信息");
      if (!v.contentType.startsWith("image/"))
        throw new AppError("VALIDATION", 422, "会话附件须为图片");
      await this.auth.requireStudentAccess(actor, v.studentId);
      const owned = await this.db.pool.query(
        "SELECT 1 FROM conversations WHERE id=$1 AND student_id=$2",
        [v.conversationId, v.studentId],
      );
      if (!owned.rowCount)
        throw new AppError("NOT_FOUND", 404, "会话不存在");
    }
    const store = this.requireStore();
    const key = `${v.purpose}/${randomUUID()}`;
    const grant = await store.signUpload({ key, contentType: v.contentType });
    const row = (
      await this.db.pool.query(
        "INSERT INTO files(owner_id,student_id,conversation_id,purpose,name,content_type,size,object_key,source_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id",
        [
          actor.userId,
          v.studentId ?? null,
          v.conversationId ?? null,
          v.purpose,
          v.name,
          v.contentType,
          v.size,
          key,
        ],
      )
    ).rows[0];
    return {
      fileId: row.id,
      key,
      ...grant,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  }
  async authorize(actor: Actor, fileId: string): Promise<FileRecord> {
    z.uuid().parse(fileId);
    const row = (
      await this.db.pool.query<FileRecord>("SELECT * FROM files WHERE id=$1", [
        fileId,
      ])
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "文件不存在");
    if (row.student_id)
      await this.auth.requireStudentAccess(actor, row.student_id);
    else if (actor.role !== "admin") {
      if (!(await this.publicAccess?.(actor, fileId)))
        throw new AppError("NOT_FOUND", 404, "文件不存在");
    }
    return row;
  }
  async complete(actor: Actor, fileId: string): Promise<void> {
    await this.authorize(actor, fileId);
    let invalid = false;
    await inTransaction(this.db, async (tx) => {
      const row = (
        await tx.query<FileRecord>(
          "SELECT * FROM files WHERE id=$1 FOR UPDATE",
          [fileId],
        )
      ).rows[0]!;
      if (row.status === "ready") return;
      if (row.status === "rejected") {
        invalid = true;
        return;
      }
      if (!["prepared", "ready"].includes(row.status))
        throw new AppError("CONFLICT", 409, "文件已过期");
      const store = this.requireStore();
      const sealed = await store.seal(row.object_key);
      const meta = await store.head(sealed);
      let width: number | null = null;
      let height: number | null = null;
      let valid =
        meta.size === Number(row.size) &&
        meta.contentType.split(";")[0] === row.content_type &&
        matchesMime(row.content_type, meta.prefix);
      if (valid && row.purpose === "conversation_image") {
        try {
          if (meta.size > MAX_IMAGE_BYTES) valid = false;
          else {
            const dimensions = imageSize(await store.read(sealed));
            width = dimensions.width ?? null;
            height = dimensions.height ?? null;
            if (!width || !height || width * height > MAX_IMAGE_PIXELS)
              valid = false;
          }
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        await tx.query(
          "UPDATE files SET status='rejected',sealed_key=$2 WHERE id=$1",
          [fileId, sealed],
        );
        invalid = true;
        return;
      }
      await tx.query(
        "UPDATE files SET status='ready',object_key=$2,sealed_key=$2,width=$3,height=$4 WHERE id=$1",
        [fileId, sealed, width, height],
      );
    });
    if (invalid)
      throw new AppError("VALIDATION", 422, "文件格式或大小与声明不一致");
  }

  async getDownload(
    actor: Actor,
    fileId: string,
  ): Promise<{ url: string; contentType: string; expiresAt: string }> {
    const row = await this.authorize(actor, fileId);
    if (row.status !== "ready")
      throw new AppError("CONFLICT", 409, "文件尚未就绪");
    return {
      url: await this.requireStore().signDownload(row.object_key, 300),
      contentType: row.content_type,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
}
