import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import {
  adminInsightCookie,
  studentInsightsFixture,
  type StudentInsightsFixture,
} from "../helpers/student-insights.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { requireAdminInsightScope } from "../../apps/server/src/modules/student-insights/policy.js";
import {
  insightRouteManifest,
  STUDENT_INSIGHT_PREFIX,
} from "../../apps/server/src/modules/student-insights/routes.js";

function build(fixture: StudentInsightsFixture) {
  return buildApp({
    database: fixture.db,
    config: loadConfig({ NODE_ENV: "test" }),
  });
}

it("grants admins read scope without student access rows", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const scope = await requireAdminInsightScope(
      db,
      fixture.admin,
      fixture.studentA.studentId,
    );
    expect(scope).toEqual({
      actor: fixture.admin,
      studentId: fixture.studentA.studentId,
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM student_access WHERE user_id=$1",
          [fixture.admin.userId],
        )
      ).rows[0].n,
    ).toBe(0);
  }));

it("rejects student actors, malformed ids and unknown students", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    await expect(
      requireAdminInsightScope(
        db,
        fixture.studentA.actor,
        fixture.studentA.studentId,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(
      requireAdminInsightScope(db, fixture.admin, "not-a-uuid"),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 422 });
    await expect(
      requireAdminInsightScope(db, fixture.admin, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  }));

it("keeps every admin insight endpoint behind session and admin checks", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const app = build(fixture);
    try {
      for (const route of insightRouteManifest()) {
        const url = `${STUDENT_INSIGHT_PREFIX}${route.path.replace(":studentId", fixture.studentA.studentId)}`;
        const anonymous = await app.inject({ method: route.method, url });
        expect(anonymous.statusCode).toBe(401);
        const asStudent = await app.inject({
          method: route.method,
          url,
          headers: fixture.cookie(fixture.studentA.token),
        });
        expect(asStudent.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  }));

it("rejects admins and students from ordinary student endpoints", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const app = build(fixture);
    try {
      const asAdmin = await app.inject({
        method: "GET",
        url: `/api/tasks?studentId=${fixture.studentA.studentId}`,
        headers: adminInsightCookie(fixture),
      });
      expect(asAdmin.statusCode).toBe(404);
      expect(asAdmin.json().error.message).toBe("学习记录不存在");

      const asOtherStudent = await app.inject({
        method: "GET",
        url: `/api/tasks?studentId=${fixture.studentA.studentId}`,
        headers: fixture.cookie(fixture.studentB.token),
      });
      expect(asOtherStudent.statusCode).toBe(200);

      const viewerOfOwn = await app.inject({
        method: "GET",
        url: `/api/tasks?studentId=${fixture.studentB.studentId}`,
        headers: fixture.cookie(fixture.studentA.token),
      });
      expect(viewerOfOwn.statusCode).toBe(404);

      const write = await app.inject({
        method: "POST",
        url: `/api/learning/selections?studentId=${fixture.studentA.studentId}`,
        headers: {
          ...adminInsightCookie(fixture),
          origin: "http://localhost:5173",
        },
        payload: { revisionId: crypto.randomUUID() },
      });
      expect(write.statusCode).toBe(404);

      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM student_access WHERE user_id=$1",
            [fixture.admin.userId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  }));

it("reads an empty student profile through the admin scope", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const scope = await requireAdminInsightScope(
      db,
      fixture.admin,
      fixture.emptyStudentId,
    );
    expect(scope.studentId).toBe(fixture.emptyStudentId);
    await expect(
      requireAdminInsightScope(
        db,
        fixture.secondAdmin,
        fixture.emptyStudentId,
      ),
    ).resolves.toBeTruthy();
  }));
