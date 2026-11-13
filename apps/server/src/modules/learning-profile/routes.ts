import type { FastifyInstance } from "fastify";
import { profileQuerySchema } from "../../../../../packages/contracts/src/learning-profile.js";
import { scopeForRequest } from "../learning/routes.js";
import type { AuthService } from "../auth/service.js";
import type { LearningProfileService } from "./service.js";

export function registerLearningProfiles(
  app: FastifyInstance,
  deps: { auth: AuthService; profiles: LearningProfileService },
) {
  app.get("/api/learning-profile", async (req) => {
    const scope = await scopeForRequest(deps.auth, req);
    const query = profileQuerySchema.parse(req.query);
    if (!query.skillId) return deps.profiles.list(scope);
    return deps.profiles.get(scope, query.skillId);
  });
}
