import { fileTooLarge } from "../../../../../packages/contracts/src/file-limits.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
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
      if (v.contentType !== "application/pdf" || v.studentId)
        throw new AppError("VALIDATION", 422, "教材须为PDF");
    } else {
      if (!v.studentId) throw new AppError("VALIDATION", 422, "缺少学生信息");
      await this.auth.requireStudentAccess(actor, v.studentId);
    }
    const store = this.requireStore();
    const key = `${v.purpose}/${randomUUID()}`;
    const grant = await store.signUpload({ key, contentType: v.contentType });
    const row = (
      await this.db.pool.query(
        "INSERT INTO files(owner_id,student_id,purpose,name,content_type,size,object_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          actor.userId,
          v.studentId ?? null,
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
      const store = this.requireStore();
      const sealed = await store.seal(row.object_key);
      const meta = await store.head(sealed);
      if (
        meta.size !== Number(row.size) ||
        meta.contentType.split(";")[0] !== row.content_type ||
        !matchesMime(row.content_type, meta.prefix)
      ) {
        await tx.query("UPDATE files SET status='rejected' WHERE id=$1", [
          fileId,
        ]);
        invalid = true;
        return;
      }
      await tx.query(
        "UPDATE files SET status='ready',object_key=$2 WHERE id=$1",
        [fileId, sealed],
      );
    });
    if (invalid)
      throw new AppError("VALIDATION", 422, "文件格式或大小与声明不一致");
  }

  async getDownload(
    actor: Actor,
    fileId: string,
  ): Promise<{ url: string; contentType: string }> {
    const row = await this.authorize(actor, fileId);
    if (row.status !== "ready")
      throw new AppError("CONFLICT", 409, "文件尚未就绪");
    return {
      url: await this.requireStore().signDownload(row.object_key, 300),
      contentType: row.content_type,
    };
  }
}
