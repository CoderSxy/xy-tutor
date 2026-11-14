import type {
  FastifyInstance,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import { z } from "zod";
import type { Database } from "../../../../../packages/db/src/client.js";
import {
  insightFilterInputSchema,
  insightListQuerySchema,
  materialListQuerySchema,
  mistakeListQuerySchema,
  pageQuerySchema,
  taskListQuerySchema,
} from "../../../../../packages/contracts/src/student-insights.js";
import type { FileStore } from "../../infra/oss.js";
import { requireAdmin } from "../auth/policy.js";
import { requireSession } from "../auth/routes.js";
import { InsightActivityService } from "./activity.js";
import { InsightFileService } from "./files.js";
import { resolveInsightRange } from "./metrics.js";
import { requireAdminInsightScope } from "./policy.js";
import { InsightQueryService } from "./queries.js";
import { DiagnosisReviewService } from "./diagnosis-reviews.js";
import {
  diagnosisReviewInputSchema,
  evaluationWindowSchema,
} from "../../../../../packages/contracts/src/learning-evaluation.js";
import { LearningEvaluationService } from "./learning-evaluations.js";
import { InsightRecordService } from "./records.js";
import { InsightReportService } from "./reports.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";

export const STUDENT_INSIGHT_PREFIX = "/api/admin/student-insights";

export type StudentInsightDependencies = {
  database: Database;
  fileStore?: FileStore;
  gatewayConfigured?: boolean;
  groupReferenceEnabled?: boolean;
  learningEvaluationEnabled?: boolean;
};

export type InsightRouteEntry = {
  method: "GET" | "POST";
  path: string;
};

const registered = new Map<string, InsightRouteEntry>();

export function insightRouteManifest(): InsightRouteEntry[] {
  return [...registered.values()];
}

export function adminInsightRoute(
  app: FastifyInstance,
  method: InsightRouteEntry["method"],
  path: string,
  handler: RouteHandlerMethod,
): void {
  if (method === "GET") app.get(path, handler);
  else app.post(path, handler);
  registered.set(`${method} ${path}`, { method, path });
}

export function registerStudentInsights(
  app: FastifyInstance,
  deps: StudentInsightDependencies,
): void {
  app.register(
    async (scoped) => {
      scoped.addHook("onRequest", async (request) => {
        requireAdmin(requireSession(request).actor);
      });
      registerRoutes(scoped, deps);
    },
    { prefix: STUDENT_INSIGHT_PREFIX },
  );
}

function registerRoutes(
  app: FastifyInstance,
  deps: StudentInsightDependencies,
): void {
  const service = new InsightQueryService(deps.database);
  const records = new InsightRecordService(deps.database);
  const files = new InsightFileService(deps.database, deps.fileStore);
  const activity = new InsightActivityService(deps.database);
  const reports = new InsightReportService(
    deps.database,
    deps.gatewayConfigured ?? false,
  );
  const reviews = new DiagnosisReviewService(deps.database);
  const evaluations = new LearningEvaluationService(deps.database, {
    groupReferenceEnabled: deps.groupReferenceEnabled ?? false,
  });

  adminInsightRoute(app, "GET", "/students", async (request) => {
    const actor = requireSession(request).actor;
    const input = insightListQuerySchema.parse(request.query);
    return service.list(actor, input);
  });

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/overview",
    async (request) => {
      const actor = requireSession(request).actor;
      const { studentId } = request.params as { studentId: string };
      const input = insightFilterInputSchema.parse(request.query);
      const range = resolveInsightRange(input);
      const scope = await requireAdminInsightScope(
        deps.database,
        actor,
        studentId,
      );
      return service.overview(scope, {
        from: range.from,
        to: range.to,
        revisionId: input.revisionId,
      });
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/activity",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return activity.get(
        scope,
        insightFilterInputSchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/tasks",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return records.listTasks(scope, taskListQuerySchema.parse(request.query));
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/tasks/:taskId",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const taskId = idOf(request, "taskId");
      return records.getTask(
        scope,
        taskId,
        pageQuerySchema.parse(request.query),
        request.id,
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/tasks/:taskId/attempts",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const taskId = idOf(request, "taskId");
      return records.listAttempts(
        scope,
        taskId,
        pageQuerySchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/conversations/:conversationId/messages",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const conversationId = idOf(request, "conversationId");
      return records.listMessages(
        scope,
        conversationId,
        pageQuerySchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/mistakes",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return records.listMistakes(
        scope,
        mistakeListQuerySchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/mistakes/:mistakeId",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const mistakeId = idOf(request, "mistakeId");
      return records.getMistake(scope, mistakeId, request.id);
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/mistakes/:mistakeId/events",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const mistakeId = idOf(request, "mistakeId");
      return records.listMistakeEvents(
        scope,
        mistakeId,
        pageQuerySchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/materials",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return records.listMaterials(
        scope,
        materialListQuerySchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/materials/:materialId",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const materialId = idOf(request, "materialId");
      return records.getMaterial(scope, materialId, request.id);
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/materials/:materialId/questions",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const materialId = idOf(request, "materialId");
      return records.listMaterialQuestions(
        scope,
        materialId,
        pageQuerySchema.parse(request.query),
      );
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/files/:fileId/download",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const fileId = idOf(request, "fileId");
      return files.download(scope, fileId, request.id);
    },
  );

  adminInsightRoute(
    app,
    "POST",
    "/students/:studentId/reports",
    async (request, reply) => {
      const scope = await scopeOf(request, deps.database);
      const input = insightFilterInputSchema.parse(request.body ?? {});
      const range = resolveInsightRange(input);
      const result = await reports.create(scope, {
        from: range.from,
        to: range.to,
        revisionId: input.revisionId,
      });
      return reply.code(result.reused ? 200 : 202).send(result);
    },
  );

  adminInsightRoute(
    app,
    "POST",
    "/students/:studentId/diagnosis-reviews",
    async (request, reply) => {
      const actor = requireSession(request).actor;
      const { studentId } = request.params as { studentId: string };
      const input = diagnosisReviewInputSchema.parse(request.body);
      const result = await reviews.submit(actor, { ...input, studentId });
      return reply.code(201).send(result);
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/evaluation",
    async (request) => {
      if (deps.learningEvaluationEnabled !== true)
        throw new AppError("NOT_FOUND", 404, "学习评测未启用");
      const actor = requireSession(request).actor;
      const { studentId } = request.params as { studentId: string };
      const input = evaluationWindowSchema.parse(request.query);
      return evaluations.snapshot(actor, studentId, input);
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/reports",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return reports.list(scope, pageQuerySchema.parse(request.query));
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/reports/:reportId",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return reports.get(scope, idOf(request, "reportId"));
    },
  );

  adminInsightRoute(
    app,
    "POST",
    "/students/:studentId/reports/:reportId/retry",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      return reports.retry(scope, idOf(request, "reportId"));
    },
  );

  adminInsightRoute(
    app,
    "GET",
    "/students/:studentId/reports/:reportId/evidence/:evidenceKey",
    async (request) => {
      const scope = await scopeOf(request, deps.database);
      const reportId = idOf(request, "reportId");
      const { evidenceKey } = request.params as { evidenceKey: string };
      return reports.resolveEvidence(scope, reportId, evidenceKey);
    },
  );
}

async function scopeOf(request: FastifyRequest, database: Database) {
  const actor = requireSession(request).actor;
  const { studentId } = request.params as { studentId: string };
  return requireAdminInsightScope(database, actor, studentId);
}

function idOf(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, string>;
  return z.uuid().parse(params[name]);
}
