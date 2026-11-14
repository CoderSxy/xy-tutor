import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { SkillService } from "../../apps/server/src/modules/question-bank/skills.js";

it.each(["diagnosis", "profile"])(
  "normal assessment updates %s and enables next practice",
  async (check) =>
    withTestDb(async (db) => {
      const f = await catalogFixture(db);
      const task = await new TaskService(db, f.auth, f.catalog).create(
        f.scope,
        { kind: "free_question" },
      );
      const messages = new MessageService(db, f.auth);
      const skill = await new SkillService(db).create(f.admin, {
        code: "addition",
        name: "加法",
      });
      const batch = (
        await db.pool.query(
          "INSERT INTO knowledge_batches(actor_id) VALUES($1) RETURNING id",
          [f.admin.userId],
        )
      ).rows[0];
      const run = (
        await db.pool.query(
          "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'succeeded') RETURNING id",
          [batch.id],
        )
      ).rows[0];
      const item = (
        await db.pool.query(
          "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at) VALUES($1,$2,'加法','将两个数相加','published',now()) RETURNING id",
          [batch.id, run.id],
        )
      ).rows[0];
      await new SkillService(db).linkContent(f.admin, skill.id, item.id);
      const versions: string[] = [];
      for (let n = 0; n < 3; n++) {
        const q = (
          await db.pool.query(
            "INSERT INTO questions(student_id,source_type) VALUES($1,'manual') RETURNING id",
            [f.scope.studentId],
          )
        ).rows[0];
        const v = (
          await db.pool.query(
            "INSERT INTO question_versions(question_id,version_no,stem,reference_answer,knowledge_point,verification) VALUES($1,1,$2,'2','加法','verified') RETURNING id",
            [q.id, `1+1=? 题${n}`],
          )
        ).rows[0];
        versions.push(v.id);
        const entry = (
          await db.pool.query(
            "INSERT INTO question_bank_entries(question_version_id,difficulty_band,complexity_band,visibility,source_type,template_family,content_fingerprint,status,published_at,created_by) VALUES($1,'easy',1,'shared','manual','addition',$2,'published',now(),$3) RETURNING id",
            [v.id, `flow-${n}`, f.admin.userId],
          )
        ).rows[0];
        await db.pool.query(
          "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
          [entry.id, skill.id],
        );
        await db.pool.query(
          "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'2','number',false,'verified','{}')",
          [v.id],
        );
      }
      await db.pool.query(
        "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,0,'original')",
        [task.id, versions[0]],
      );
      await db.pool.query(
        "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,1,'original')",
        [task.id, versions[1]],
      );
      const session = await f.auth.login({
        login: "student",
        password: "long-test-password",
      });
      const app = buildApp({
        database: db,
        config: loadConfig({
          NODE_ENV: "test",
          TUTOR_SELF_CHECK_ENABLED: "true",
          LEARNING_TIMING_ENABLED: "true",
          ADAPTIVE_PRACTICE_ENABLED: "true",
        }),
      });
      const headers = {
        origin: "http://localhost:5173",
        cookie: `xy_session=${session.sessionToken}`,
      };
      try {
        for (const [index, answer] of ["3", "2"].entries()) {
          const message = await messages.append(f.scope, {
            conversationId: task.conversationId,
            role: "user",
            content: answer,
          });
          const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
            taskId: task.id,
            questionVersionId: versions[index],
            messageVersionId: message.versionId,
            answer,
            requestKey: `answer-${index}`,
          });
          const result = await app.inject({
            method: "POST",
            url: "/api/assessments",
            headers,
            payload: {
              attemptId: attempt.id,
              correctness: index === 0 ? "incorrect" : "correct",
              reason: "核验",
              referenceIds: [],
            },
          });
          expect({
            status: result.statusCode,
            body: result.json(),
          }).toMatchObject({ status: 200 });
          if (index === 0 && check === "diagnosis") {
            const d = await app.inject({
              method: "GET",
              url: `/api/attempts/${attempt.id}/diagnosis`,
              headers,
            });
            expect(d.json().diagnosis?.attemptId).toBe(attempt.id);
          }
          const profile = (
            await db.pool.query(
              "SELECT version,stale,knowledge_stats FROM learning_profiles WHERE student_id=$1 AND skill_id=$2",
              [f.scope.studentId, skill.id],
            )
          ).rows[0];
          expect(profile).toBeDefined();
          expect(profile.stale).toBe(false);
          if (index === 1) expect(profile.version).toBeGreaterThan(1);
        }
        const profile = (
          await db.pool.query(
            "SELECT version FROM learning_profiles WHERE student_id=$1 AND skill_id=$2",
            [f.scope.studentId, skill.id],
          )
        ).rows[0];
        const next = await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/next-practice`,
          headers,
          payload: {
            requestKey: "next",
            expectedProfileVersion: profile.version,
          },
        });
        expect(next.statusCode).toBe(200);
        expect(next.json().status).toBe("selected");
        expect(next.json().questionVersionId).toBe(versions[2]);
      } finally {
        await app.close();
      }
    }),
);
