import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { cleanupChatImages } from "../../scripts/cleanup-chat-images.js";
import {
  inTransaction,
  type Database,
} from "../../packages/db/src/client.js";

function png(width = 600, height = 400): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#111111";
  ctx.font = "48px sans-serif";
  ctx.fillText("7+5=12", 40, 120);
  return canvas.toBuffer("image/png");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeFixture(db: Database) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数");
  const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
    revisionId: revision.id,
    kind: "free_question",
  });
  const upload = async () => {
    const bytes = png();
    const grant = await f.uploads.create(f.scope.actor, {
      studentId: f.scope.studentId,
      purpose: "conversation_image",
      conversationId: task.conversationId,
      name: "answer.png",
      contentType: "image/png",
      size: bytes.length,
    });
    f.store.put(grant.key, {
      size: bytes.length,
      contentType: "image/png",
      prefix: bytes,
    });
    return grant;
  };
  const ready = async () => {
    const grant = await upload();
    await f.uploads.complete(f.scope.actor, grant.fileId);
    return grant;
  };
  const backdate = (fileId: string, hours: number) =>
    db.pool.query(
      "UPDATE files SET created_at=now()-($2::int*interval '1 hour') WHERE id=$1",
      [fileId, hours],
    );
  const fileRow = async (fileId: string) =>
    (
      await db.pool.query<{
        status: string;
        object_key: string;
        source_key: string | null;
        sealed_key: string | null;
        cleanup_error: string | null;
      }>(
        "SELECT status,object_key,source_key,sealed_key,cleanup_error FROM files WHERE id=$1",
        [fileId],
      )
    ).rows[0];
  const version = async () => {
    const message = (
      await db.pool.query(
        "INSERT INTO messages(conversation_id,role) VALUES($1,'user') RETURNING id",
        [task.conversationId],
      )
    ).rows[0];
    return (
      await db.pool.query(
        "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
        [message.id, "图片作答"],
      )
    ).rows[0].id as string;
  };
  const attachments = new ConversationAttachmentService(db, f.auth, f.store);
  const bind = (versionId: string, fileIds: string[]) =>
    inTransaction(db, (tx) =>
      attachments.validateAndBind(
        tx,
        f.scope,
        task.conversationId,
        versionId,
        fileIds,
      ),
    );
  return {
    f,
    db,
    task,
    ready,
    backdate,
    fileRow,
    version,
    bind,
  };
}

async function scenario(
  run: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
): Promise<void> {
  await withTestDb(async (db) => {
    await run(await makeFixture(db));
  });
}

it("cleanup_never_deletes_bound_or_recent_files", () =>
  scenario(async ({ f, db, task, ready, backdate, fileRow, version, bind }) => {
    const bound = await ready();
    await backdate(bound.fileId, 48);
    await bind(await version(), [bound.fileId]);
    await db.pool.query(
      "UPDATE learning_tasks SET deleted_at=now(),version=version+1 WHERE id=$1",
      [task.id],
    );

    const recent = await ready();
    await backdate(recent.fileId, 23);

    const stale = await ready();
    await backdate(stale.fileId, 25);
    const staleRow = (await fileRow(stale.fileId))!;
    expect(staleRow.source_key).toBe(stale.key);
    expect(staleRow.sealed_key).toBeTruthy();
    expect(f.store.keys()).toContain(staleRow.source_key);
    expect(f.store.keys()).toContain(staleRow.sealed_key);

    const dryRun = await cleanupChatImages({
      db,
      store: f.store,
      execute: false,
    });
    expect(dryRun.eligible).toBe(1);
    expect(dryRun.cleaned).toBe(0);
    expect((await fileRow(stale.fileId))?.status).toBe("ready");
    expect(f.store.keys()).toContain(staleRow.sealed_key!);

    const result = await cleanupChatImages({
      db,
      store: f.store,
      execute: true,
    });
    expect(result).toMatchObject({ eligible: 1, cleaned: 1, failed: 0 });

    expect((await fileRow(bound.fileId))?.status).toBe("ready");
    expect(f.store.keys()).toContain((await fileRow(bound.fileId))!.sealed_key);
    expect((await fileRow(recent.fileId))?.status).toBe("ready");
    expect(f.store.keys()).toContain((await fileRow(recent.fileId))!.sealed_key);
    expect((await fileRow(stale.fileId))?.status).toBe("deleted");
    expect(f.store.keys()).not.toContain(staleRow.source_key);
    expect(f.store.keys()).not.toContain(staleRow.sealed_key);
  }));

it("bind_and_cleanup_race_has_one_winner", () =>
  scenario(async ({ f, db, ready, backdate, fileRow, version, bind }) => {
    const binderFirst = await ready();
    await backdate(binderFirst.fileId, 25);
    const binderVersion = await version();
    let cleanup: ReturnType<typeof cleanupChatImages> | undefined;
    await inTransaction(db, async (tx) => {
      await tx.query("SELECT id FROM files WHERE id=$1 FOR SHARE", [
        binderFirst.fileId,
      ]);
      cleanup = cleanupChatImages({
        db,
        store: f.store,
        execute: true,
      });
      await sleep(200);
      await tx.query(
        "INSERT INTO message_attachments(message_version_id,file_id,position) VALUES($1,$2,0)",
        [binderVersion, binderFirst.fileId],
      );
    });
    const binderResult = await cleanup!;
    expect(binderResult.cleaned).toBe(0);
    expect((await fileRow(binderFirst.fileId))?.status).toBe("ready");
    expect(f.store.keys()).toContain((await fileRow(binderFirst.fileId))!.sealed_key);

    const cleanupFirst = await ready();
    await backdate(cleanupFirst.fileId, 25);
    const cleanupVersion = await version();
    let bindError: unknown;
    let binding: Promise<unknown> | undefined;
    await inTransaction(db, async (tx) => {
      await tx.query("SELECT id FROM files WHERE id=$1 FOR UPDATE", [
        cleanupFirst.fileId,
      ]);
      await tx.query("UPDATE files SET status='deleting' WHERE id=$1", [
        cleanupFirst.fileId,
      ]);
      binding = bind(cleanupVersion, [cleanupFirst.fileId]).catch((error) => {
        bindError = error;
      });
      await sleep(200);
    });
    await binding;
    expect(bindError).toMatchObject({ code: "CONFLICT" });
    expect((await fileRow(cleanupFirst.fileId))?.status).toBe("deleting");
  }));

it("cleanup_retry_keeps_database_tracking_after_delete_failure", () =>
  scenario(async ({ f, ready, backdate, fileRow }) => {
    const file = await ready();
    await backdate(file.fileId, 25);
    const sealed = (await fileRow(file.fileId))!.sealed_key!;
    f.store.failDeleteOnce(sealed);

    const first = await cleanupChatImages({
      db: f.db,
      store: f.store,
      execute: true,
    });
    expect(first).toMatchObject({ cleaned: 0, failed: 1 });
    const failed = await fileRow(file.fileId);
    expect(failed?.status).toBe("cleanup_failed");
    expect(failed?.cleanup_error).toBeTruthy();
    expect(f.store.keys()).toContain(sealed);

    const second = await cleanupChatImages({
      db: f.db,
      store: f.store,
      execute: true,
    });
    expect(second).toMatchObject({ cleaned: 1, failed: 0 });
    expect((await fileRow(file.fileId))?.status).toBe("deleted");
    expect(f.store.keys()).not.toContain(sealed);
  }));
