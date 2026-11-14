import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { DiagnosisReviewService } from "../../apps/server/src/modules/student-insights/diagnosis-reviews.js";
import { diagnosisReviewInputSchema } from "../../packages/contracts/src/learning-evaluation.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

async function reviewScenario(db: Database, seed: string) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数");
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, {
    revisionId: revision.id,
    kind: "daily_practice",
  });
  const question = await tasks.addQuestion(f.scope, task.id, {
    stem: "只填数值：29+1=?",
    referenceAnswer: "30",
    role: "original",
    knowledgePoint: "两位数加法的进位",
  });
  await db.pool.query(
    "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'30','number',false,'verified','{}')",
    [question.questionVersionId],
  );
  const message = await new MessageService(db, f.auth).append(f.scope, {
    conversationId: task.conversationId,
    role: "user",
    content: "28",
  });
  const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
    taskId: task.id,
    questionVersionId: question.questionVersionId,
    messageVersionId: message.versionId,
    answer: "28",
    requestKey: `attempt-${seed}`,
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

  const skillId = randomUUID();
  await db.pool.query(
    "INSERT INTO skills(id,code,name,created_by) VALUES($1,$2,'两位数进位加法',$3)",
    [skillId, `skill-${seed}`, f.admin.userId],
  );
  const entryId = randomUUID();
  await db.pool.query(
    `INSERT INTO question_bank_entries(
       id,question_version_id,difficulty_band,complexity_band,visibility,
       source_type,content_fingerprint,status,published_at,created_by)
     VALUES($1,$2,'medium',2,'shared','material_question',$3,'published',now(),$4)`,
    [entryId, question.questionVersionId, `fingerprint-${seed}`, f.admin.userId],
  );
  await db.pool.query(
    "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
    [entryId, skillId],
  );
  await db.pool.query(
    "INSERT INTO learning_profiles(student_id,skill_id) VALUES($1,$2)",
    [f.scope.studentId, skillId],
  );

  const diagnosisId = randomUUID();
  const evidence = [
    {
      kind: "message_version",
      id: message.versionId,
      versionId: message.versionId,
    },
  ];
  await db.pool.query(
    `INSERT INTO error_diagnoses(
       id,attempt_id,assessment_id,question_version_id,version,status,
       primary_code,summary,evidence,rule_version,model_version)
     VALUES($1,$2,$3,$4,1,'confirmed','execution_slip',
       '判定为抄写时漏写进位，属于操作失误。',$5,'diagnosis-v1','reviewed')`,
    [
      diagnosisId,
      attempt.id,
      assessment.id,
      question.questionVersionId,
      JSON.stringify(evidence),
    ],
  );
  await db.pool.query(
    `INSERT INTO diagnosis_candidates(diagnosis_id,code,status,supports)
     VALUES($1,'execution_slip','confirmed',$2)`,
    [diagnosisId, JSON.stringify(evidence)],
  );

  const decisionId = randomUUID();
  await db.pool.query(
    `INSERT INTO practice_decisions(
       id,student_id,task_id,request_key,request_hash,policy_version,
       profile_version,status,goal,difficulty,entry_id,question_version_id,
       skill_id,explanation)
     VALUES($1,$2,$3,'decision-1','hash-1','adaptive-selection-v1',1,
       'selected','repair','medium',$4,$5,$6,'按诊断补齐进位练习')`,
    [
      decisionId,
      f.scope.studentId,
      task.id,
      entryId,
      question.questionVersionId,
      skillId,
    ],
  );

  const reportId = randomUUID();
  const snapshot = {
    metricVersion: "insight-metrics-v1",
    diagnosisId,
    summary: "抄写时漏写进位。",
  };
  await db.pool.query(
    `INSERT INTO student_insight_reports(
       id,student_id,requested_by,from_date,to_date,metric_version,
       prompt_version,snapshot_hash,snapshot,evidence_catalog,status)
     VALUES($1,$2,$3,'2026-11-01','2026-11-13','insight-metrics-v1',
       'insight-report-v1','snapshot-hash-1',$4,'[]','completed')`,
    [reportId, f.scope.studentId, f.admin.userId, JSON.stringify(snapshot)],
  );

  return {
    f,
    task,
    question,
    message,
    attemptId: attempt.id,
    assessmentId: assessment.id,
    skillId,
    diagnosisId,
    decisionId,
    reportId,
    snapshot,
  };
}

async function otherStudent(f: Fixture) {
  const invitation = await f.auth.invite(f.admin, { login: "reviewer-other" });
  const student = await f.auth.activate({
    token: invitation.activationToken,
    password: "long-test-password",
  });
  return f.auth.requireStudentAccess(
    { userId: student.userId, role: "student" },
    student.studentId!,
  );
}

function service(db: Database) {
  return new DiagnosisReviewService(db);
}

async function versionsOf(db: Database, attemptId: string) {
  return (
    await db.pool.query<{
      version: number;
      status: string;
      primary_code: string | null;
      summary: string;
    }>(
      "SELECT version,status,primary_code,summary FROM error_diagnoses WHERE attempt_id=$1 ORDER BY version DESC",
      [attemptId],
    )
  ).rows;
}

async function reviewRows(db: Database) {
  return (
    await db.pool.query<{
      decision: string;
      corrected_code: string | null;
      reason: string;
      result_version: number;
    }>(
      "SELECT decision,corrected_code,reason,result_version FROM diagnosis_reviews ORDER BY created_at"
    )
  ).rows;
}

it("student_cannot_review_own_diagnosis", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "student-self");
    const other = await otherStudent(s.f);
    await expect(
      service(db).submit(other.actor, {
        studentId: s.f.scope.studentId,
        diagnosisId: s.diagnosisId,
        expectedVersion: 1,
        decision: "accept",
        correctedCode: null,
        reason: "学生自己认为判定正确",
        evidence: [],
        requestKey: "student-self-review",
      }),
    ).rejects.toThrow();
    expect(await reviewRows(db)).toHaveLength(0);
  }));

it("diagnosis_from_another_student_is_not_found", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "cross-student");
    const other = await otherStudent(s.f);
    await expect(
      service(db).submit(s.f.admin, {
        studentId: other.studentId,
        diagnosisId: s.diagnosisId,
        expectedVersion: 1,
        decision: "accept",
        correctedCode: null,
        reason: "确认诊断结论",
        evidence: [],
        requestKey: "cross-student-review",
      }),
    ).rejects.toMatchObject({ status: 404 });
  }));

it("retrying_the_same_review_key_keeps_one_review", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "retry");
    const input = {
      studentId: s.f.scope.studentId,
      diagnosisId: s.diagnosisId,
      expectedVersion: 1,
      decision: "accept" as const,
      correctedCode: null,
      reason: "复核材料后认可当前结论",
      evidence: [],
      requestKey: "retry-review",
    };
    const first = await service(db).submit(s.f.admin, input);
    const second = await service(db).submit(s.f.admin, input);
    expect(second).toEqual(first);
    expect(await reviewRows(db)).toHaveLength(1);
    expect(await versionsOf(db, s.attemptId)).toHaveLength(2);
  }));

it("stale_expected_version_conflicts", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "conflict");
    await service(db).submit(s.f.admin, {
      studentId: s.f.scope.studentId,
      diagnosisId: s.diagnosisId,
      expectedVersion: 1,
      decision: "accept",
      correctedCode: null,
      reason: "认可当前结论",
      evidence: [],
      requestKey: "conflict-first",
    });
    await expect(
      service(db).submit(s.f.admin, {
        studentId: s.f.scope.studentId,
        diagnosisId: s.diagnosisId,
        expectedVersion: 1,
        decision: "accept",
        correctedCode: null,
        reason: "重复提交旧版本",
        evidence: [],
        requestKey: "conflict-second",
      }),
    ).rejects.toMatchObject({ status: 409 });
  }));

it("correction_requires_a_code_and_valid_evidence", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "evidence");

    expect(
      diagnosisReviewInputSchema.safeParse({
        expectedVersion: 1,
        decision: "correct",
        correctedCode: null,
        reason: "错因不对",
        evidence: [],
        requestKey: "no-code",
      }).success,
    ).toBe(false);

    await expect(
      service(db).submit(s.f.admin, {
        studentId: s.f.scope.studentId,
        diagnosisId: s.diagnosisId,
        expectedVersion: 1,
        decision: "correct",
        correctedCode: "concept_gap",
        reason: "这是知识缺口，不是抄写失误",
        evidence: [],
        requestKey: "no-evidence",
      }),
    ).rejects.toMatchObject({ status: 422 });

    const other = await otherStudent(s.f);
    const foreign = randomUUID();
    await db.pool.query(
      "INSERT INTO skills(id,code,name,created_by) VALUES($1,'skill-foreign','他人技能',$2)",
      [foreign, s.f.admin.userId],
    );
    await expect(
      service(db).submit(s.f.admin, {
        studentId: s.f.scope.studentId,
        diagnosisId: s.diagnosisId,
        expectedVersion: 1,
        decision: "correct",
        correctedCode: "concept_gap",
        reason: "引用不属于该学生的证据",
        evidence: [{ kind: "skill", id: foreign }],
        requestKey: "foreign-evidence",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(other.studentId).toBeDefined();
  }));

it("correction_appends_a_version_and_invalidates_derived_evidence", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "correct");
    const result = await service(db).submit(s.f.admin, {
      studentId: s.f.scope.studentId,
      diagnosisId: s.diagnosisId,
      expectedVersion: 1,
      decision: "correct",
      correctedCode: "concept_gap",
      reason: "追问后确认学生不理解进位含义，属于知识缺口而非抄写失误",
      evidence: [
        {
          kind: "message_version",
          id: s.message.versionId,
          versionId: s.message.versionId,
        },
      ],
      requestKey: "correct-review",
    });

    const versions = await versionsOf(db, s.attemptId);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      version: result.diagnosisVersion,
      status: "confirmed",
      primary_code: "concept_gap",
    });
    expect(versions[0]!.summary).toContain("知识缺口");
    // 被推翻的结论仍然保留，只是不再是当前版本
    expect(versions[1]).toMatchObject({
      version: 1,
      status: "confirmed",
      primary_code: "execution_slip",
    });

    const profile = (
      await db.pool.query<{ stale: boolean }>(
        "SELECT stale FROM learning_profiles WHERE student_id=$1 AND skill_id=$2",
        [s.f.scope.studentId, s.skillId],
      )
    ).rows[0]!;
    expect(profile.stale).toBe(true);

    const jobs = (
      await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='learning_profile.rebuild' AND payload->>'studentId'=$1",
        [s.f.scope.studentId],
      )
    ).rows[0]!;
    expect(jobs.n).toBe(1);

    const decision = (
      await db.pool.query<{
        invalidated_at: Date | null;
        invalid_reason: string | null;
        explanation: string;
      }>(
        "SELECT invalidated_at,invalid_reason,explanation FROM practice_decisions WHERE id=$1",
        [s.decisionId],
      )
    ).rows[0]!;
    expect(decision.invalidated_at).not.toBeNull();
    expect(decision.invalid_reason).toContain("诊断");
    expect(decision.explanation).toBe("按诊断补齐进位练习");

    const report = (
      await db.pool.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM student_insight_reports WHERE id=$1",
        [s.reportId],
      )
    ).rows[0]!;
    expect(report.snapshot).toEqual(s.snapshot);

    const audit = (
      await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='student_insight.diagnosis_review' AND student_id=$1",
        [s.f.scope.studentId],
      )
    ).rows[0]!;
    expect(audit.n).toBe(1);
  }));

it("accept_does_not_invent_mastery_or_invalidate_evidence", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "accept");
    const result = await service(db).submit(s.f.admin, {
      studentId: s.f.scope.studentId,
      diagnosisId: s.diagnosisId,
      expectedVersion: 1,
      decision: "accept",
      correctedCode: null,
      reason: "证据支持当前判定的操作失误结论",
      evidence: [],
      requestKey: "accept-review",
    });
    const versions = await versionsOf(db, s.attemptId);
    expect(versions[0]).toMatchObject({
      version: result.diagnosisVersion,
      primary_code: "execution_slip",
    });
    const profile = (
      await db.pool.query<{ stale: boolean; training_band: string }>(
        "SELECT stale,training_band FROM learning_profiles WHERE student_id=$1 AND skill_id=$2",
        [s.f.scope.studentId, s.skillId],
      )
    ).rows[0]!;
    expect(profile).toMatchObject({ stale: false, training_band: "repair" });
    const decision = (
      await db.pool.query<{ invalidated_at: Date | null }>(
        "SELECT invalidated_at FROM practice_decisions WHERE id=$1",
        [s.decisionId],
      )
    ).rows[0]!;
    expect(decision.invalidated_at).toBeNull();
    const assessment = (
      await db.pool.query<{ correctness: string }>(
        "SELECT correctness FROM assessments WHERE id=$1",
        [s.assessmentId],
      )
    ).rows[0]!;
    expect(assessment.correctness).toBe("incorrect");
  }));

it("insufficient_evidence_leaves_the_cause_unconfirmed", async () =>
  withTestDb(async (db) => {
    const s = await reviewScenario(db, "insufficient");
    const result = await service(db).submit(s.f.admin, {
      studentId: s.f.scope.studentId,
      diagnosisId: s.diagnosisId,
      expectedVersion: 1,
      decision: "insufficient",
      correctedCode: null,
      reason: "现有证据只能确认答错，无法判断错因",
      evidence: [],
      requestKey: "insufficient-review",
    });
    const latest = (
      await db.pool.query<{ status: string; primary_code: string | null }>(
        "SELECT status,primary_code FROM error_diagnoses WHERE attempt_id=$1 AND version=$2",
        [s.attemptId, result.diagnosisVersion],
      )
    ).rows[0]!;
    expect(latest).toEqual({ status: "unsupported", primary_code: null });
  }));
