import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { UploadService } from "../../apps/server/src/modules/uploads/service.js";
import { MemoryFileStore } from "../helpers/files.js";
import type { ModelGateway } from "../../apps/server/src/agent/provider.js";
import type { Database } from "../../packages/db/src/client.js";
import { parseKnowledgeRun } from "../../apps/server/src/jobs/knowledge-parse-job.js";

const password = "test-password-long";
const signal = new AbortController().signal;

async function fixture(db: Database) {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("admin", password);
  const batch = async (input: {
    text: string | null;
    extraPrompt?: string | null;
    files?: { contentType: string; objectKey: string }[];
  }) => {
    const row = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_batches(actor_id,text_content) VALUES($1,$2) RETURNING id",
        [admin.userId, input.text],
      )
    ).rows[0]!;
    for (const [position, file] of (input.files ?? []).entries()) {
      const fileRow = (
        await db.pool.query<{ id: string }>(
          "INSERT INTO files(owner_id,purpose,name,content_type,size,object_key,status) VALUES($1,'knowledge_source','资料',$2,1,$3,'ready') RETURNING id",
          [admin.userId, file.contentType, file.objectKey],
        )
      ).rows[0]!;
      await db.pool.query(
        "INSERT INTO knowledge_batch_files(batch_id,file_id,position) VALUES($1,$2,$3)",
        [row.id, fileRow.id, position],
      );
    }
    const run = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status) VALUES($1,$2,'queued') RETURNING id",
        [row.id, input.extraPrompt ?? null],
      )
    ).rows[0]!;
    return { batchId: row.id, runId: run.id };
  };
  return { auth, admin, batch };
}

function fakeGateway(
  output: { text: string } | { error: Error },
  requests: unknown[] = [],
) {
  return {
    runtime: { model: { id: "fake-model" } },
    complete: async (request: unknown) => {
      requests.push(request);
      if ("error" in output) throw output.error;
      return { text: output.text, toolCalls: [] };
    },
  } as unknown as ModelGateway;
}

function itemsResponse(items: { title: string; summary: string }[]) {
  return { text: JSON.stringify({ items }) };
}

it("stores review items and marks the run succeeded", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.batch({
      text: "分数加减法要先通分，再计算分子。",
      extraPrompt: "按计算步骤拆分",
    });
    const requests: unknown[] = [];
    const gateway = fakeGateway(
      itemsResponse([
        { title: "通分", summary: "把异分母分数化为同分母分数" },
        { title: "分数加减法", summary: "通分后分子相加减" },
      ]),
      requests,
    );

    await parseKnowledgeRun(db, gateway, new UploadService(db, f.auth), runId, signal);

    const run = (
      await db.pool.query(
        "SELECT status,model,error_code,completed_at FROM knowledge_parse_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    expect(run.status).toBe("succeeded");
    expect(run.model).toBe("fake-model");
    expect(run.error_code).toBeNull();
    expect(run.completed_at).toBeInstanceOf(Date);

    const items = (
      await db.pool.query(
        "SELECT batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at FROM knowledge_items ORDER BY title",
      )
    ).rows;
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batch_id: batchId,
          parse_run_id: runId,
          title: "分数加减法",
          status: "pending_review",
          replaces_item_id: null,
          published_at: null,
        }),
      ]),
    );

    const request = requests[0] as {
      priority: string;
      context: { systemPrompt: string; messages: { content: string }[] };
    };
    expect(request.priority).toBe("background");
    expect(request.context.systemPrompt).toContain("知识点");
    expect(request.context.messages[0]!.content).toContain("按计算步骤拆分");
  }));

it("marks the run failed and inserts nothing when the model throws", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { runId } = await f.batch({ text: "一元一次方程" });
    const gateway = fakeGateway({ error: Error("模型服务暂时不可用") });

    await expect(
      parseKnowledgeRun(db, gateway, new UploadService(db, f.auth), runId, signal),
    ).rejects.toThrow("模型服务暂时不可用");

    const run = (
      await db.pool.query(
        "SELECT status,error_code FROM knowledge_parse_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    expect(run).toMatchObject({
      status: "failed",
      error_code: "PROCESSING_FAILED",
    });
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM knowledge_items"))
        .rows[0].n,
    ).toBe(0);
  }));

it("rejects invalid model output without inserting items", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { runId } = await f.batch({ text: "勾股定理" });
    const gateway = fakeGateway({ text: "这不是 JSON" });

    await expect(
      parseKnowledgeRun(db, gateway, new UploadService(db, f.auth), runId, signal),
    ).rejects.toThrow("PARSE_INVALID_OUTPUT");

    const run = (
      await db.pool.query(
        "SELECT status,error_code FROM knowledge_parse_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    expect(run).toMatchObject({
      status: "failed",
      error_code: "PARSE_INVALID_OUTPUT",
    });
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM knowledge_items"))
        .rows[0].n,
    ).toBe(0);
  }));

it("fails file batches when object storage is not configured", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const objectKey = `knowledge_source/${randomUUID()}`;
    const { runId } = await f.batch({
      text: null,
      files: [{ contentType: "text/markdown", objectKey }],
    });
    const requests: unknown[] = [];
    const gateway = fakeGateway(
      itemsResponse([{ title: "知识点", summary: "摘要" }]),
      requests,
    );

    await expect(
      parseKnowledgeRun(db, gateway, new UploadService(db, f.auth), runId, signal),
    ).rejects.toThrow("OSS_NOT_CONFIGURED");

    const run = (
      await db.pool.query(
        "SELECT status,error_code FROM knowledge_parse_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    expect(run).toMatchObject({
      status: "failed",
      error_code: "OSS_NOT_CONFIGURED",
    });
    expect(requests).toHaveLength(0);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM knowledge_items"))
        .rows[0].n,
    ).toBe(0);
  }));

it("parses text-only batches without object storage", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { runId } = await f.batch({ text: "等腰三角形的两个底角相等" });
    const gateway = fakeGateway(
      itemsResponse([{ title: "等腰三角形", summary: "两底角相等" }]),
    );

    await parseKnowledgeRun(
      db,
      gateway,
      new UploadService(db, f.auth),
      runId,
      signal,
    );

    expect(
      (
        await db.pool.query(
          "SELECT status FROM knowledge_parse_runs WHERE id=$1",
          [runId],
        )
      ).rows[0].status,
    ).toBe("succeeded");
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM knowledge_items"))
        .rows[0].n,
    ).toBe(1);
  }));

it("reads file batches through the configured store", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const store = new MemoryFileStore();
    const objectKey = `knowledge_source/${randomUUID()}`;
    store.put(objectKey, {
      size: 9,
      contentType: "text/plain",
      prefix: Buffer.from("约分的依据"),
    });
    const { runId } = await f.batch({
      text: null,
      files: [{ contentType: "text/plain", objectKey }],
    });
    const requests: unknown[] = [];
    const gateway = fakeGateway(
      itemsResponse([{ title: "约分", summary: "分子分母同除公因数" }]),
      requests,
    );

    await parseKnowledgeRun(
      db,
      gateway,
      new UploadService(db, f.auth, store),
      runId,
      signal,
    );

    expect(requests).toHaveLength(1);
    expect(
      (requests[0] as { context: { messages: { content: string }[] } }).context
        .messages[0]!.content,
    ).toContain("约分的依据");
    expect(
      (
        await db.pool.query(
          "SELECT status FROM knowledge_parse_runs WHERE id=$1",
          [runId],
        )
      ).rows[0].status,
    ).toBe("succeeded");
  }));

it("revises one published item using the batch source", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.batch({
      text: "这一整章讲一元一次方程、二元一次方程和不等式。",
    });
    const published = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at) VALUES($1,$2,'一元一次方程','移项后合并同类项','published',now()) RETURNING id",
        [batchId, runId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      "UPDATE knowledge_parse_runs SET status='succeeded',completed_at=now() WHERE id=$1",
      [runId],
    );
    const revision = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status) VALUES($1,'把步骤拆细','queued') RETURNING id",
        [batchId],
      )
    ).rows[0]!.id;
    const requests: unknown[] = [];
    const gateway = fakeGateway(
      itemsResponse([
        { title: "移项", summary: "把未知数留在一边" },
        { title: "合并同类项", summary: "系数相加" },
      ]),
      requests,
    );

    await parseKnowledgeRun(db, gateway, new UploadService(db, f.auth), revision, signal, {
      replacesItemId: published,
    });

    const content = (
      requests[0] as { context: { messages: { content: string }[] } }
    ).context.messages[0]!.content;
    expect(content).toContain("移项后合并同类项");
    expect(content).toContain("二元一次方程");
    expect(content).toContain("只修订 focus 这一条");
    const items = (
      await db.pool.query<{ title: string; replaces_item_id: string | null }>(
        "SELECT title,replaces_item_id FROM knowledge_items WHERE parse_run_id=$1 ORDER BY title",
        [revision],
      )
    ).rows;
    expect(items).toEqual([
      { title: "合并同类项", replaces_item_id: null },
      { title: "移项", replaces_item_id: published },
    ]);
    expect(
      (
        await db.pool.query(
          "SELECT title,summary,status FROM knowledge_items WHERE id=$1",
          [published],
        )
      ).rows[0],
    ).toMatchObject({
      title: "一元一次方程",
      summary: "移项后合并同类项",
      status: "published",
    });
    expect(
      (
        await db.pool.query(
          "SELECT notice FROM knowledge_parse_runs WHERE id=$1",
          [revision],
        )
      ).rows[0].notice,
    ).toBeNull();
  }));

it("links a retitled batch result to the published item named by sourceTitle", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.batch({
      text: "通分时先找公分母，再把分子按倍数放大。",
    });
    const published = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at) VALUES($1,$2,'通分','旧总结','published',now()) RETURNING id",
        [batchId, runId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      "UPDATE knowledge_parse_runs SET status='succeeded',completed_at=now() WHERE id=$1",
      [runId],
    );
    const revision = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status) VALUES($1,'写清步骤','queued') RETURNING id",
        [batchId],
      )
    ).rows[0]!.id;
    const gateway = fakeGateway({
      text: JSON.stringify({
        items: [
          {
            title: "找公分母",
            summary: "先找两个分母的最小公倍数",
            sourceTitle: "通分",
          },
        ],
      }),
    });

    await parseKnowledgeRun(
      db,
      gateway,
      new UploadService(db, f.auth),
      revision,
      signal,
    );

    const draft = (
      await db.pool.query<{ title: string; replaces_item_id: string | null }>(
        "SELECT title,replaces_item_id FROM knowledge_items WHERE parse_run_id=$1",
        [revision],
      )
    ).rows[0];
    expect(draft).toEqual({ title: "找公分母", replaces_item_id: published });
  }));

it("does not invent a replacement when a retitled result omits sourceTitle", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.batch({ text: "通分时先找公分母。" });
    await db.pool.query(
      "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at) VALUES($1,$2,'通分','旧总结','published',now())",
      [batchId, runId],
    );
    await db.pool.query(
      "UPDATE knowledge_parse_runs SET status='succeeded',completed_at=now() WHERE id=$1",
      [runId],
    );
    const revision = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'queued') RETURNING id",
        [batchId],
      )
    ).rows[0]!.id;
    const gateway = fakeGateway(
      itemsResponse([{ title: "找公分母", summary: "先找最小公倍数" }]),
    );

    await parseKnowledgeRun(
      db,
      gateway,
      new UploadService(db, f.auth),
      revision,
      signal,
    );

    expect(
      (
        await db.pool.query(
          "SELECT replaces_item_id FROM knowledge_items WHERE parse_run_id=$1",
          [revision],
        )
      ).rows[0].replaces_item_id,
    ).toBeNull();
  }));
