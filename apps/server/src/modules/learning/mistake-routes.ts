import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  mistakeListQuerySchema,
  type MistakeListQuery,
} from "../../../../../packages/contracts/src/mistakes.js";
import type { MistakeService } from "./mistakes.js";
import { CorrectionService } from "./corrections.js";
import { scopeForRequest } from "./routes.js";
export function registerMistakes(app: FastifyInstance, s: MistakeService) {
  const id = z.object({ id: z.uuid() });
  app.get("/api/mistakes", async (req) => {
    const query = mistakeListQuerySchema.parse(req.query) as MistakeListQuery;
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const scope = await scopeForRequest(s.auth, req);
    const filter = {
      includeArchived: query.includeArchived,
      questionId: query.questionId,
      origin: query.origin,
      status: query.status,
    };
    if ("page" in raw || "pageSize" in raw)
      return s.listPage(scope, {
        ...filter,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      });
    return s.list(scope, filter);
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
