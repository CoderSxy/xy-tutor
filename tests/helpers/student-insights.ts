import type { Actor } from "../../packages/contracts/src/domain.js";
import type { Database } from "../../packages/db/src/client.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";

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
