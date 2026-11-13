import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { episodeEventsInputSchema } from "../../../../../packages/contracts/src/tutoring.js";
import type { AuthService } from "../auth/service.js";
import { scopeForRequest } from "../learning/routes.js";
import type { TimingService } from "./timing-service.js";

export function registerTutoring(
  app: FastifyInstance,
  deps: { auth: AuthService; timing: TimingService },
) {
  const id = z.object({ id: z.uuid() });
  app.post("/api/tutoring/episodes", async (req) =>
    deps.timing.start(await scopeForRequest(deps.auth, req), req.body),
  );
  app.post("/api/tutoring/episodes/:id/events", async (req) => {
    const input = episodeEventsInputSchema.parse(req.body);
    return deps.timing.append(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      input.events,
    );
  });
  app.get("/api/tutoring/episodes/:id", async (req) =>
    deps.timing.get(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
}
