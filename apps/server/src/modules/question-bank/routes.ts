import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  questionEntryInputSchema,
  skillCreateInputSchema,
  skillPrerequisitesInputSchema,
} from "../../../../../packages/contracts/src/question-bank.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { AuthService } from "../auth/service.js";
import { requireSession } from "../auth/routes.js";
import { scopeForRequest } from "../learning/routes.js";
import { searchEligibleQuestions } from "./search.js";
import type { QuestionBankService } from "./service.js";
import type { SkillService } from "./skills.js";

const idParams = z.object({ id: z.uuid() });

const candidateQuery = z
  .object({
    skillId: z.uuid(),
    goal: z.enum(["diagnostic", "repair", "transfer", "review"]),
    difficulty: z.enum(["easy", "medium", "challenge"]).optional(),
    answerType: z.string().trim().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export function registerQuestionBank(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    database: Database;
    skills: SkillService;
    bank: QuestionBankService;
  },
) {
  const { auth, database, skills, bank } = deps;

  app.post("/api/admin/skills", async (req) =>
    skills.create(
      requireSession(req).actor,
      skillCreateInputSchema.parse(req.body),
    ),
  );
  app.get("/api/admin/skills", async (req) =>
    skills.list(requireSession(req).actor),
  );
  app.post("/api/admin/skills/:id/content", async (req) => {
    const params = idParams.parse(req.params);
    const body = z
      .object({ knowledgeItemId: z.uuid() })
      .strict()
      .parse(req.body);
    await skills.linkContent(
      requireSession(req).actor,
      params.id,
      body.knowledgeItemId,
    );
    return { status: "ok" };
  });
  app.put("/api/admin/skills/:id/prerequisites", async (req) => {
    const params = idParams.parse(req.params);
    const body = skillPrerequisitesInputSchema.parse(req.body);
    return skills.setPrerequisites(
      requireSession(req).actor,
      params.id,
      body.prerequisiteIds,
    );
  });

  app.post("/api/question-bank/entries", async (req) =>
    bank.createDraft(
      requireSession(req).actor,
      questionEntryInputSchema.parse(req.body),
    ),
  );
  app.post("/api/admin/question-bank/entries/:id/publish", async (req) => {
    const params = idParams.parse(req.params);
    const body = z
      .object({ version: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return bank.publish(requireSession(req).actor, params.id, body.version);
  });
  app.post("/api/question-bank/entries/:id/withdraw", async (req) => {
    const params = idParams.parse(req.params);
    const body = z
      .object({ reason: z.string().trim().min(1).max(300) })
      .strict()
      .parse(req.body);
    return bank.withdraw(requireSession(req).actor, params.id, body.reason);
  });

  app.get("/api/question-bank/candidates", async (req) => {
    const scope = await scopeForRequest(auth, req);
    return searchEligibleQuestions(database, scope, candidateQuery.parse(req.query));
  });
}
