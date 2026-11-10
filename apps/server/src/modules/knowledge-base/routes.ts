import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../auth/routes.js";
import type { KnowledgeBaseService } from "./service.js";

const pageInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerKnowledgeBase(
  app: FastifyInstance,
  service: KnowledgeBaseService,
) {
  app.post("/api/admin/knowledge/batches", async (req) =>
    service.createBatch(requireSession(req).actor, req.body),
  );
  app.get("/api/admin/knowledge/batches", async (req) =>
    service.listBatches(
      requireSession(req).actor,
      pageInput.parse(req.query),
    ),
  );
  app.get("/api/admin/knowledge/batches/:id", async (req) =>
    service.getBatch(
      requireSession(req).actor,
      z.object({ id: z.uuid() }).parse(req.params).id,
    ),
  );
}
