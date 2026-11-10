import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../auth/routes.js";
import {
  itemIdsInput,
  listItemsQuery,
  reparsePromptInput,
  type KnowledgeBaseService,
} from "./service.js";

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
  app.get("/api/admin/knowledge/items", async (req) =>
    service.listItems(
      requireSession(req).actor,
      listItemsQuery.parse(req.query),
    ),
  );
  app.patch("/api/admin/knowledge/items/:id", async (req) =>
    service.updateItem(
      requireSession(req).actor,
      z.object({ id: z.uuid() }).parse(req.params).id,
      req.body,
    ),
  );
  app.post("/api/admin/knowledge/items/discard", async (req) =>
    service.discardItems(
      requireSession(req).actor,
      itemIdsInput.parse(req.body).ids,
    ),
  );
  app.post("/api/admin/knowledge/items/publish", async (req) =>
    service.publishItems(
      requireSession(req).actor,
      itemIdsInput.parse(req.body).ids,
    ),
  );
  app.post("/api/admin/knowledge/batches/:id/reparse", async (req) =>
    service.reparseBatch(
      requireSession(req).actor,
      z.object({ id: z.uuid() }).parse(req.params).id,
      reparsePromptInput.parse(req.body),
    ),
  );
  app.post("/api/admin/knowledge/items/:id/reparse", async (req) =>
    service.reparsePublished(
      requireSession(req).actor,
      z.object({ id: z.uuid() }).parse(req.params).id,
      reparsePromptInput.parse(req.body),
    ),
  );
}
