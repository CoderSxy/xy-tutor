import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import { requireSession } from "../auth/routes.js";
import type { AuthService } from "../auth/service.js";
import type { TaskService } from "./tasks.js";
import type { AttemptService } from "./attempts.js";
export async function scopeForRequest(auth: AuthService, req: FastifyRequest) {
  const session = requireSession(req);
  const query = z
    .object({ studentId: z.uuid().optional() })
    .passthrough()
    .parse(req.query);
  const studentId = query.studentId ?? session.studentId;
  if (!studentId) throw new AppError("VALIDATION", 422, "请选择学生");
  return auth.requireStudentAccess(session.actor, studentId);
}
export function registerLearning(
  app: FastifyInstance,
  deps: { auth: AuthService; tasks: TaskService; attempts: AttemptService },
) {
  const id = z.object({ id: z.uuid() });
  app.get("/api/tasks", async (req) => {
    const query = z
      .object({
        revisionId: z.uuid().optional(),
        q: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .passthrough()
      .parse(req.query);
    return deps.tasks.list(await scopeForRequest(deps.auth, req), {
      revisionId: query.revisionId,
      q: query.q || undefined,
      limit: query.limit,
      offset: query.offset,
    });
  });
  app.post("/api/tasks", async (req) =>
    deps.tasks.create(await scopeForRequest(deps.auth, req), req.body),
  );
  app.get("/api/tasks/:id", async (req) =>
    deps.tasks.resume(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
  app.get("/api/tasks/:id/items", async (req) =>
    deps.tasks.items(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
  app.patch("/api/tasks/:id", async (req) =>
    deps.tasks.transition(await scopeForRequest(deps.auth, req), {
      ...z.record(z.string(), z.unknown()).parse(req.body),
      taskId: id.parse(req.params).id,
    }),
  );
  app.patch("/api/tasks/:id/title", async (req) =>
    deps.tasks.rename(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      req.body,
    ),
  );
  app.delete("/api/tasks/:id", async (req) => {
    await deps.tasks.remove(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    );
    return { ok: true };
  });
  app.post("/api/tasks/:id/skip", async (req) => {
    await deps.tasks.skip(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      z.object({ itemId: z.uuid() }).strict().parse(req.body).itemId,
    );
    return { ok: true };
  });
  app.post("/api/attempts", async (req) =>
    deps.attempts.submit(await scopeForRequest(deps.auth, req), req.body),
  );
  app.get("/api/attempts/:id", async (req) =>
    deps.attempts.get(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
}
