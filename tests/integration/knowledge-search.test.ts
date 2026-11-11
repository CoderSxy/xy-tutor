import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { searchPublishedKnowledge } from "../../apps/server/src/modules/knowledge-base/search.js";
import type { Database } from "../../packages/db/src/client.js";

const password = "test-password-long";

async function source(db: Database) {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("admin", password);
  const batch = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_batches(actor_id,text_content) VALUES($1,'分数加减法') RETURNING id",
      [admin.userId],
    )
  ).rows[0]!;
  const run = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_parse_runs(batch_id,status,model,completed_at) VALUES($1,'succeeded','fake',now()) RETURNING id",
      [batch.id],
    )
  ).rows[0]!;
  const item = async (input: {
    title: string;
    summary: string;
    status?: string;
    updatedAt?: string;
  }) =>
    (
      await db.pool.query<{ id: string }>(
        `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          batch.id,
          run.id,
          input.title,
          input.summary,
          input.status ?? "published",
          input.status === "published" || input.status === undefined
            ? new Date()
            : null,
          input.updatedAt ? new Date(input.updatedAt) : new Date(),
        ],
      )
    ).rows[0]!.id;
  return { item };
}

it("returns nothing from an empty library", async () =>
  withTestDb(async (db) => {
    expect(
      await searchPublishedKnowledge(db, { keywords: "分数", limit: 5 }),
    ).toEqual([]);
  }));

it("matches keywords in titles and summaries", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    const titleHit = await item({
      title: "异分母分数加法",
      summary: "先通分再相加",
    });
    const summaryHit = await item({
      title: "约分",
      summary: "把分数化成最简形式",
    });
    await item({ title: "三角形内角和", summary: "三个内角相加为180度" });

    const hits = await searchPublishedKnowledge(db, {
      keywords: "分数",
      limit: 5,
    });
    expect(hits.map((hit) => hit.id).sort()).toEqual(
      [titleHit, summaryHit].sort(),
    );
    expect(hits[0]).toMatchObject({ id: titleHit, title: "异分母分数加法" });
  }));

it("hides pending and discarded items", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    const published = await item({
      title: "通分",
      summary: "统一分母",
      status: "published",
    });
    await item({ title: "通分草稿", summary: "还没有确认", status: "pending_review" });
    await item({ title: "通分废弃", summary: "已经丢弃", status: "discarded" });

    const hits = await searchPublishedKnowledge(db, {
      keywords: "通分",
      limit: 5,
    });
    expect(hits.map((hit) => hit.id)).toEqual([published]);
  }));

it("orders title matches before summary matches and newer first", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    const olderTitle = await item({
      title: "分数加减法",
      summary: "旧一点的总结",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const newerTitle = await item({
      title: "分数乘法",
      summary: "新一点的总结",
      updatedAt: "2026-02-01T00:00:00Z",
    });
    const summaryOnly = await item({
      title: "简便运算",
      summary: "先算分数部分",
      updatedAt: "2026-03-01T00:00:00Z",
    });

    const hits = await searchPublishedKnowledge(db, {
      keywords: "分数",
      limit: 5,
    });
    expect(hits.map((hit) => hit.id)).toEqual([
      newerTitle,
      olderTitle,
      summaryOnly,
    ]);
  }));

it("reflects edits to a published summary in later searches", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    const id = await item({ title: "通分", summary: "统一分母" });

    expect(
      await searchPublishedKnowledge(db, { keywords: "最简", limit: 5 }),
    ).toEqual([]);

    await db.pool.query(
      "UPDATE knowledge_items SET summary=$2, updated_at=now() WHERE id=$1",
      [id, "先统一分母，再化为最简分数"],
    );

    const hits = await searchPublishedKnowledge(db, {
      keywords: "最简",
      limit: 5,
    });
    expect(hits.map((hit) => hit.id)).toEqual([id]);
    expect(hits[0]?.summary).toBe("先统一分母，再化为最简分数");
  }));

it("treats percent and underscore as literal characters", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    const percent = await item({
      title: "正确率 100%",
      summary: "全部答对",
    });
    const underscore = await item({
      title: "变量 x_1",
      summary: "下标写法",
    });
    await item({ title: "正确率 100 分", summary: "没有百分号" });
    await item({ title: "变量 xa1", summary: "没有下划线" });

    const percentHits = await searchPublishedKnowledge(db, {
      keywords: "100%",
      limit: 5,
    });
    expect(percentHits.map((hit) => hit.id)).toEqual([percent]);

    const underscoreHits = await searchPublishedKnowledge(db, {
      keywords: "x_1",
      limit: 5,
    });
    expect(underscoreHits.map((hit) => hit.id)).toEqual([underscore]);
  }));

it("honors the result limit", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    for (let index = 0; index < 4; index += 1)
      await item({
        title: `分数知识点 ${index}`,
        summary: "总结",
        updatedAt: `2026-04-0${index + 1}T00:00:00Z`,
      });

    const hits = await searchPublishedKnowledge(db, {
      keywords: "分数",
      limit: 2,
    });
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.title)).toEqual([
      "分数知识点 3",
      "分数知识点 2",
    ]);
  }));

it("matches a question that contains a published title", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    const addition = await item({
      title: "异分母分数加法",
      summary: "先通分再相加",
    });
    await item({ title: "三角形内角和", summary: "三个内角相加为180度" });

    const hits = await searchPublishedKnowledge(db, {
      keywords: "怎么做异分母分数加法",
      limit: 5,
    });
    expect(hits[0]?.id).toBe(addition);
    expect(hits.map((hit) => hit.title)).not.toContain("三角形内角和");
  }));

it("returns only the public fields of each hit", async () =>
  withTestDb(async (db) => {
    const { item } = await source(db);
    await item({ title: "等腰三角形", summary: "两底角相等" });
    const hit = (
      await searchPublishedKnowledge(db, { keywords: "等腰", limit: 5 })
    )[0]!;
    expect(Object.keys(hit).sort()).toEqual(["id", "summary", "title"]);
  }));
