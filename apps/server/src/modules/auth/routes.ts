import type { FastifyInstance, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AppConfig } from "../../config.js";
import { AuthService, type AuthSession } from "./service.js";
import { requireAdmin } from "./policy.js";
declare module "fastify" {
  interface FastifyRequest {
    authSession?: AuthSession;
  }
}
export function requireSession(request: FastifyRequest): AuthSession {
  if (!request.authSession)
    throw new AppError("UNAUTHENTICATED", 401, "请先登录");
  return request.authSession;
}
const id = z.object({ id: z.uuid() });
export async function registerAuth(
  app: FastifyInstance,
  s: AuthService,
  config: AppConfig,
): Promise<void> {
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", async (req) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      throw new AppError("FORBIDDEN", 403, "请求来源不允许");
    const token = req.cookies.xy_session;
    if (token) req.authSession = (await s.resolveSession(token)) ?? undefined;
  });
  app.post("/api/auth/activate", async (req) => s.activate(req.body));
  app.post("/api/auth/reset", async (req) => {
    await s.resetPassword(req.body);
    return { ok: true };
  });
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const result = await s.login(req.body);
      reply.setCookie("xy_session", result.sessionToken, {
        httpOnly: true,
        secure: config.env === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 7 * 86400,
      });
      return { actor: result.actor, studentId: result.studentId };
    },
  );
  app.get("/api/auth/session", async (req) => requireSession(req));
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.cookies.xy_session) await s.logout(req.cookies.xy_session);
    reply.clearCookie("xy_session", { path: "/" });
    return { ok: true };
  });
  app.post("/api/admin/invitations", async (req) =>
    s.invite(requireSession(req).actor, req.body),
  );
  app.get("/api/admin/accounts", async (req) => {
    requireAdmin(requireSession(req).actor);
    return s.listAccounts();
  });
  app.post("/api/admin/password-resets", async (req) => {
    const body = z.object({ userId: z.uuid() }).strict().parse(req.body);
    return s.issuePasswordReset(requireSession(req).actor, body);
  });
  app.get("/api/students", async (req) =>
    s.listStudents(requireSession(req).actor),
  );
  app.get("/api/students/:id", async (req) =>
    s.getProfile(
      await s.requireStudentAccess(
        requireSession(req).actor,
        id.parse(req.params).id,
      ),
    ),
  );
  app.patch("/api/students/:id", async (req) => {
    await s.updateProfile(
      await s.requireStudentAccess(
        requireSession(req).actor,
        id.parse(req.params).id,
      ),
      req.body,
    );
    return { ok: true };
  });
  app.get("/api/students/:id/access", async (req) =>
    s.listAccess(
      await s.requireStudentAccess(
        requireSession(req).actor,
        id.parse(req.params).id,
      ),
    ),
  );
  app.post("/api/students/:id/access", async (req) => {
    await s.grantAccess(
      await s.requireStudentAccess(
        requireSession(req).actor,
        id.parse(req.params).id,
      ),
      z.object({ login: z.string() }).strict().parse(req.body),
    );
    return { ok: true };
  });
  app.delete("/api/students/:id/access", async (req) => {
    await s.revokeAccess(
      await s.requireStudentAccess(
        requireSession(req).actor,
        id.parse(req.params).id,
      ),
      z.object({ userId: z.uuid() }).strict().parse(req.body),
    );
    return { ok: true };
  });
}
