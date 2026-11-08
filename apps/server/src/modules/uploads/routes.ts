import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../auth/routes.js";
import type { UploadService } from "./service.js";
export function registerUploads(app: FastifyInstance, s: UploadService) {
  app.post("/api/uploads", async (req) =>
    s.create(requireSession(req).actor, req.body),
  );
  app.post("/api/uploads/:id/complete", async (req) => {
    await s.complete(
      requireSession(req).actor,
      z.object({ id: z.uuid() }).parse(req.params).id,
    );
    return { ok: true };
  });
  app.get("/api/files/:id/download", async (req) =>
    s.getDownload(
      requireSession(req).actor,
      z.object({ id: z.uuid() }).parse(req.params).id,
    ),
  );
}
