import type { Actor } from "../../packages/contracts/src/domain.js";
import type { Database } from "../../packages/db/src/client.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import {
  addDays,
  dayStartUtc,
  shanghaiToday,
} from "../../apps/server/src/modules/student-insights/metrics.js";

const password = "a-strong-test-password";

export type InsightPerson = {
  login: string;
  actor: Actor;
  studentId: string;
  token: string;
};

export type StudentInsightsFixture = {
  db: Database;
  auth: AuthService;
  admin: Actor;
  secondAdmin: Actor;
  adminToken: string;
  studentA: InsightPerson;
  studentB: InsightPerson;
  emptyStudentId: string;
  cookie: (token: string) => { cookie: string };
};

export function sessionCookie(token: string): { cookie: string } {
  return { cookie: `xy_session=${token}` };
}

export async function studentInsightsFixture(
  db: Database,
): Promise<StudentInsightsFixture> {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("insight-admin", password);
  const secondAdmin = await auth.createAdmin("insight-admin-2", password);

  const person = async (login: string): Promise<InsightPerson> => {
    const invitation = await auth.invite(admin, { login });
    const student = await auth.activate({
      token: invitation.activationToken,
      password,
    });
    const session = await auth.login({ login, password });
    return {
      login,
      actor: { userId: student.userId, role: "student" },
      studentId: student.studentId!,
      token: session.sessionToken,
    };
  };

  const studentA = await person("insight-student-a");
  const studentB = await person("insight-student-b");

  // 学生 A 的档案同时被第二个账号以 viewer 身份访问
  await auth.grantAccess(
    { actor: studentA.actor, studentId: studentA.studentId },
    { login: studentB.login },
  );

  const emptyStudentId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO student_profiles(display_name) VALUES('空档案') RETURNING id",
    )
  ).rows[0]!.id;

  const adminToken = (await auth.login({ login: "insight-admin", password }))
    .sessionToken;

  return {
    db,
    auth,
    admin,
    secondAdmin,
    adminToken,
    studentA,
    studentB,
    emptyStudentId,
    cookie: sessionCookie,
  };
}

export function adminInsightCookie(fixture: StudentInsightsFixture) {
  return fixture.cookie(fixture.adminToken);
}

export type InsightFactsSeed = {
  today: string;
  revisionA: string;
  revisionB: string;
  taskA: string;
  deletedTask: string;
  questionA: string;
  questionVersionA: string;
  questionB: string;
  questionVersionB: string;
  questionC: string;
  questionVersionC: string;
  questionInvalidated: string;
  questionVersionInvalidated: string;
  questionMessageInvalidated: string;
  questionVersionMessageInvalidated: string;
  material: string;
  attemptIds: {
    firstA: string;
    redoA: string;
    deletedTask: string;
    invalidatedQuestion: string;
    invalidatedMessage: string;
    lifetimeFirstOutside: string;
    redoB: string;
    revisionB: string;
    pending: string;
  };
  assessmentIds: {
    firstAOld: string;
    firstALatest: string;
    redoA: string;
    lifetimeFirstOutside: string;
    redoB: string;
    pending: string;
    superseded: string;
  };
};

type IdRow = { id: string };

async function id(query: Promise<{ rows: IdRow[] }>): Promise<string> {
  return (await query).rows[0]!.id;
}

async function createRevision(
  db: Database,
  adminUserId: string,
  label: string,
): Promise<string> {
  const fileId = await id(
    db.pool.query(
      `INSERT INTO files(owner_id,purpose,name,content_type,size,object_key)
       VALUES($1,'textbook',$2,'application/pdf',100,$3) RETURNING id`,
      [adminUserId, `${label}.pdf`, crypto.randomUUID()],
    ),
  );
  const editionId = await id(
    db.pool.query(
      "INSERT INTO curriculum_editions(name) VALUES($1) RETURNING id",
      [`${label}-edition`],
    ),
  );
  const gradeId = await id(
    db.pool.query("INSERT INTO grades(name) VALUES($1) RETURNING id", [
      `${label}-grade`,
    ]),
  );
  const subjectId = await id(
    db.pool.query("INSERT INTO subjects(name) VALUES($1) RETURNING id", [
      `${label}-subject`,
    ]),
  );
  const textbookId = await id(
    db.pool.query(
      `INSERT INTO textbooks(title,edition_id,grade_id,subject_id,term,publication_year)
       VALUES($1,$2,$3,$4,'下册',2024) RETURNING id`,
      [label, editionId, gradeId, subjectId],
    ),
  );
  return id(
    db.pool.query(
      `INSERT INTO textbook_revisions(textbook_id,file_id,revision_no,status)
       VALUES($1,$2,1,'published') RETURNING id`,
      [textbookId, fileId],
    ),
  );
}

async function createQuestion(
  db: Database,
  studentId: string,
  revisionId: string,
  label: string,
): Promise<{ questionId: string; versionId: string }> {
  const questionId = await id(
    db.pool.query(
      `INSERT INTO questions(student_id,revision_id,source_type)
       VALUES($1,$2,'teacher') RETURNING id`,
      [studentId, revisionId],
    ),
  );
  const versionId = await id(
    db.pool.query(
      `INSERT INTO question_versions(question_id,version_no,stem,knowledge_point)
       VALUES($1,1,$2,'分数') RETURNING id`,
      [questionId, label],
    ),
  );
  return { questionId, versionId };
}

async function createTask(
  db: Database,
  studentId: string,
  revisionId: string,
  title: string,
  createdAt: Date,
  deletedAt: Date | null = null,
): Promise<string> {
  return id(
    db.pool.query(
      `INSERT INTO learning_tasks(student_id,revision_id,kind,title,status,deleted_at,created_at,updated_at)
       VALUES($1,$2,'practice',$3,'active',$4,$5,$5) RETURNING id`,
      [studentId, revisionId, title, deletedAt, createdAt],
    ),
  );
}

async function createAttempt(
  db: Database,
  input: {
    studentId: string;
    taskId: string | null;
    questionVersionId: string;
    messageVersionId?: string | null;
    createdAt: Date;
  },
): Promise<string> {
  return id(
    db.pool.query(
      `INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer,created_at)
       VALUES($1,$2,$3,$4,$5,'答案',$6) RETURNING id`,
      [
        input.studentId,
        input.taskId,
        input.questionVersionId,
        input.messageVersionId ?? null,
        crypto.randomUUID(),
        input.createdAt,
      ],
    ),
  );
}

async function createAssessment(
  db: Database,
  input: {
    attemptId: string;
    correctness: string;
    verification: string;
    createdAt: Date;
  },
): Promise<string> {
  return id(
    db.pool.query(
      `INSERT INTO assessments(attempt_id,correctness,verification,hint_dependency,method,verifier_version,evidence,created_at)
       VALUES($1,$2,$3,'none','model','v1','{}',$4) RETURNING id`,
      [input.attemptId, input.correctness, input.verification, input.createdAt],
    ),
  );
}

export async function seedInsightFacts(
  fixture: StudentInsightsFixture,
  now: Date = new Date(),
): Promise<InsightFactsSeed> {
  const { db, admin, studentA } = fixture;
  const today = shanghaiToday(now);
  const at = (dayOffset: number, hour: number) =>
    new Date(dayStartUtc(addDays(today, dayOffset)).getTime() + hour * 3_600_000);

  const revisionA = await createRevision(db, admin.userId, "数学A");
  const revisionB = await createRevision(db, admin.userId, "数学B");

  const taskA = await createTask(db, studentA.studentId, revisionA, "练习", at(-6, 9));
  const deletedTask = await createTask(
    db,
    studentA.studentId,
    revisionA,
    "已删除",
    at(-6, 9),
    at(-5, 0),
  );

  const a = await createQuestion(db, studentA.studentId, revisionA, "题A");
  const b = await createQuestion(db, studentA.studentId, revisionA, "题B");
  const c = await createQuestion(db, studentA.studentId, revisionB, "题C");
  const invalidated = await createQuestion(db, studentA.studentId, revisionA, "失效题");
  const messageInvalidated = await createQuestion(db, studentA.studentId, revisionA, "失效消息题");

  const conversationId = await id(
    db.pool.query(
      `INSERT INTO conversations(student_id,revision_id) VALUES($1,$2) RETURNING id`,
      [studentA.studentId, revisionA],
    ),
  );
  const messageId = await id(
    db.pool.query(
      `INSERT INTO messages(conversation_id,role) VALUES($1,'student') RETURNING id`,
      [conversationId],
    ),
  );
  const messageVersionId = await id(
    db.pool.query(
      `INSERT INTO message_versions(message_id,version_no,content)
       VALUES($1,1,'消息') RETURNING id`,
      [messageId],
    ),
  );

  const firstA = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: a.versionId,
    createdAt: at(-5, 10),
  });
  const redoA = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: a.versionId,
    createdAt: at(-4, 10),
  });
  const deletedTaskAttempt = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: deletedTask,
    questionVersionId: a.versionId,
    createdAt: at(-5, 11),
  });
  const invalidatedQuestionAttempt = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: invalidated.versionId,
    createdAt: at(-5, 12),
  });
  const invalidatedMessageAttempt = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: messageInvalidated.versionId,
    messageVersionId,
    createdAt: at(-5, 13),
  });
  const lifetimeFirstOutside = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: b.versionId,
    createdAt: at(-60, 10),
  });
  const redoB = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: b.versionId,
    createdAt: at(-3, 10),
  });
  const revisionBAttempt = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: c.versionId,
    createdAt: at(-4, 11),
  });
  const pendingAttempt = await createAttempt(db, {
    studentId: studentA.studentId,
    taskId: taskA,
    questionVersionId: a.versionId,
    createdAt: at(-2, 10),
  });

  const firstAOld = await createAssessment(db, {
    attemptId: firstA,
    correctness: "incorrect",
    verification: "verified",
    createdAt: at(-5, 11),
  });
  const firstALatest = await createAssessment(db, {
    attemptId: firstA,
    correctness: "correct",
    verification: "verified",
    createdAt: at(-5, 12),
  });
  const redoAAssessment = await createAssessment(db, {
    attemptId: redoA,
    correctness: "incorrect",
    verification: "verified",
    createdAt: at(-4, 11),
  });
  await createAssessment(db, {
    attemptId: invalidatedQuestionAttempt,
    correctness: "correct",
    verification: "verified",
    createdAt: at(-5, 13),
  });
  await createAssessment(db, {
    attemptId: deletedTaskAttempt,
    correctness: "correct",
    verification: "verified",
    createdAt: at(-5, 12),
  });
  const outsideAssessment = await createAssessment(db, {
    attemptId: lifetimeFirstOutside,
    correctness: "correct",
    verification: "verified",
    createdAt: at(-60, 11),
  });
  const redoBAssessment = await createAssessment(db, {
    attemptId: redoB,
    correctness: "incorrect",
    verification: "verified",
    createdAt: at(-3, 11),
  });
  await createAssessment(db, {
    attemptId: revisionBAttempt,
    correctness: "incorrect",
    verification: "verified",
    createdAt: at(-4, 12),
  });
  const pendingAssessment = await createAssessment(db, {
    attemptId: pendingAttempt,
    correctness: "unknown",
    verification: "pending",
    createdAt: at(-2, 11),
  });

  await db.pool.query(
    `INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason)
     VALUES($1,$2,'题目作废'),($1,$3,'消息作废')`,
    [studentA.studentId, invalidated.versionId, messageVersionId],
  );

  await db.pool.query(
    `INSERT INTO student_mistakes(student_id,question_id,original_attempt_id,status,created_at)
     VALUES($1,$2,$3,'pending_correction',$4),($1,$5,$6,'pending_correction',$4)`,
    [
      studentA.studentId,
      a.questionId,
      firstA,
      at(-4, 9),
      c.questionId,
      revisionBAttempt,
    ],
  );

  // A1 的旧核验已被最新核验取代：只有最新核验派生的观测有效
  await db.pool.query(
    `INSERT INTO knowledge_observations(student_id,revision_id,assessment_id,knowledge_point,fact,created_at)
     VALUES($1,$2,$3,'分数','{"kind":"stale"}',$4),
            ($1,$2,$5,'分数','{"kind":"current"}',$6),
            ($1,$2,NULL,'分数','{"kind":"unbound"}',$4)`,
    [
      studentA.studentId,
      revisionA,
      firstAOld,
      at(-5, 13),
      firstALatest,
      at(-5, 14),
    ],
  );
  await db.pool.query(
    `INSERT INTO knowledge_observations(student_id,revision_id,assessment_id,knowledge_point,fact,created_at)
     VALUES($1,$2,$3,'失效','{"kind":"invalidated"}',$4)`,
    [
      studentA.studentId,
      revisionA,
      (
        await db.pool.query<{ id: string }>(
          `SELECT id FROM assessments WHERE attempt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
          [invalidatedQuestionAttempt],
        )
      ).rows[0]!.id,
      at(-5, 14),
    ],
  );

  const materialFileId = await id(
    db.pool.query(
      `INSERT INTO files(owner_id,purpose,name,content_type,size,object_key)
       VALUES($1,'material','作业.jpg','image/jpeg',100,$2) RETURNING id`,
      [admin.userId, crypto.randomUUID()],
    ),
  );
  const material = await id(
    db.pool.query(
      `INSERT INTO materials(student_id,file_id,revision_id,type,status,created_at)
       VALUES($1,$2,$3,'homework','ready',$4) RETURNING id`,
      [studentA.studentId, materialFileId, revisionA, at(-5, 8)],
    ),
  );
  const extraction = await id(
    db.pool.query(
      `INSERT INTO extractions(material_id,version_no,payload,model,prompt_version)
       VALUES($1,1,'{}','test','v1') RETURNING id`,
      [material],
    ),
  );
  const pageOne = await id(
    db.pool.query(
      `INSERT INTO material_pages(material_id,page_index,text,status)
       VALUES($1,0,'第一页','ready') RETURNING id`,
      [material],
    ),
  );
  const pageTwo = await id(
    db.pool.query(
      `INSERT INTO material_pages(material_id,page_index,text,status)
       VALUES($1,1,'第二页','ready') RETURNING id`,
      [material],
    ),
  );
  await db.pool.query(
    `INSERT INTO question_sources(question_version_id,extraction_id,page_id,bbox)
     VALUES($1,$2,$3,'{}'),($1,$2,$4,'{}')`,
    [a.versionId, extraction, pageOne, pageTwo],
  );

  return {
    today,
    revisionA,
    revisionB,
    taskA,
    deletedTask,
    questionA: a.questionId,
    questionVersionA: a.versionId,
    questionB: b.questionId,
    questionVersionB: b.versionId,
    questionC: c.questionId,
    questionVersionC: c.versionId,
    questionInvalidated: invalidated.questionId,
    questionVersionInvalidated: invalidated.versionId,
    questionMessageInvalidated: messageInvalidated.questionId,
    questionVersionMessageInvalidated: messageInvalidated.versionId,
    material,
    attemptIds: {
      firstA,
      redoA,
      deletedTask: deletedTaskAttempt,
      invalidatedQuestion: invalidatedQuestionAttempt,
      invalidatedMessage: invalidatedMessageAttempt,
      lifetimeFirstOutside,
      redoB,
      revisionB: revisionBAttempt,
      pending: pendingAttempt,
    },
    assessmentIds: {
      firstAOld,
      firstALatest,
      redoA: redoAAssessment,
      lifetimeFirstOutside: outsideAssessment,
      redoB: redoBAssessment,
      pending: pendingAssessment,
      superseded: firstAOld,
    },
  };
}
