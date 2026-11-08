import type { PoolClient } from "pg";
import { z } from "zod";
import type {
  Actor,
  StudentScope,
} from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { Clock } from "../../infra/clock.js";
import { systemClock } from "../../infra/clock.js";
import { requireAdmin } from "./policy.js";
import {
  credentialInput,
  inviteInput,
  loginInput,
  loginName,
  password,
  profileInput,
} from "./contracts.js";
import {
  hashPassword,
  hashToken,
  newToken,
  verifyPassword,
} from "./passwords.js";
export type AuthSession = { actor: Actor; studentId?: string };
export class AuthService {
  constructor(
    private c: Database,
    private clock: Clock = systemClock,
  ) {}
  async createAdmin(login: string, secret: string): Promise<Actor> {
    const name = loginName.parse(login);
    password.parse(secret);
    const hash = await hashPassword(secret);
    const r = await this.c.pool.query(
      "INSERT INTO users(login,password_hash,role) VALUES($1,$2,'admin') RETURNING id",
      [name, hash],
    );
    return { userId: r.rows[0].id, role: "admin" };
  }
  private async audit(
    tx: PoolClient,
    actor: Actor,
    action: string,
    details: unknown,
    studentId?: string,
  ) {
    await tx.query(
      "INSERT INTO audit_events(actor_id,action,details,student_id) VALUES($1,$2,$3,$4)",
      [actor.userId, action, JSON.stringify(details), studentId ?? null],
    );
  }
  async invite(
    actor: Actor,
    input: unknown,
  ): Promise<{ activationToken: string }> {
    requireAdmin(actor);
    const v = inviteInput.parse(input);
    const token = newToken();
    await inTransaction(this.c, async (tx) => {
      if (
        (await tx.query("SELECT id FROM users WHERE login=$1", [v.login]))
          .rowCount
      )
        throw new AppError("CONFLICT", 409, "账号已存在");
      await tx.query(
        "INSERT INTO invitations(login,role,token_hash,kind,expires_at) VALUES($1,$2,$3,'activation',$4)",
        [
          v.login,
          v.role,
          hashToken(token),
          new Date(this.clock.now().getTime() + 86400000),
        ],
      );
      await this.audit(tx, actor, "account.invite", {
        login: v.login,
        role: v.role,
      });
    });
    return { activationToken: token };
  }
  async activate(
    input: unknown,
  ): Promise<{ userId: string; studentId?: string }> {
    const v = credentialInput.parse(input);
    const hash = await hashPassword(v.password);
    return inTransaction(this.c, async (tx) => {
      const r = await tx.query(
        "SELECT * FROM invitations WHERE token_hash=$1 AND kind='activation' AND consumed_at IS NULL AND expires_at>$2 FOR UPDATE",
        [hashToken(v.token), this.clock.now()],
      );
      const inv = r.rows[0];
      if (!inv) throw new AppError("VALIDATION", 422, "激活凭据无效或已过期");
      const user = (
        await tx.query(
          "INSERT INTO users(login,password_hash,role) VALUES($1,$2,$3) RETURNING id",
          [inv.login, hash, inv.role],
        )
      ).rows[0];
      let studentId: string | undefined;
      if (inv.role === "student") {
        studentId = (
          await tx.query(
            "INSERT INTO student_profiles(display_name) VALUES($1) RETURNING id",
            [inv.login],
          )
        ).rows[0].id;
        await tx.query(
          "INSERT INTO student_access(student_id,user_id,permission) VALUES($1,$2,'owner')",
          [studentId, user.id],
        );
      }
      await tx.query("UPDATE invitations SET consumed_at=$1 WHERE id=$2", [
        this.clock.now(),
        inv.id,
      ]);
      return { userId: user.id, studentId };
    });
  }
  async login(input: unknown): Promise<AuthSession & { sessionToken: string }> {
    const v = loginInput.parse(input);
    const row = (
      await this.c.pool.query("SELECT * FROM users WHERE login=$1", [v.login])
    ).rows[0];
    const fallback = "00000000000000000000000000000000:" + "00".repeat(64);
    if (
      !(await verifyPassword(v.password, row?.password_hash ?? fallback)) ||
      !row
    )
      throw new AppError("UNAUTHENTICATED", 401, "账号或密码不正确");
    const token = newToken();
    await this.c.pool.query(
      "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
      [
        row.id,
        hashToken(token),
        new Date(this.clock.now().getTime() + 7 * 86400000),
      ],
    );
    return {
      ...(await this.sessionFor(row.id, row.role)),
      sessionToken: token,
    };
  }
  private async sessionFor(
    id: string,
    role: Actor["role"],
  ): Promise<AuthSession> {
    const student = (
      await this.c.pool.query(
        "SELECT student_id FROM student_access WHERE user_id=$1 AND permission='owner' LIMIT 1",
        [id],
      )
    ).rows[0];
    return { actor: { userId: id, role }, studentId: student?.student_id };
  }
  async resolveSession(token: string): Promise<AuthSession | null> {
    const r = await this.c.pool.query(
      "SELECT u.id,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2",
      [hashToken(token), this.clock.now()],
    );
    const row = r.rows[0];
    return row ? this.sessionFor(row.id, row.role) : null;
  }
  async logout(token: string): Promise<void> {
    await this.c.pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
      hashToken(token),
    ]);
  }
  async requireStudentAccess(
    actor: Actor,
    studentId: string,
  ): Promise<StudentScope> {
    z.uuid().parse(studentId);
    const r = await this.c.pool.query(
      "SELECT permission FROM student_access WHERE student_id=$1 AND user_id=$2",
      [studentId, actor.userId],
    );
    if (!r.rowCount) throw new AppError("NOT_FOUND", 404, "学习记录不存在");
    return { actor, studentId };
  }
  private async requireOwner(scope: StudentScope): Promise<void> {
    const r = await this.c.pool.query(
      "SELECT 1 FROM student_access WHERE student_id=$1 AND user_id=$2 AND permission='owner'",
      [scope.studentId, scope.actor.userId],
    );
    if (!r.rowCount) throw new AppError("FORBIDDEN", 403, "需要学生所有者授权");
  }
  async grantAccess(
    scope: StudentScope,
    input: { login: string },
  ): Promise<void> {
    await this.requireOwner(scope);
    const login = loginName.parse(input.login);
    await inTransaction(this.c, async (tx) => {
      const user = (
        await tx.query("SELECT id FROM users WHERE login=$1", [login])
      ).rows[0];
      if (!user) throw new AppError("NOT_FOUND", 404, "账号不存在");
      await tx.query(
        "INSERT INTO student_access(student_id,user_id,permission) VALUES($1,$2,'viewer') ON CONFLICT DO NOTHING",
        [scope.studentId, user.id],
      );
      await this.audit(
        tx,
        scope.actor,
        "access.grant",
        { userId: user.id },
        scope.studentId,
      );
    });
  }
  async revokeAccess(
    scope: StudentScope,
    input: { userId: string },
  ): Promise<void> {
    await this.requireOwner(scope);
    z.uuid().parse(input.userId);
    if (input.userId === scope.actor.userId)
      throw new AppError("VALIDATION", 422, "不能撤销自己的所有权");
    await inTransaction(this.c, async (tx) => {
      await tx.query(
        "DELETE FROM student_access WHERE student_id=$1 AND user_id=$2 AND permission<>'owner'",
        [scope.studentId, input.userId],
      );
      await this.audit(
        tx,
        scope.actor,
        "access.revoke",
        input,
        scope.studentId,
      );
    });
  }
  async issuePasswordReset(
    actor: Actor,
    input: { userId: string },
  ): Promise<{ resetToken: string }> {
    requireAdmin(actor);
    z.uuid().parse(input.userId);
    const token = newToken();
    await inTransaction(this.c, async (tx) => {
      const user = (
        await tx.query("SELECT login,role FROM users WHERE id=$1", [
          input.userId,
        ])
      ).rows[0];
      if (!user) throw new AppError("NOT_FOUND", 404, "账号不存在");
      await tx.query(
        "INSERT INTO invitations(login,role,token_hash,kind,user_id,expires_at) VALUES($1,$2,$3,'reset',$4,$5)",
        [
          user.login,
          user.role,
          hashToken(token),
          input.userId,
          new Date(this.clock.now().getTime() + 1800000),
        ],
      );
      await this.audit(tx, actor, "account.reset_issued", input);
    });
    return { resetToken: token };
  }
  async resetPassword(input: unknown): Promise<void> {
    const v = credentialInput.parse(input);
    const hash = await hashPassword(v.password);
    await inTransaction(this.c, async (tx) => {
      const inv = (
        await tx.query(
          "SELECT * FROM invitations WHERE token_hash=$1 AND kind='reset' AND consumed_at IS NULL AND expires_at>$2 FOR UPDATE",
          [hashToken(v.token), this.clock.now()],
        )
      ).rows[0];
      if (!inv) throw new AppError("VALIDATION", 422, "重置凭据无效或已过期");
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        hash,
        inv.user_id,
      ]);
      await tx.query("DELETE FROM auth_sessions WHERE user_id=$1", [
        inv.user_id,
      ]);
      await tx.query(
        "UPDATE invitations SET consumed_at=$1 WHERE user_id=$2 AND kind='reset' AND consumed_at IS NULL",
        [this.clock.now(), inv.user_id],
      );
    });
  }
  async getProfile(
    scope: StudentScope,
  ): Promise<{
    id: string;
    displayName: string;
    timezone: string;
    preferences: Record<string, string>;
  }> {
    await this.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.c.pool.query("SELECT * FROM student_profiles WHERE id=$1", [
        scope.studentId,
      ])
    ).rows[0];
    return {
      id: row.id,
      displayName: row.display_name,
      timezone: row.timezone,
      preferences: row.preferences,
    };
  }
  async updateProfile(scope: StudentScope, input: unknown): Promise<void> {
    await this.requireOwner(scope);
    const v = profileInput.safeParse(input);
    if (!v.success) throw new AppError("VALIDATION", 422, "资料格式不正确");
    await this.c.pool.query(
      "UPDATE student_profiles SET display_name=COALESCE($1,display_name),preferences=COALESCE($2,preferences) WHERE id=$3",
      [
        v.data.displayName ?? null,
        v.data.preferences ? JSON.stringify(v.data.preferences) : null,
        scope.studentId,
      ],
    );
  }
  async listAccounts(): Promise<{ id: string; login: string; role: string }[]> {
    return (
      await this.c.pool.query(
        "SELECT id,login,role FROM users ORDER BY created_at",
      )
    ).rows;
  }
  async listAccess(
    scope: StudentScope,
  ): Promise<{ userId: string; login: string; permission: string }[]> {
    await this.requireOwner(scope);
    return (
      await this.c.pool.query(
        'SELECT u.id AS "userId",u.login,a.permission FROM student_access a JOIN users u ON u.id=a.user_id WHERE a.student_id=$1',
        [scope.studentId],
      )
    ).rows;
  }
}
