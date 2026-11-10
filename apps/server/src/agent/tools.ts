import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Database } from "../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import { searchInput } from "../../../../packages/contracts/src/knowledge-base.js";
import type { CatalogService } from "../modules/catalog/service.js";
import { searchPublishedKnowledge } from "../modules/knowledge-base/search.js";
import { nextActions } from "./prompts.js";
export type TeachingServices = {
  practice?: (
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ) => Promise<unknown>;
  assess?: (
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ) => Promise<unknown>;
  mistakes?: (scope: StudentScope, input: unknown) => Promise<unknown>;
};
export function createTeachingTools(
  bound: {
    scope: StudentScope;
    taskId: string | null;
    runId: string;
    revisionId?: string | null;
  },
  db: Database,
  catalog: CatalogService,
  services: TeachingServices = {},
): AgentTool<object, unknown>[] {
  const empty = z.object({}).strict();
  const tool = (
    name: string,
    label: string,
    schema: z.ZodType,
    run: (params: unknown) => Promise<unknown>,
  ): AgentTool<object, unknown> => ({
    name,
    label,
    description: label,
    parameters: z.toJSONSchema(schema),
    replay: "never",
    async execute(_callId, params, signal) {
      signal?.throwIfAborted();
      await catalog.auth.requireStudentAccess(
        bound.scope.actor,
        bound.scope.studentId,
      );
      const live = (
        await db.pool.query(
          "SELECT 1 FROM agent_runs WHERE id=$1 AND status IN ('queued','running')",
          [bound.runId],
        )
      ).rowCount;
      if (!live) throw Error("RUN_NOT_ACTIVE");
      try {
        const result = await run(schema.parse(params));
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "操作未完成：资料不足、参数不符或功能尚未配置，请说明情况并继续可用学习入口。",
            },
          ],
          details: { status: "unavailable" },
          isError: true,
        };
      }
    },
  });
  return [
    tool("get_student_context", "查看当前学生学习进度", empty, async () => ({
      profile: await catalog.auth.getProfile(bound.scope),
      task: bound.taskId
        ? (
            await db.pool.query(
              "SELECT kind,status FROM learning_tasks WHERE id=$1 AND student_id=$2",
              [bound.taskId, bound.scope.studentId],
            )
          ).rows[0]
        : null,
      attachments: (
        await db.pool.query(
          'SELECT f.id AS "fileId",f.name,f.content_type AS "mimeType",f.width,f.height,ma.position FROM agent_runs r JOIN message_attachments ma ON ma.message_version_id=r.input_version_id JOIN files f ON f.id=ma.file_id WHERE r.id=$1 ORDER BY ma.position',
          [bound.runId],
        )
      ).rows,
    })),
    tool("search_knowledge", "检索已发布知识点", searchInput, async (p) => {
      const items = await searchPublishedKnowledge(
        db,
        searchInput.parse(p),
      );
      return {
        status: items.length ? "found" : "insufficient_evidence",
        items,
      };
    }),
    tool(
      "get_material_question",
      "读取当前学生已确认题目",
      z.object({ questionVersionId: z.uuid() }).strict(),
      async (p) => {
        const id = z
          .object({ questionVersionId: z.uuid() })
          .parse(p).questionVersionId;
        const row = (
          await db.pool.query(
            "SELECT v.id,v.stem,v.knowledge_point FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND q.student_id=$2",
            [id, bound.scope.studentId],
          )
        ).rows[0];
        if (!row) throw Error("NOT_FOUND");
        return row;
      },
    ),
    tool(
      "get_mistake_history",
      "查询当前学生相关错题",
      z.object({ questionId: z.uuid().optional() }).strict(),
      async (p) => {
        if (!services.mistakes) throw Error("NOT_CONFIGURED");
        return services.mistakes(bound.scope, p);
      },
    ),
    tool(
      "propose_practice",
      "提交一道待核验练习",
      z
        .object({
          stem: z.string().min(1).max(20000),
          referenceAnswer: z.string().min(1).max(10000),
          knowledgePoint: z.string().max(200),
          role: z.enum(["variant", "diagnostic", "original"]),
          answerType: z.enum(["number", "choice", "worked", "open"]).optional(),
          requiresWorking: z.boolean().optional(),
          sourceQuestionId: z.uuid().optional(),
        })
        .strict(),
      async (p) => {
        if (!bound.taskId || !services.practice) throw Error("NOT_CONFIGURED");
        return services.practice(bound.scope, bound.taskId, p);
      },
    ),
    tool(
      "submit_assessment",
      "提交学生作答的候选评估",
      z
        .object({
          attemptId: z.uuid(),
          correctness: z.enum(["correct", "incorrect", "uncertain"]),
          reason: z.string().max(2000),
          referenceIds: z.array(z.uuid()).max(20),
        })
        .strict(),
      async (p) => {
        if (!bound.taskId || !services.assess) throw Error("NOT_CONFIGURED");
        return services.assess(bound.scope, bound.taskId, p);
      },
    ),
    tool(
      "propose_next_actions",
      "建议下一步学习操作",
      z.object({ actionIds: z.array(z.string()).max(6) }).strict(),
      async (p) => {
        const { actionIds } = z
          .object({ actionIds: z.array(z.string()) })
          .parse(p);
        return nextActions.filter((a) => actionIds.includes(a.id));
      },
    ),
  ];
}
