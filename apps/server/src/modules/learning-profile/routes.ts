import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { profileQuerySchema } from "../../../../../packages/contracts/src/learning-profile.js";
import { scopeForRequest } from "../learning/routes.js";
import type { AuthService } from "../auth/service.js";
import type { LearningProfileService } from "./service.js";
import type { SelectionService } from "./selection-service.js";

export function registerLearningProfiles(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    profiles: LearningProfileService;
    selection?: SelectionService;
  },
) {
  app.get("/api/learning-profile", async (req) => {
    const scope = await scopeForRequest(deps.auth, req);
    const query = profileQuerySchema.parse(req.query);
    if (!query.skillId) return deps.profiles.list(scope);
    return deps.profiles.get(scope, query.skillId);
  });
  if (!deps.selection) return;
  const selection = deps.selection;
  app.post("/api/tasks/:id/next-practice", async (req) => {
    const scope = await scopeForRequest(deps.auth, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return selection.next(scope, id, req.body);
  });
  app.get("/api/tasks/:id/next-practice", async (req) => {
    const scope = await scopeForRequest(deps.auth, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return { decision: await selection.latest(scope, id) };
  });
  app.get("/api/practice-decisions/:id", async (req) => {
    const scope = await scopeForRequest(deps.auth, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return selection.replay(scope, id);
  });
}
