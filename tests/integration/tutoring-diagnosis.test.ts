import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { inTransaction } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { MaterialService } from "../../apps/server/src/modules/materials/service.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import { DiagnosisService } from "../../apps/server/src/modules/tutoring/diagnosis-service.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

type DiagnosisPayload = {
  stem: string;
  answer: string;
  evidence: { kind: string; id: string; versionId?: string }[];
};

function gatewayWith(steps: FauxResponseStep[]) {
  const faux = fauxProvider({
    models: [{ id: "vision", input: ["text", "image"] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return {
    faux,
    gateway: new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    ),
  };
}

function diagnosisPayload(messages: Message[]): DiagnosisPayload {
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    try {
      const value = JSON.parse(message.content) as DiagnosisPayload;
      if (value && Array.isArray(value.evidence))
        return {
          ...value,
          evidence: value.evidence.map((ref) => ({
            kind: ref.kind,
            id: ref.id,
            ...(ref.versionId ? { versionId: ref.versionId } : {}),
          })),
        };
    } catch {
      /* not the diagnosis call */
    }
  }
  throw Error("diagnosis payload missing");
}

function candidateJson(output: unknown) {
  return JSON.stringify({ candidates: [output] });
}

async function scenario(
  db: Database,
  input: {
    seed: string;
    answer?: string;
    reference?: string;
    knowledgePoint?: string;
    stem?: string;
  },
) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数");
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, {
    revisionId: revision.id,
    kind: "daily_practice",
  });
  const question = await tasks.addQuestion(f.scope, task.id, {
    stem: input.stem ?? "只填数值：29+1=?",
    referenceAnswer: input.reference ?? "30",
    role: "original",
    ...(input.knowledgePoint ? { knowledgePoint: input.knowledgePoint } : {}),
  });
  const answer = input.answer ?? "28";
  await db.pool.query(
    "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,$2,'number',false,'verified','{}')",
    [question.questionVersionId, input.reference ?? "30"],
  );
  const messages = new MessageService(db, f.auth);
  const message = await messages.append(f.scope, {
    conversationId: task.conversationId,
    role: "user",
    content: answer,
  });
  const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
    taskId: task.id,
    questionVersionId: question.questionVersionId,
    messageVersionId: message.versionId,
    answer,
    requestKey: `attempt-${input.seed}`,
  });
  const assessment = await new AssessmentService(
    db,
    f.auth,
    f.catalog,
  ).submitCandidate(f.scope, {
    attemptId: attempt.id,
    correctness: "incorrect",
    reason: "与参考答案不一致",
    referenceIds: [],
  });
  expect(assessment).toMatchObject({
    correctness: "incorrect",
    verification: "verified",
  });
  return {
    f,
    task,
    question,
    message,
    attemptId: attempt.id,
    assessmentId: assessment.id,
    questionId: (
      await db.pool.query<{ question_id: string }>(
        "SELECT question_id FROM question_versions WHERE id=$1",
        [question.questionVersionId],
      )
    ).rows[0]!.question_id,
  };
}

async function secondStudent(f: Fixture) {
  const invitation = await f.auth.invite(f.admin, { login: "other-student" });
  const student = await f.auth.activate({
    token: invitation.activationToken,
    password: "long-test-password",
  });
  return f.auth.requireStudentAccess(
    { userId: student.userId, role: "student" },
    student.studentId!,
  );
}

/** 学生答完后补写的过程追问与回复，构成可定位的 probe 证据。 */
async function addProbe(
  db: Database,
  f: Fixture,
  context: { taskId: string; conversationId: string; questionVersionId: string },
) {
  const messages = new MessageService(db, f.auth);
  const asked = await messages.append(f.scope, {
    conversationId: context.conversationId,
    role: "assistant",
    content: "先说说这一步为什么这样算？",
  });
  const episode = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,state,lease_expires_at) VALUES($1,$2,$3,'probe-episode','finished',now()) RETURNING id",
      [f.scope.studentId, context.taskId, context.questionVersionId],
    )
  ).rows[0]!;
  await db.pool.query(
    "INSERT INTO tutoring_actions(episode_id,request_key,payload_hash,kind,state_version,state,exposure,display_status,content,message_version_id) VALUES($1,'probe-1','hash','request_probe',1,'micro_probe','none','sent','先说说这一步为什么这样算？',$2)",
    [episode.id, asked.versionId],
  );
  await db.pool.query(
    "UPDATE message_versions SET created_at=now()+interval '1 second' WHERE id=$1",
    [asked.versionId],
  );
  const reply = await messages.append(f.scope, {
    conversationId: context.conversationId,
    role: "user",
    content: "我把 29+1 写成了 29+1=28，是抄错了个位。",
  });
  await db.pool.query(
    "UPDATE message_versions SET created_at=now()+interval '2 seconds' WHERE id=$1",
    [reply.versionId],
  );
  return reply;
}

function answerPng(tint: number): Buffer {
  const canvas = createCanvas(64, 48);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${tint},${(tint * 7) % 256},${(tint * 13) % 256})`;
  ctx.fillRect(0, 0, 64, 48);
  return canvas.toBuffer("image/png");
}

async function imageScenario(
  db: Database,
  input: { answer: string; reference: string; tint: number },
) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数");
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, {
    revisionId: revision.id,
    kind: "daily_practice",
  });
  const question = await tasks.addQuestion(f.scope, task.id, {
    stem: "只填数值：29+1=?",
    referenceAnswer: input.reference,
    role: "original",
  });
  await db.pool.query(
    "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,$2,'number',false,'verified','{}')",
    [question.questionVersionId, input.reference],
  );
  const messages = new MessageService(db, f.auth);
  const message = await messages.append(f.scope, {
    conversationId: task.conversationId,
    role: "user",
    content: input.answer,
  });
  const bytes = answerPng(input.tint);
  const grant = await f.uploads.create(f.scope.actor, {
    studentId: f.scope.studentId,
    purpose: "conversation_image",
    conversationId: task.conversationId,
    name: "answer.png",
    contentType: "image/png",
    size: bytes.length,
  });
  f.store.put(grant.key, {
    size: bytes.length,
    contentType: "image/png",
    prefix: bytes,
  });
  await f.uploads.complete(f.scope.actor, grant.fileId);
  const key = (
    await db.pool.query<{ object_key: string }>(
      "SELECT object_key FROM files WHERE id=$1",
      [grant.fileId],
    )
  ).rows[0]!.object_key;
  await inTransaction(db, (tx) =>
    new ConversationAttachmentService(db, f.auth, f.store).validateAndBind(
      tx,
      f.scope,
      task.conversationId,
      message.versionId,
      [grant.fileId],
    ),
  );
  const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
    taskId: task.id,
    questionVersionId: question.questionVersionId,
    messageVersionId: message.versionId,
    answer: input.answer,
    requestKey: "attempt-image",
  });
  return { f, task, question, message, attemptId: attempt.id, fileId: grant.fileId, key };
}

function diagnosisService(db: Database, f: Fixture, gateway?: ModelGateway) {
  return new DiagnosisService(db, f.auth, gateway);
}

async function latestRow(db: Database, attemptId: string) {
  return (
    await db.pool.query<{
      id: string;
      version: number;
      status: string;
      primary_code: string | null;
      summary: string;
      model_version: string;
      invalid_reason: string | null;
    }>(
      "SELECT id,version,status,primary_code,summary,model_version,invalid_reason FROM error_diagnoses WHERE attempt_id=$1 ORDER BY version DESC LIMIT 1",
      [attemptId],
    )
  ).rows[0];
}

it("model_invalid_json_keeps_pending", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "bad-json" });
    const { faux, gateway } = gatewayWith([
      () => fauxAssistantMessage("这不是 JSON"),
    ]);
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis).toMatchObject({ status: "pending", primaryCode: null });
    expect(diagnosis.summary).toContain("自动诊断暂时不可用");
    expect(faux.state.callCount).toBe(1);
    expect((await latestRow(db, s.attemptId))!.model_version).toBe(
      "unavailable",
    );
  }));

it("fabricated_evidence_ids_are_dropped", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "fake-ref" });
    const fabricated = randomUUID();
    const { gateway } = gatewayWith([
      () =>
        fauxAssistantMessage(
          candidateJson({
            code: "condition_omission",
            earliestError: { kind: "process_step", id: fabricated },
            status: "confirmed",
          }),
        ),
    ]);
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis.status).not.toBe("confirmed");
    expect(diagnosis.primaryCode).toBeNull();
    const rows = (
      await db.pool.query<{ earliest_error: unknown }>(
        "SELECT earliest_error FROM diagnosis_candidates WHERE diagnosis_id=$1",
        [diagnosis.id],
      )
    ).rows;
    expect(rows[0]!.earliest_error).toBeNull();
  }));

it("missing_published_knowledge_blocks_concept_gap", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, {
      seed: "no-knowledge",
      knowledgePoint: "两位数加法的进位",
    });
    const { gateway } = gatewayWith([
      (context) => {
        const payload = diagnosisPayload(context.messages);
        const step = payload.evidence.find(
          (ref) => ref.kind === "process_step",
        )!;
        return fauxAssistantMessage(
          candidateJson({
            code: "concept_gap",
            earliestError: step,
            supports: [step],
          }),
        );
      },
    ]);
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis).toMatchObject({ status: "pending", primaryCode: null });
    expect(diagnosis.summary).toContain("知识点依据");
    expect(diagnosis.candidates[0]).toMatchObject({
      code: "concept_gap",
      status: "supported",
    });
    expect(
      diagnosis.evidence.some((ref) => ref.kind === "knowledge_snapshot"),
    ).toBe(false);
  }));

it("model_timeout_does_not_confirm", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "timeout" });
    const { gateway } = gatewayWith([
      () => {
        throw Error("aborted by timeout");
      },
    ]);
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis).toMatchObject({ status: "pending", primaryCode: null });
    expect(diagnosis.summary).toContain("自动诊断暂时不可用");
  }));

it("unreadable_image_keeps_assessment_pending", async () =>
  withTestDb(async (db) => {
    const s = await imageScenario(db, {
      answer: "3",
      reference: "3",
      tint: 71,
    });
    const read = s.f.store.read.bind(s.f.store);
    s.f.store.read = async (key) => {
      if (key === s.key) throw Error("object missing");
      return read(key);
    };
    const { faux, gateway } = gatewayWith([fauxAssistantMessage("不应被调用")]);
    const assessment = await new AssessmentService(
      db,
      s.f.auth,
      s.f.catalog,
      gateway,
      s.f.store,
    ).submitCandidate(s.f.scope, {
      attemptId: s.attemptId,
      correctness: "correct",
      reason: "文字答案正确",
      referenceIds: [],
    });
    expect(assessment).toMatchObject({
      correctness: "uncertain",
      verification: "pending",
    });
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis.status).not.toBe("confirmed");
    expect(diagnosis.primaryCode).toBeNull();
    expect(faux.state.callCount).toBe(0);
  }));

it("image_reference_cannot_locate_the_error", async () =>
  withTestDb(async (db) => {
    const s = await imageScenario(db, {
      answer: "3",
      reference: "5",
      tint: 17,
    });
    const { gateway } = gatewayWith([
      () =>
        fauxAssistantMessage(
          JSON.stringify({
            correctness: "incorrect",
            evidenceSufficient: true,
            criteriaSatisfied: false,
            reason: "图中过程与答案不一致",
          }),
        ),
      (context) => {
        const payload = diagnosisPayload(context.messages);
        const image = payload.evidence.find((ref) => ref.kind === "image")!;
        return fauxAssistantMessage(
          candidateJson({
            code: "condition_omission",
            earliestError: image,
            supports: [image],
            status: "confirmed",
          }),
        );
      },
    ]);
    const assessment = await new AssessmentService(
      db,
      s.f.auth,
      s.f.catalog,
      gateway,
      s.f.store,
    ).submitCandidate(s.f.scope, {
      attemptId: s.attemptId,
      correctness: "incorrect",
      reason: "图中过程错误",
      referenceIds: [],
    });
    expect(assessment).toMatchObject({
      correctness: "incorrect",
      verification: "verified",
    });
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis.status).not.toBe("confirmed");
    expect(diagnosis.status).toBe("needs_probe");
    expect(diagnosis.primaryCode).toBeNull();
    expect(
      diagnosis.evidence.some(
        (ref) => ref.kind === "image" && ref.id === s.fileId,
      ),
    ).toBe(true);
  }));

it("model_cannot_confirm_without_probe_evidence", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "no-probe" });
    const { gateway } = gatewayWith([
      (context) => {
        const payload = diagnosisPayload(context.messages);
        const step = payload.evidence.find(
          (ref) => ref.kind === "process_step",
        )!;
        return fauxAssistantMessage(
          candidateJson({
            code: "execution_slip",
            earliestError: step,
            supports: [step],
            status: "confirmed",
          }),
        );
      },
    ]);
    const diagnosis = await diagnosisService(db, s.f, gateway).analyze(
      s.f.scope,
      s.attemptId,
    );
    expect(diagnosis.status).toBe("needs_probe");
    expect(diagnosis.primaryCode).toBeNull();
    expect(diagnosis.candidates[0]!.status).toBe("supported");
  }));

it("same_assessment_retry_keeps_one_version_and_new_probe_adds_one", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "versions" });
    const respond = (context: { messages: Message[] }) => {
      const payload = diagnosisPayload(context.messages);
      const step = payload.evidence.find((ref) => ref.kind === "process_step")!;
      return fauxAssistantMessage(
        candidateJson({ code: "condition_omission", earliestError: step }),
      );
    };
    const { faux, gateway } = gatewayWith([respond, respond]);
    const service = diagnosisService(db, s.f, gateway);
    const first = await service.analyze(s.f.scope, s.attemptId);
    expect(first).toMatchObject({
      version: 1,
      status: "confirmed",
      primaryCode: "condition_omission",
    });
    expect(faux.state.callCount).toBe(1);

    const retried = await service.analyze(s.f.scope, s.attemptId);
    expect(retried.id).toBe(first.id);
    expect(retried.version).toBe(1);
    expect(faux.state.callCount).toBe(1);

    await addProbe(db, s.f, {
      taskId: s.task.id,
      conversationId: s.task.conversationId,
      questionVersionId: s.question.questionVersionId,
    });
    const next = await service.analyze(s.f.scope, s.attemptId);
    expect(next.version).toBe(2);
    expect(next.id).not.toBe(first.id);
    expect(faux.state.callCount).toBe(2);
    expect(
      next.evidence.some((ref) => ref.kind === "probe_response"),
    ).toBe(true);
  }));

it("editing_evidence_invalidates_diagnosis_without_touching_answer", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "edited" });
    const { gateway } = gatewayWith([
      (context) => {
        const payload = diagnosisPayload(context.messages);
        const step = payload.evidence.find(
          (ref) => ref.kind === "process_step",
        )!;
        return fauxAssistantMessage(
          candidateJson({ code: "condition_omission", earliestError: step }),
        );
      },
    ]);
    const service = diagnosisService(db, s.f, gateway);
    const confirmed = await service.analyze(s.f.scope, s.attemptId);
    expect(confirmed.status).toBe("confirmed");

    await new MessageService(db, s.f.auth).edit(s.f.scope, {
      messageId: s.message.id,
      expectedVersion: s.message.versionNo,
      content: "27",
    });
    const latest = await service.latest(s.f.scope, s.attemptId);
    expect(latest).toMatchObject({
      id: confirmed.id,
      status: "invalidated",
      summary: confirmed.summary,
    });
    expect((await latestRow(db, s.attemptId))!.invalid_reason).toBe(
      "message_edited",
    );
    const attempt = (
      await db.pool.query<{ answer: string; message_version_id: string | null }>(
        "SELECT answer,message_version_id FROM attempts WHERE id=$1",
        [s.attemptId],
      )
    ).rows[0]!;
    expect(attempt.answer).toBe("28");
    expect(attempt.message_version_id).toBe(s.message.versionId);

    const other = await secondStudent(s.f);
    await expect(service.analyze(other, s.attemptId)).rejects.toThrow(
      "作答不存在",
    );
    await expect(
      service.invalidate(other, s.message.versionId, "message_edited"),
    ).rejects.toThrow("证据不存在");
  }));

it("superseded_assessment_invalidates_diagnosis", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "superseded" });
    const { gateway } = gatewayWith([
      (context) => {
        const payload = diagnosisPayload(context.messages);
        const step = payload.evidence.find(
          (ref) => ref.kind === "process_step",
        )!;
        return fauxAssistantMessage(
          candidateJson({ code: "condition_omission", earliestError: step }),
        );
      },
    ]);
    const service = diagnosisService(db, s.f, gateway);
    const confirmed = await service.analyze(s.f.scope, s.attemptId);
    expect(confirmed.status).toBe("confirmed");

    await db.pool.query(
      "UPDATE question_references SET verification='pending' WHERE question_version_id=$1",
      [s.question.questionVersionId],
    );
    await db.pool.query(
      "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'28','number',false,'verified','{}')",
      [s.question.questionVersionId],
    );
    const revised = await new AssessmentService(
      db,
      s.f.auth,
      s.f.catalog,
    ).submitCandidate(s.f.scope, {
      attemptId: s.attemptId,
      correctness: "correct",
      reason: "与修订后的参考答案一致",
      referenceIds: [],
    });
    expect(revised).toMatchObject({
      correctness: "correct",
      verification: "verified",
    });
    const row = await latestRow(db, s.attemptId);
    expect(row).toMatchObject({
      id: confirmed.id,
      status: "invalidated",
      invalid_reason: "assessment_superseded",
    });
  }));

it("correcting_stem_invalidates_diagnosis", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db, { seed: "corrected" });
    const { gateway } = gatewayWith([
      (context) => {
        const payload = diagnosisPayload(context.messages);
        const step = payload.evidence.find(
          (ref) => ref.kind === "process_step",
        )!;
        return fauxAssistantMessage(
          candidateJson({ code: "condition_omission", earliestError: step }),
        );
      },
    ]);
    const service = diagnosisService(db, s.f, gateway);
    const confirmed = await service.analyze(s.f.scope, s.attemptId);
    expect(confirmed.status).toBe("confirmed");

    const materials = new MaterialService(
      db,
      s.f.auth,
      s.f.uploads,
      s.f.catalog,
    );
    await materials.correctQuestion(s.f.scope, {
      questionId: s.questionId,
      expectedVersion: 1,
      stem: "只填数值：29+2=?",
    });
    const row = await latestRow(db, s.attemptId);
    expect(row).toMatchObject({
      id: confirmed.id,
      status: "invalidated",
      invalid_reason: "question_corrected",
      summary: confirmed.summary,
    });
  }));
