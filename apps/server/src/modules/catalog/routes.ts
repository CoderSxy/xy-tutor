import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireSession } from "../auth/routes.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";

const studentGone = () =>
  new AppError("GONE", 410, "教材选择已下线，请直接开始学习");
const adminGone = () =>
  new AppError("GONE", 410, "教材管理已下线，请改用知识点接口");

const gone =
  (make: () => AppError) =>
  async (req: FastifyRequest): Promise<never> => {
    requireSession(req);
    throw make();
  };

export function registerCatalog(app: FastifyInstance) {
  app.get("/api/catalog/textbooks", gone(studentGone));
  app.get("/api/catalog/textbooks/:id", gone(studentGone));
  app.get("/api/catalog/textbooks/:id/pages", gone(studentGone));
  app.get("/api/admin/textbooks", gone(adminGone));
  app.post("/api/admin/textbooks", gone(adminGone));
  app.post("/api/admin/textbooks/:id/process", gone(adminGone));
  app.patch("/api/admin/textbooks/:id/pages", gone(adminGone));
  app.post("/api/admin/textbooks/:id/publish", gone(adminGone));
  app.post("/api/admin/textbooks/:id/disable", gone(adminGone));
}
