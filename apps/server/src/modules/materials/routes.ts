import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MaterialService } from "./service.js";
import { scopeForRequest } from "../learning/routes.js";
export function registerMaterials(app: FastifyInstance, s: MaterialService) {
  const id = z.object({ id: z.uuid() });
  app.get("/api/materials", async (req) =>
    s.list(await scopeForRequest(s.auth, req)),
  );
  app.post("/api/materials", async (req) =>
    s.create(await scopeForRequest(s.auth, req), req.body),
  );
  app.get("/api/materials/:id", async (req) =>
    s.getExtraction(
      await scopeForRequest(s.auth, req),
      id.parse(req.params).id,
    ),
  );
  app.post("/api/materials/:id/confirm", async (req) =>
    s.confirm(await scopeForRequest(s.auth, req), {
      ...z.record(z.string(), z.unknown()).parse(req.body),
      materialId: id.parse(req.params).id,
    }),
  );
  app.post("/api/tasks/:id/attach-questions", async (req) => {
    await s.attachToTask(
      await scopeForRequest(s.auth, req),
      id.parse(req.params).id,
      z
        .object({ questionVersionIds: z.array(z.uuid()) })
        .strict()
        .parse(req.body).questionVersionIds,
    );
    return { ok: true };
  });
  app.patch("/api/questions/:id", async (req) =>
    s.correctQuestion(await scopeForRequest(s.auth, req), {
      ...z.record(z.string(), z.unknown()).parse(req.body),
      questionId: id.parse(req.params).id,
    }),
  );
  app.get("/api/question-versions/:id/sources", async (req) =>
    s.sources(await scopeForRequest(s.auth, req), id.parse(req.params).id),
  );
  app.post("/api/materials/:id/retry", async (req) => {
    await s.retry(await scopeForRequest(s.auth, req), id.parse(req.params).id);
    return { ok: true };
  });
  app.get("/api/question-versions/:id", async (req) =>
    s.getQuestion(await scopeForRequest(s.auth, req), id.parse(req.params).id),
  );
}
