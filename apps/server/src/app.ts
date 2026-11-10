import { SelectionService } from "./modules/learning/selections.js";
import Fastify from "fastify";
import { SummaryService } from "./modules/learning/summaries.js";
import { KnowledgeService } from "./modules/learning/knowledge.js";
import { ReviewService } from "./modules/learning/review.js";
import { summaryHandler } from "./jobs/summary-job.js";
import { MistakeService } from "./modules/learning/mistakes.js";
import { registerMistakes } from "./modules/learning/mistake-routes.js";
import { PracticeService } from "./modules/learning/practice.js";
import { AssessmentService } from "./modules/learning/assessments.js";
import { z } from "zod";
import { MaterialService } from "./modules/materials/service.js";
import { registerMaterials } from "./modules/materials/routes.js";
import { materialHandler } from "./jobs/material-job.js";
import { BootstrapService } from "./agent/bootstrap.js";
import { TutorExecutor } from "./agent/tutor.js";
import type { ModelGateway } from "./agent/provider.js";
import { modelSupportsImages } from "./agent/capabilities.js";
import { scopeForRequest } from "./modules/learning/routes.js";
import { requireSession } from "./modules/auth/routes.js";
import { RunService } from "./modules/conversations/runs.js";
import { registerRuns } from "./modules/conversations/sse.js";
import { TaskService } from "./modules/learning/tasks.js";
import { AttemptService } from "./modules/learning/attempts.js";
import { MessageService } from "./modules/conversations/messages.js";
import { registerLearning } from "./modules/learning/routes.js";
import { registerConversations } from "./modules/conversations/routes.js";
import { CatalogService } from "./modules/catalog/service.js";
import { registerCatalog } from "./modules/catalog/routes.js";
import { registerStudentVisits, initializeInsightCollection } from "./modules/student-insights/activity.js";
import { registerStudentInsights } from "./modules/student-insights/routes.js";
import { JobQueue } from "./jobs/queue.js";
import { JobRunner } from "./jobs/runner.js";
import { resourcesAvailable } from "./jobs/limits.js";
import { textbookHandler } from "./jobs/textbook-job.js";
import type { OcrProvider } from "./jobs/parsers/ocr.js";
import type { FileStore } from "./infra/oss.js";
import { UploadService } from "./modules/uploads/service.js";
import { registerUploads } from "./modules/uploads/routes.js";
import { ZodError } from "zod";
import type { Database } from "../../../packages/db/src/client.js";
import type { AppConfig } from "./config.js";
import { AuthService } from "./modules/auth/service.js";
import { registerAuth } from "./modules/auth/routes.js";
import { AppError } from "../../../packages/contracts/src/api.js";
export type AppDependencies = {
  readiness?: () => Promise<void>;
  database?: Database;
  config?: AppConfig;
  fileStore?: FileStore;
  ocr?: OcrProvider;
  enableJobs?: boolean;
  canStartJobs?: () => Promise<boolean>;
  gateway?: ModelGateway;
};
export function buildApp(deps: AppDependencies) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(422)
        .send({ error: { code: "VALIDATION", message: "请求格式不正确" } });
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 429
    )
      return reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" },
      });
    if (error instanceof Error && "code" in error && error.code === "23505")
      return reply
        .code(409)
        .send({ error: { code: "CONFLICT", message: "记录已存在" } });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 400
    )
      return reply
        .code(422)
        .send({ error: { code: "VALIDATION", message: "请求格式不正确" } });
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "服务暂时不可用" } });
  });
  app.get("/api/health/live", async () => ({ status: "ok" }));
  app.get("/api/health/ready", async (_request, reply) => {
    if (!deps.readiness) return reply.code(503).send({ status: "unavailable" });
    try {
      await deps.readiness();
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  if (deps.database && deps.config) {
    const auth = new AuthService(deps.database);
    app.register(async (scoped) => {
      // 采集切换点必须在注册服务前落库，保证所有实例一致。
      await initializeInsightCollection(deps.database!);
      await registerAuth(scoped, auth, deps.config!);
      registerStudentVisits(scoped, { database: deps.database! });
      const uploads: UploadService = new UploadService(
        deps.database!,
        auth,
        deps.fileStore,
        async (actor, id): Promise<boolean> => catalog.canReadFile(actor, id),
      );
      const catalog: CatalogService = new CatalogService(
        deps.database!,
        auth,
        uploads,
      );
      registerUploads(scoped, uploads);
      registerCatalog(scoped, catalog);
      registerStudentInsights(scoped, {
        database: deps.database!,
        fileStore: deps.fileStore,
      });
      const selections = new SelectionService(deps.database!, auth);
      scoped.get("/api/learning/selections", async (req) =>
        selections.list(await scopeForRequest(auth, req)),
      );
      scoped.post("/api/learning/selections", async (req) =>
        selections.record(await scopeForRequest(auth, req), req.body),
      );
      const materials = new MaterialService(
        deps.database!,
        auth,
        uploads,
        catalog,
      );
      registerMaterials(scoped, materials);
      registerLearning(scoped, {
        auth,
        tasks: new TaskService(deps.database!, auth, catalog),
        attempts: new AttemptService(deps.database!, auth),
      });
      registerConversations(scoped, new MessageService(deps.database!, auth));
      const tasks = new TaskService(deps.database!, auth, catalog);
      const practice = new PracticeService(deps.database!, tasks, deps.gateway);
      const assessment = new AssessmentService(
        deps.database!,
        auth,
        catalog,
        deps.gateway,
        deps.fileStore,
      );
      const summaries = new SummaryService(deps.database!, auth, deps.gateway);
      const knowledge = new KnowledgeService(deps.database!, auth);
      const mistakes = new MistakeService(deps.database!, auth);
      scoped.get("/api/tasks/:id/summary", async (req) =>
        summaries.latest(
          await scopeForRequest(auth, req),
          z.object({ id: z.uuid() }).parse(req.params).id,
        ),
      );
      scoped.get("/api/knowledge", async (req) =>
        knowledge.get(
          await scopeForRequest(auth, req),
          z.object({ revisionId: z.uuid() }).passthrough().parse(req.query)
            .revisionId,
        ),
      );
      scoped.get("/api/review/due", async (req) =>
        new ReviewService(mistakes).listDue(
          await scopeForRequest(auth, req),
          new Date(),
        ),
      );
      registerMistakes(scoped, mistakes);
      const assess = async (
        scope: Parameters<AssessmentService["submitCandidate"]>[0],
        input: unknown,
      ) => {
        const result = await assessment.submitCandidate(scope, input);
        await mistakes.applyAssessment(scope, result.id);
        return result;
      };
      scoped.post("/api/assessments", async (req) =>
        assess(await scopeForRequest(auth, req), req.body),
      );
      scoped.get("/api/attempts/:id/assessments", async (req) =>
        assessment.listForAttempt(
          await scopeForRequest(auth, req),
          z.object({ id: z.uuid() }).parse(req.params).id,
        ),
      );
      const runs = new RunService(deps.database!, auth, deps.fileStore);
      registerRuns(scoped, runs, () => !!deps.gateway);
      const bootstrap = new BootstrapService(
        deps.database!,
        auth,
        catalog,
        runs,
        !!deps.gateway,
      );
      scoped.post("/api/learning/bootstrap", async (req) =>
        bootstrap.open(await scopeForRequest(auth, req), req.body),
      );
      scoped.get("/api/capabilities", async (req) => {
        requireSession(req);
        return {
          llmConfigured: !!deps.gateway,
          uploadsConfigured: !!deps.fileStore,
          ocrConfigured: !!deps.ocr,
          images: modelSupportsImages(deps.gateway)
            ? "enabled-unverified"
            : "disabled",
        };
      });
      if (deps.enableJobs) {
        scoped.addHook("onReady", async () =>
          runs.start(
            new TutorExecutor(
              deps.database!,
              auth,
              catalog,
              runs,
              deps.gateway,
              {
                practice: (scope, id, input) =>
                  practice.propose(scope, id, input),
                assess: (scope, id, input) =>
                  assess(scope, {
                    ...z.record(z.string(), z.unknown()).parse(input),
                    taskId: id,
                  }),
                mistakes: (scope, input) =>
                  mistakes.list(scope, {
                    ...z
                      .object({ questionId: z.uuid().optional() })
                      .parse(input),
                    includeArchived: true,
                  }),
              },
              deps.fileStore,
            ),
          ),
        );
        scoped.addHook("onClose", async () => runs.stop());
      }
      if (deps.enableJobs) {
        const runner = new JobRunner(
          new JobQueue(deps.database!),
          {
            "textbook.parse": textbookHandler(catalog, deps.ocr),
            "material.parse": materialHandler(
              materials,
              deps.ocr,
              deps.gateway,
            ),
            "learning.summary": summaryHandler(summaries),
          },
          deps.canStartJobs ?? resourcesAvailable,
        );
        scoped.addHook("onReady", async () => runner.start());
        scoped.addHook("onClose", async () => runner.stop());
      }
    });
  }
  return app;
}
