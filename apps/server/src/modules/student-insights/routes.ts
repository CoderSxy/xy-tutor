import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { Database } from "../../../../../packages/db/src/client.js";
import { requireAdmin } from "../auth/policy.js";
import { requireSession } from "../auth/routes.js";

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
  _app: FastifyInstance,
  _deps: StudentInsightDependencies,
): void {
  /* 资源端点随各任务加入，并通过 adminInsightRoute() 自动纳入权限参数化测试 */
}
