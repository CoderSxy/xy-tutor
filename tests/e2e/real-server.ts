import { withTestDb } from "../helpers/database.js";
import { MemoryFileStore } from "../helpers/files.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
const origin = "http://localhost:5175";
class TestStore extends MemoryFileStore {
  override async signUpload(input: { key: string; contentType: string }) {
    return {
      url: `${origin}/api/test-storage/${encodeURIComponent(input.key)}`,
      headers: { "Content-Type": input.contentType },
    };
  }
  override async signDownload(key: string, _ttl: number) {
    return `${origin}/api/test-storage/${encodeURIComponent(key)}`;
  }
}
function text(message: Message | undefined): string {
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((item) => ("text" in item ? item.text : "")).join("");
}
await withTestDb(async (db) => {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("e2e-admin", "e2e-only-password");
  const inv = await auth.invite(admin, { login: "e2e-student" });
  const student = await auth.activate({
    token: inv.activationToken,
    password: "e2e-only-password",
  });
  await auth.updateProfile(
    await auth.requireStudentAccess(
      { userId: student.userId, role: "student" },
      student.studentId!,
    ),
    { displayName: "端到端测试同学", preferences: { currentChapter: "加法" } },
  );
  const store = new TestStore();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const nextProblem = async () => {
    const task = (
      await db.pool.query(
        "SELECT id FROM learning_tasks WHERE student_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1",
        [student.studentId],
      )
    ).rows[0];
    const count = task
      ? Number(
          (
            await db.pool.query(
              "SELECT count(*)::int AS n FROM task_items WHERE task_id=$1",
              [task.id],
            )
          ).rows[0].n,
        )
      : 0;
    const n = count + 1;
    return fauxAssistantMessage(
      fauxToolCall("propose_practice", {
        stem: `只填最终数值：${n}+${n}=?`,
        referenceAnswer: String(n * 2),
        knowledgePoint: "加法",
        role: "original",
        answerType: "number",
        requiresWorking: false,
      }),
      { stopReason: "toolUse" },
    );
  };
  const factory: FauxResponseFactory = async (context) => {
    faux.appendResponses([factory]);
    const system = context.messages
      .filter((m) => m.role === "system")
      .map(text)
      .join("\n");
    const last = context.messages.at(-1);
    if (system.includes("根据结构化事实生成简短"))
      return fauxAssistantMessage(
        JSON.stringify({
          text: "本次作答与核验依据已保存，可以继续巩固或回顾错题。",
        }),
      );
    if (system.includes("将资料页拆"))
      return fauxAssistantMessage(JSON.stringify({ questions: [] }));
    if (system.includes("独立解题") || system.includes("独立为已确认")) {
      const input = text(last);
      const match = input.match(/(\d+)\s*\+\s*(\d+)/);
      return fauxAssistantMessage(
        JSON.stringify({
          referenceAnswer: String(
            Number(match?.[1] ?? 1) + Number(match?.[2] ?? 1),
          ),
          answerType: "number",
          requiresWorking: false,
          reason: "合成测试参考答案",
        }),
      );
    }
    if (last?.role === "toolResult") {
      if (last.toolName === "submit_assessment") {
        const latest = (
          await db.pool.query(
            "SELECT s.correctness,a.task_id FROM assessments s JOIN attempts a ON a.id=s.attempt_id WHERE a.student_id=$1 ORDER BY s.created_at DESC LIMIT 1",
            [student.studentId],
          )
        ).rows[0];
        if (latest?.correctness === "correct") {
          const count = Number(
            (
              await db.pool.query(
                "SELECT count(*)::int AS n FROM task_items WHERE task_id=$1",
                [latest.task_id],
              )
            ).rows[0].n,
          );
          if (count < 5) return nextProblem();
          return fauxAssistantMessage(
            "本次五道练习已完成。作答已核验并保存，可以结束本次学习。",
          );
        }
        return fauxAssistantMessage(
          "这次还需要再想一想。先把两个数相加，再独立尝试一次。",
        );
      }
      if (last.toolName === "propose_practice")
        return fauxAssistantMessage(
          "题目已经核验，请独立作答；需要帮助时可以请求提示。",
        );
      return fauxAssistantMessage("学习资料已读取。");
    }
    const input = text(last);
    if (/^\d+$/.test(input)) {
      const attempt = (
        await db.pool.query(
          "SELECT id,answer FROM attempts WHERE student_id=$1 ORDER BY created_at DESC LIMIT 1",
          [student.studentId],
        )
      ).rows[0];
      if (attempt)
        return fauxAssistantMessage(
          fauxToolCall("submit_assessment", {
            attemptId: attempt.id,
            correctness: input === "3" ? "incorrect" : "correct",
            reason: "请核验本次最终数值",
            referenceIds: [],
          }),
          { stopReason: "toolUse" },
        );
    }
    if (input.includes("开启学习引导"))
      return fauxAssistantMessage(
        "今天继续学习加法。可以从每日5练、知识点巩固或错题回顾开始。",
      );
    return nextProblem();
  };
  faux.setResponses([factory]);
  const config = loadConfig({ NODE_ENV: "test", APP_ORIGIN: origin });
  const app = buildApp({
    database: db,
    config,
    fileStore: store,
    gateway: new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    ),
    enableJobs: true,
    canStartJobs: async () => true,
    readiness: async () => {
      await db.pool.query("SELECT 1");
    },
  });
  app.addContentTypeParser(
    ["application/pdf", "image/jpeg", "image/png", "image/webp"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.put("/api/test-storage/*", async (req, reply) => {
    const key = (req.params as { "*": string })["*"];
    const bytes = req.body as Buffer;
    store.put(key, {
      size: bytes.length,
      contentType: String(req.headers["content-type"]),
      prefix: bytes,
    });
    return reply.code(200).send();
  });
  app.get("/api/test-storage/*", async (req, reply) => {
    const key = (req.params as { "*": string })["*"];
    const object = await store.head(key);
    return reply.type(object.contentType).send(object.prefix);
  });
  await app.listen({ host: "127.0.0.1", port: 3002 });
  console.log(
    "Isolated E2E backend ready; external model/storage are test adapters.",
  );
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => resolve());
  });
  await app.close();
});
