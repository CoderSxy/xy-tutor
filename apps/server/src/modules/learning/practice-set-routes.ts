import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { scopeForRequest } from "./routes.js";
import type { PracticeSetService } from "./practice-sets.js";
import type { PracticeDraftService } from "./practice-drafts.js";
import type { AnswerSubmissionService } from "./answer-submission.js";
import type { PracticePreferencesService } from "./practice-preferences.js";
import { retryGenerationInputSchema } from "../../../../../packages/contracts/src/practice-sets.js";
import { listExamProfiles } from "../question-bank/exam-profiles.js";

export function registerPracticeSets(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    sets: PracticeSetService;
    drafts: PracticeDraftService;
    submissions: AnswerSubmissionService;
    preferences: PracticePreferencesService;
  },
) {
  const id = z.object({ id: z.uuid() });
  const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

  app.post("/api/tasks/:id/practice-set", async (req, reply) => {
    const dto = await deps.sets.create(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      req.body,
    );
    return reply.code(dto.generation === "preparing" ? 202 : 200).send(dto);
  });
  app.get("/api/tasks/:id/practice-set", async (req, reply) => {
    const dto = await deps.sets.getByTask(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    );
    if (!dto)
      return reply
        .code(404)
        .send({ error: { code: "NOT_FOUND", message: "题组不存在" } });
    return dto;
  });
  app.patch("/api/practice-sets/:id", async (req) =>
    deps.sets.changeMode(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      req.body,
    ),
  );
  app.post("/api/practice-sets/:id/retry-generation", async (req) =>
    deps.sets.retryGeneration(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      retryGenerationInputSchema.parse(req.body),
    ),
  );
  app.put("/api/practice-sets/:id/drafts/:itemId", async (req) =>
    deps.drafts.put(
      await scopeForRequest(deps.auth, req),
      itemParams.parse(req.params).id,
      itemParams.parse(req.params).itemId,
      req.body,
    ),
  );
  app.get("/api/practice-sets/:id/drafts", async (req) =>
    deps.drafts.list(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
  app.post("/api/practice-sets/:id/submit", async (req, reply) => {
    const dto = await deps.submissions.submit(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      req.body,
    );
    return reply.code(202).send(dto);
  });
  app.post("/api/practice-submissions/:id/retry", async (req) =>
    deps.submissions.retry(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      req.body,
    ),
  );
  app.get("/api/practice-submissions/:id", async (req) =>
    deps.submissions.get(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
  app.get("/api/practice-sets/:id/results", async (req) =>
    deps.sets.results(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
  app.post("/api/practice-sets/:id/continue", async (req) =>
    deps.sets.continue(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
      req.body,
    ),
  );
  app.get("/api/practice-preferences", async (req) =>
    deps.preferences.get(await scopeForRequest(deps.auth, req)),
  );
  app.patch("/api/practice-preferences", async (req) =>
    deps.preferences.patch(await scopeForRequest(deps.auth, req), req.body),
  );
  app.get("/api/practice-skills", async (req) =>
    deps.sets.listScopes(await scopeForRequest(deps.auth, req)),
  );
  app.get("/api/practice-exam-profiles", async (req) => {
    await scopeForRequest(deps.auth, req);
    return listExamProfiles({
      includeFixtures: process.env.NODE_ENV === "test",
    }).map((profile) => ({
      profileId: profile.profileId,
      version: profile.version,
      title: profile.title,
      scopeDescription: profile.scopeDescription,
      sourceNote: profile.sourceNote,
    }));
  });
}
