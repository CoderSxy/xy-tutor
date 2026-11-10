import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MistakeService } from "./mistakes.js";
import { CorrectionService } from "./corrections.js";
import { scopeForRequest } from "./routes.js";
export function registerMistakes(app: FastifyInstance, s: MistakeService) {
  const id = z.object({ id: z.uuid() });
  app.get("/api/mistakes", async (req) => {
    const filter = z
      .object({
        includeArchived: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v === "true"),
        questionId: z.uuid().optional(),
      })
      .passthrough()
      .parse(req.query);
    return s.list(await scopeForRequest(s.auth, req), filter);
  });
  app.post("/api/mistakes", async (req) =>
    s.add(await scopeForRequest(s.auth, req), req.body),
  );
  app.get("/api/mistakes/:id", async (req) =>
    s.get(await scopeForRequest(s.auth, req), id.parse(req.params).id),
  );
  app.get("/api/mistakes/:id/history", async (req) =>
    s.history(await scopeForRequest(s.auth, req), id.parse(req.params).id),
  );
  app.post("/api/mistakes/:id/start", async (req) =>
    s.start(await scopeForRequest(s.auth, req), id.parse(req.params).id),
  );
  app.post("/api/evidence/invalidate", async (req) => {
    await new CorrectionService(s).invalidate(
      await scopeForRequest(s.auth, req),
      z
        .object({ evidenceId: z.uuid(), reason: z.string() })
        .strict()
        .parse(req.body),
    );
    return { ok: true };
  });
}
