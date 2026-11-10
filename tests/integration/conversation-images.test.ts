import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { inTransaction, type Database } from "../../packages/db/src/client.js";

const password = "long-test-password";

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

function pngClaiming(width: number, height: number): Buffer {
  const bytes = Buffer.from(png(10, 10));
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function padded(bytes: Buffer, size: number): Buffer {
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
}

async function makeFixture(db: Database) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数");
  const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
    revisionId: revision.id,
    kind: "free_question",
  });
  const version = async (content = "图片作答") => {
    const message = (
      await db.pool.query(
        "INSERT INTO messages(conversation_id,role) VALUES($1,'user') RETURNING id",
        [task.conversationId],
      )
    ).rows[0];
    return (
      await db.pool.query(
        "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
        [message.id, content],
      )
    ).rows[0].id as string;
  };
  const upload = async (
    bytes: Buffer,
    contentType = "image/png",
    conversationId = task.conversationId,
    actor = f.scope.actor,
    studentId: string = f.scope.studentId,
  ) => {
    const grant = await f.uploads.create(actor, {
      studentId,
      purpose: "conversation_image",
      conversationId,
      name: "answer.png",
      contentType,
      size: bytes.length,
    });
    f.store.put(grant.key, { size: bytes.length, contentType, prefix: bytes });
    return grant;
  };
  const complete = (fileId: string) =>
    f.uploads.complete(f.scope.actor, fileId);
  return { f, db, revision, task, version, upload, complete };
}

async function scenario(
  run: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
): Promise<void> {
  await withTestDb(async (db) => {
    await run(await makeFixture(db));
  });
}

it("complete_is_idempotent_after_lost_response", () =>
  scenario(async ({ f, upload, complete }) => {
    const grant = await upload(png());
    const sealedBefore = f.store
      .keys()
      .filter((key) => key.startsWith("sealed/")).length;
    await complete(grant.fileId);
    const first = (
      await f.db.pool.query("SELECT object_key FROM files WHERE id=$1", [
        grant.fileId,
      ])
    ).rows[0].object_key;
    await complete(grant.fileId);
    const second = (
      await f.db.pool.query("SELECT object_key FROM files WHERE id=$1", [
        grant.fileId,
      ])
    ).rows[0].object_key;
    expect(second).toBe(first);
    expect(
      f.store.keys().filter((key) => key.startsWith("sealed/")),
    ).toHaveLength(sealedBefore + 1);
  }));

it("binds_only_ready_sealed_files", () =>
  scenario(async ({ f, db, task, version, upload, complete }) => {
    const attachments = new ConversationAttachmentService(db, f.auth, f.store);
    const first = await upload(png(640, 480));
    const second = await upload(png(320, 240));
    const versionId = await version();
    await expect(
      inTransaction(db, (tx) =>
        attachments.validateAndBind(
          tx,
          f.scope,
          task.conversationId,
          versionId,
          [first.fileId, second.fileId],
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await complete(first.fileId);
    await complete(second.fileId);
    const bound = await inTransaction(db, (tx) =>
      attachments.validateAndBind(tx, f.scope, task.conversationId, versionId, [
        second.fileId,
        first.fileId,
      ]),
    );
    expect(bound.map((item) => item.fileId)).toEqual([
      second.fileId,
      first.fileId,
    ]);
    expect(bound.map((item) => item.position)).toEqual([0, 1]);
    expect(bound[0]).toMatchObject({
      name: "answer.png",
      mimeType: "image/png",
      width: 320,
      height: 240,
    });
    const listed = await attachments.listForVersions(
      f.scope,
      task.conversationId,
      [versionId],
    );
    expect(listed.get(versionId)?.map((item) => item.fileId)).toEqual([
      second.fileId,
      first.fileId,
    ]);
  }));

it("rejects_cross_student_or_conversation_attachment", () =>
  scenario(async ({ f, db, revision, task, version, upload, complete }) => {
    const attachments = new ConversationAttachmentService(db, f.auth, f.store);
    const invitation = await f.auth.invite(f.admin, { login: "other" });
    const other = await f.auth.activate({
      token: invitation.activationToken,
      password,
    });
    const otherScope = await f.auth.requireStudentAccess(
      { userId: other.userId, role: "student" },
      other.studentId!,
    );
    const otherConversation = (
      await db.pool.query(
        "INSERT INTO conversations(student_id,revision_id) VALUES($1,$2) RETURNING id",
        [otherScope.studentId, revision.id],
      )
    ).rows[0].id as string;

    await expect(
      upload(png(), "image/png", otherConversation),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const theirs = await upload(
      png(),
      "image/png",
      otherConversation,
      otherScope.actor,
      otherScope.studentId,
    );
    await f.uploads.complete(otherScope.actor, theirs.fileId);

    const versionId = await version();
    await expect(
      inTransaction(db, (tx) =>
        attachments.validateAndBind(
          tx,
          f.scope,
          task.conversationId,
          versionId,
          [theirs.fileId],
        ),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const moved = await upload(png());
    await complete(moved.fileId);
    await db.pool.query("UPDATE files SET conversation_id=$2 WHERE id=$1", [
      moved.fileId,
      otherConversation,
    ]);
    await expect(
      inTransaction(db, (tx) =>
        attachments.validateAndBind(
          tx,
          f.scope,
          task.conversationId,
          versionId,
          [moved.fileId],
        ),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      attachments.listForVersions(otherScope, task.conversationId, [versionId]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }));

it("enforces image size, pixel and MIME limits", () =>
  scenario(async ({ f, upload, complete }) => {
    await expect(
      f.uploads.create(f.scope.actor, {
        studentId: f.scope.studentId,
        purpose: "conversation_image",
        conversationId: (
          await f.db.pool.query("SELECT id FROM conversations LIMIT 1")
        ).rows[0].id,
        name: "huge.png",
        contentType: "image/png",
        size: 15 * 1024 ** 2 + 1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const pixelled = await upload(pngClaiming(9000, 5000));
    await expect(complete(pixelled.fileId)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(
      (
        await f.db.pool.query("SELECT status FROM files WHERE id=$1", [
          pixelled.fileId,
        ])
      ).rows[0].status,
    ).toBe("rejected");

    const exact = await upload(pngClaiming(8000, 5000));
    await expect(complete(exact.fileId)).resolves.toBeUndefined();

    const oversized = await upload(padded(png(), 5 * 1024 ** 2 + 1));
    await expect(complete(oversized.fileId)).rejects.toMatchObject({
      code: "VALIDATION",
    });

    const forged = await upload(png(), "image/jpeg");
    await expect(complete(forged.fileId)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  }));

it("image_only_submission_is_atomic_and_idempotent", () =>
  scenario(async ({ f, db, task, upload, complete }) => {
    const tasks = new TaskService(db, f.auth, f.catalog);
    const question = await tasks.addQuestion(f.scope, task.id, {
      stem: "看图写出算式",
      role: "original",
    });
    const first = await upload(png(640, 480));
    const second = await upload(png(320, 240));
    await complete(first.fileId);
    await complete(second.fileId);
    const runs = new RunService(db, f.auth, f.store);
    const input = {
      conversationId: task.conversationId,
      requestKey: "image-answer",
      message: "",
      attachmentIds: [second.fileId, first.fileId],
      questionVersionId: question.questionVersionId,
    };
    const run = await runs.submit(f.scope, input);
    expect((await runs.submit(f.scope, input)).runId).toBe(run.runId);
    const counts = (
      await db.pool.query(
        "SELECT (SELECT count(*)::int FROM messages WHERE role='user') AS messages,(SELECT count(*)::int FROM agent_runs) AS runs,(SELECT count(*)::int FROM attempts) AS attempts",
      )
    ).rows[0];
    expect(counts).toEqual({ messages: 1, runs: 1, attempts: 1 });
    expect(
      (
        await db.pool.query(
          "SELECT f.id,a.answer,a.message_version_id=r.input_version_id AS linked FROM message_attachments ma JOIN files f ON f.id=ma.file_id JOIN message_versions mv ON mv.id=ma.message_version_id JOIN attempts a ON a.message_version_id=mv.id JOIN agent_runs r ON r.input_version_id=mv.id WHERE r.id=$1 ORDER BY ma.position",
          [run.runId],
        )
      ).rows,
    ).toEqual([
      { id: second.fileId, answer: "", linked: true },
      { id: first.fileId, answer: "", linked: true },
    ]);
    const title = (
      await db.pool.query("SELECT title FROM learning_tasks WHERE id=$1", [
        task.id,
      ])
    ).rows[0].title;
    expect(title).toBe("图片作答");

    const third = await upload(png(100, 100));
    await complete(third.fileId);
    await expect(
      runs.submit(f.scope, {
        ...input,
        attachmentIds: [first.fileId, third.fileId],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      runs.submit(f.scope, {
        ...input,
        attachmentIds: [first.fileId, second.fileId],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const pending = await upload(png(90, 90));
    await expect(
      runs.submit(f.scope, {
        ...input,
        requestKey: "image-pending",
        attachmentIds: [pending.fileId],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT count(*)::int FROM messages WHERE role='user') AS messages,(SELECT count(*)::int FROM agent_runs) AS runs",
        )
      ).rows[0],
    ).toEqual({ messages: 1, runs: 1 });
  }));

it("history_includes_ordered_attachments_and_edit_copies_them", () =>
  scenario(async ({ f, db, task, upload, complete }) => {
    const attachments = new ConversationAttachmentService(db, f.auth, f.store);
    const messages = new MessageService(db, f.auth);
    const first = await upload(png(640, 480));
    const second = await upload(png(320, 240));
    await complete(first.fileId);
    await complete(second.fileId);
    const message = await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "原答案",
    });
    await inTransaction(db, (tx) =>
      attachments.validateAndBind(
        tx,
        f.scope,
        task.conversationId,
        message.versionId,
        [second.fileId, first.fileId],
      ),
    );
    const edit = await messages.edit(f.scope, {
      messageId: message.id,
      expectedVersion: 1,
      content: "更正答案",
    });
    const history = await messages.history(f.scope, task.conversationId);
    expect(history[0]?.attachments.map((item) => item.fileId)).toEqual([
      second.fileId,
      first.fileId,
    ]);
    expect(
      history[0]?.versions.map((version) =>
        version.attachments.map((item) => item.fileId),
      ),
    ).toEqual([
      [second.fileId, first.fileId],
      [second.fileId, first.fileId],
    ]);
    expect(history[0]?.versions[1]?.id).toBe(edit.versionId);
  }));

it("binds with all pool connections occupied by caller transactions", async () =>
  withTestDb(async (db) => {
    const f = await makeFixture(db);
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => db.pool.connect()),
    );
    try {
      await Promise.all(clients.map((tx) => tx.query("BEGIN")));
      const service = new ConversationAttachmentService(db, f.f.auth);
      const results = await Promise.allSettled(
        clients.map((tx) =>
          service.validateAndBind(
            tx,
            f.f.scope,
            f.task.conversationId,
            f.task.id,
            [],
          ),
        ),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
    } finally {
      await Promise.all(
        clients.map(async (tx) => {
          await tx.query("ROLLBACK");
          tx.release();
        }),
      );
    }
  }));
