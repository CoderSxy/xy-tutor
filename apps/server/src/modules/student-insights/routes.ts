import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { Database } from "../../../../../packages/db/src/client.js";
import {
  insightFilterInputSchema,
  insightListQuerySchema,
} from "../../../../../packages/contracts/src/student-insights.js";
import { requireAdmin } from "../auth/policy.js";
import { requireSession } from "../auth/routes.js";
import { resolveInsightRange } from "./metrics.js";
import { requireAdminInsightScope } from "./policy.js";
import { InsightQueryService } from "./queries.js";

export const STUDENT_INSIGHT_PREFIX = "/api/admin/student-insights";

export type StudentInsightDependencies = { database: Database };

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
}
