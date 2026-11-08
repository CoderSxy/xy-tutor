import type { FastifyInstance } from "fastify";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import { z } from "zod";
import { scopeForRequest } from "../learning/routes.js";
import type { RunService } from "./runs.js";
export function registerRuns(
  app: FastifyInstance,
  s: RunService,
  available: () => boolean = () => true,
) {
  const id = z.object({ id: z.uuid() });
  app.post("/api/conversations/:id/runs", async (req) => {
    if (!available())
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        503,
        "模型尚未配置，请联系管理员",
      );
    const body = z
      .object({
        requestKey: z.string(),
        message: z.string(),
        questionVersionId: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    return s.submit(await scopeForRequest(s.auth, req), {
      ...body,
      conversationId: id.parse(req.params).id,
    });
  });
  app.get("/api/runs/:id", async (req) =>
    s.get(await scopeForRequest(s.auth, req), id.parse(req.params).id),
  );
  app.post("/api/runs/:id/cancel", async (req) => {
    await s.cancel(await scopeForRequest(s.auth, req), id.parse(req.params).id);
    return { ok: true };
  });
  app.get("/api/runs/:id/events", async (req, reply) => {
    const scope = await scopeForRequest(s.auth, req);
    const runId = id.parse(req.params).id;
    await s.get(scope, runId);
    const query = z
      .object({ after: z.string().optional() })
      .passthrough()
      .parse(req.query);
    let cursor = query.after ?? String(req.headers["last-event-id"] ?? "0");
    await s.events.readAfter(scope, runId, cursor);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    reply.raw.on("close", () => {
      closed = true;
    });
    let lastHeartbeat = Date.now();
    try {
      while (!closed) {
        const events = await s.events.readAfter(scope, runId, cursor);
        for (const event of events) {
          if (closed) break;
          reply.raw.write(
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.id;
        }
        const run = await s.get(scope, runId);
        if (!["queued", "running"].includes(run.status) && events.length < 200)
          break;
        if (Date.now() - lastHeartbeat > 10000) {
          reply.raw.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch {
      if (!closed)
        reply.raw.write(
          'event: failed\ndata: {"message":"连接已中断，请重新连接"}\n\n',
        );
    } finally {
      reply.raw.end();
    }
  });
}
