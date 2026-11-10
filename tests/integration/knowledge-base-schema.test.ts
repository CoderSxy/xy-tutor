import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";

const password = "test-password-long";

it("stores knowledge batches, parse runs and confirmed items", async () =>
  withTestDb(async (db) => {
    const auth = new AuthService(db);
    const admin = await auth.createAdmin("admin", password);

    const batch = (
      await db.pool.query(
        "INSERT INTO knowledge_batches(actor_id,text_content) VALUES($1,$2) RETURNING id",
        [admin.userId, "函数与方程"],
      )
    ).rows[0];
    const run = (
      await db.pool.query(
        "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'queued') RETURNING id",
        [batch.id],
      )
    ).rows[0];

    await expect(
      db.pool.query(
        "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'bogus')",
        [batch.id],
      ),
    ).rejects.toThrow();

    const item = await db.pool.query(
      `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status)
       VALUES($1,$2,'一元一次方程','移项与合并同类项','pending_review') RETURNING id`,
      [batch.id, run.id],
    );
    expect(item.rowCount).toBe(1);

    await expect(
      db.pool.query(
        `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status)
         VALUES($1,$2,'非法状态','内容','bogus')`,
        [batch.id, run.id],
      ),
    ).rejects.toThrow();

    await expect(
      db.pool.query(
        `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,replaces_item_id)
         VALUES($1,$2,'悬空引用','内容','pending_review',gen_random_uuid())`,
        [batch.id, run.id],
      ),
    ).rejects.toThrow();

    const file = (
      await db.pool.query(
        "INSERT INTO files(owner_id,purpose,name,content_type,size,object_key) VALUES($1,'knowledge_source','讲义.txt','text/plain',4,'k1') RETURNING id",
        [admin.userId],
      )
    ).rows[0];
    await db.pool.query(
      "INSERT INTO knowledge_batch_files(batch_id,file_id,position) VALUES($1,$2,0)",
      [batch.id, file.id],
    );
    await expect(
      db.pool.query(
        "INSERT INTO knowledge_batch_files(batch_id,file_id,position) VALUES($1,$2,1)",
        [batch.id, file.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        "INSERT INTO knowledge_batch_files(batch_id,file_id,position) VALUES($1,gen_random_uuid(),0)",
        [batch.id],
      ),
    ).rejects.toThrow();
  }));
