import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  episodeEventsInputSchema,
  type DiagnosisDTO,
} from "../../../../../packages/contracts/src/tutoring.js";
import type { AuthService } from "../auth/service.js";
import { scopeForRequest } from "../learning/routes.js";
import type { DiagnosisService } from "./diagnosis-service.js";
import type { TimingService } from "./timing-service.js";

/** 只暴露学生能理解的摘要与证据链接，不含候选内部推理。 */
function studentDiagnosis(diagnosis: DiagnosisDTO) {
  const probe =
    diagnosis.candidates.find(
      (candidate) => candidate.status !== "rejected" && candidate.probe,
    )?.probe ?? null;
  const nextStep =
    diagnosis.status === "confirmed"
      ? "按这一处再做一道同类题，隔天回来自检一次。"
      : diagnosis.status === "needs_probe"
        ? (probe ?? "先把这一步的中间过程补上，再做判断。")
        : diagnosis.status === "invalidated"
          ? "题干或作答已经修改，请按新版本重新作答。"
          : "先保留原作答，等更多过程证据再判断。";
  return {
    id: diagnosis.id,
    attemptId: diagnosis.attemptId,
    version: diagnosis.version,
    status: diagnosis.status,
    primaryCode: diagnosis.primaryCode,
    summary: diagnosis.summary,
    nextStep,
    evidence: diagnosis.evidence.map(({ kind, id }) => ({ kind, id })),
  };
}

export function registerTutoring(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    timing: TimingService;
    diagnosis?: DiagnosisService;
  },
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
  app.get("/api/attempts/:id/diagnosis", async (req) => {
    const diagnosis = await deps.diagnosis?.latest(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    );
    return { diagnosis: diagnosis ? studentDiagnosis(diagnosis) : null };
  });
  app.get("/api/tutoring/episodes/:id", async (req) =>
    deps.timing.get(
      await scopeForRequest(deps.auth, req),
      id.parse(req.params).id,
    ),
  );
}
