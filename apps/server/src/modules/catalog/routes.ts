import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../auth/routes.js";
import type { CatalogService } from "./service.js";
export function registerCatalog(app: FastifyInstance, s: CatalogService) {
  const id = z.object({ id: z.uuid() });
  app.get("/api/catalog/textbooks", async (req) => {
    requireSession(req);
    return s.listPublished(
      z
        .object({
          edition: z.string().optional(),
          grade: z.string().optional(),
          subject: z.string().optional(),
        })
        .parse(req.query),
    );
  });
  app.get("/api/catalog/textbooks/:id", async (req) =>
    s.getRevision(requireSession(req).actor, id.parse(req.params).id),
  );
  app.get("/api/catalog/textbooks/:id/pages", async (req) =>
    s.getPages(requireSession(req).actor, id.parse(req.params).id),
  );
  app.get("/api/admin/textbooks", async (req) =>
    s.listAdmin(requireSession(req).actor),
  );
  app.post("/api/admin/textbooks", async (req) =>
    s.createDraft(requireSession(req).actor, req.body),
  );
  app.post("/api/admin/textbooks/:id/process", async (req) => {
    await s.startProcessing(requireSession(req).actor, id.parse(req.params).id);
    return { ok: true };
  });
  app.patch("/api/admin/textbooks/:id/pages", async (req) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    await s.reviewPage(requireSession(req).actor, {
      ...body,
      revisionId: id.parse(req.params).id,
    });
    return { ok: true };
  });
  for (const action of ["publish", "disable"] as const)
    app.post(`/api/admin/textbooks/:id/${action}`, async (req) => {
      await s[action](requireSession(req).actor, id.parse(req.params).id);
      return { ok: true };
    });
}
