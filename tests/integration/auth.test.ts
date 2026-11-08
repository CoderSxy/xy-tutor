import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
const password = "a-strong-test-password";
it("consumes invitation once and stores only its hash", async () =>
  withTestDb(async (db) => {
    const service = new AuthService(db);
    const admin = await service.createAdmin("developer", password);
    const inv = await service.invite(admin, { login: "student" });
    const student = await service.activate({
      token: inv.activationToken,
      password,
    });
    expect(student.studentId).toBeTruthy();
    await expect(
      service.activate({ token: inv.activationToken, password }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const rows = await db.pool.query("SELECT token_hash FROM invitations");
    expect(rows.rows[0].token_hash).not.toBe(inv.activationToken);
    const login = await service.login({ login: "student", password });
    expect((await service.resolveSession(login.sessionToken))?.actor.role).toBe(
      "student",
    );
  }));
it("rejects expired invitations", async () =>
  withTestDb(async (db) => {
    let now = new Date("2026-11-08T00:00:00Z");
    const s = new AuthService(db, { now: () => now });
    const admin = await s.createAdmin("admin", password);
    const inv = await s.invite(admin, { login: "student" });
    now = new Date("2026-11-10T00:00:00Z");
    await expect(
      s.activate({ token: inv.activationToken, password }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  }));
it("has no implicit admin private access and audits grant and revoke", async () =>
  withTestDb(async (db) => {
    const s = new AuthService(db);
    const admin = await s.createAdmin("admin", password);
    const inv = await s.invite(admin, { login: "student" });
    const student = await s.activate({ token: inv.activationToken, password });
    await expect(
      s.requireStudentAccess(admin, student.studentId!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const owner = await s.requireStudentAccess(
      { userId: student.userId, role: "student" },
      student.studentId!,
    );
    await s.grantAccess(owner, { login: "admin" });
    expect(
      (await s.requireStudentAccess(admin, student.studentId!)).studentId,
    ).toBe(student.studentId);
    await s.revokeAccess(owner, { userId: admin.userId });
    await expect(
      s.requireStudentAccess(admin, student.studentId!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await db.pool.query(
          "SELECT action FROM audit_events WHERE action LIKE 'access.%' ORDER BY created_at",
        )
      ).rows.map((x) => x.action),
    ).toEqual(["access.grant", "access.revoke"]);
  }));
it("password reset invalidates sessions and rejects reused reset tokens", async () =>
  withTestDb(async (db) => {
    const s = new AuthService(db);
    const admin = await s.createAdmin("admin", password);
    const inv = await s.invite(admin, { login: "student" });
    const student = await s.activate({ token: inv.activationToken, password });
    const login = await s.login({ login: "student", password });
    const reset = await s.issuePasswordReset(admin, { userId: student.userId });
    await s.resetPassword({
      token: reset.resetToken,
      password: "a-new-strong-password",
    });
    expect(await s.resolveSession(login.sessionToken)).toBeNull();
    await expect(
      s.resetPassword({ token: reset.resetToken, password }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  }));
it("allows profile preference changes without role escalation", async () =>
  withTestDb(async (db) => {
    const s = new AuthService(db);
    const admin = await s.createAdmin("admin", password);
    const inv = await s.invite(admin, { login: "student" });
    const student = await s.activate({ token: inv.activationToken, password });
    const scope = await s.requireStudentAccess(
      { userId: student.userId, role: "student" },
      student.studentId!,
    );
    await s.updateProfile(scope, {
      displayName: "小明",
      preferences: { explanation: "分步" },
    });
    expect((await s.getProfile(scope)).displayName).toBe("小明");
    await expect(
      s.updateProfile(scope, { role: "admin" } as never),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  }));
it("rejects cross-origin writes and rate limits repeated login failures", async () =>
  withTestDb(async (db) => {
    const app = buildApp({
      database: db,
      config: loadConfig({ NODE_ENV: "test" }),
    });
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "https://foreign.example" },
        payload: { login: "x", password },
      });
      expect(bad.statusCode).toBe(403);
      let status = 0;
      for (let i = 0; i < 11; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: "http://localhost:5173" },
          payload: { login: "unknown", password },
        });
        status = r.statusCode;
      }
      expect(status).toBe(429);
    } finally {
      await app.close();
    }
  }));
