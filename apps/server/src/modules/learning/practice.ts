import { z } from "zod";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import type { ModelGateway } from "../../agent/provider.js";
import type { TaskService } from "./tasks.js";
import { equivalent } from "./verifier.js";
export const referenceSchema = z.object({
  referenceAnswer: z.string().min(1).max(10000),
  answerType: z.enum(["number", "choice", "worked", "open"]),
  requiresWorking: z.boolean(),
  reason: z.string().max(3000),
});
export type Reference = z.infer<typeof referenceSchema>;
export function parseModelJson(text: string): unknown {
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}
export async function checkReference(
  gateway: ModelGateway,
  stem: string,
  reference: Reference,
  signal?: AbortSignal,
): Promise<{ verified: boolean; independent: Reference }> {
  const r = await gateway.complete(
    {
      context: {
        systemPrompt:
          '独立解题并检查题目是否明确可答。不要参考其他判断。仅输出JSON：{referenceAnswer,answerType:"number"|"choice"|"worked"|"open",requiresWorking:boolean,reason:string}。解题过程题不能标为只需最终值。',
        messages: [{ role: "user", timestamp: Date.now(), content: stem }],
      },
    },
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  );
  const other = referenceSchema.parse(parseModelJson(r.text));
  const comparable =
    reference.answerType === "number" || reference.answerType === "choice";
  const same = comparable
    ? equivalent(
        reference.referenceAnswer,
        other.referenceAnswer,
        reference.answerType as "number" | "choice",
      )
    : reference.referenceAnswer.trim() === other.referenceAnswer.trim();
  return {
    verified:
      !!same &&
      other.answerType === reference.answerType &&
      other.requiresWorking === reference.requiresWorking &&
      reference.answerType !== "open",
    independent: other,
  };
}
export class PracticeService {
  constructor(
    private db: Database,
    private tasks: TaskService,
    private gateway?: ModelGateway,
  ) {}
  async propose(
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ): Promise<{
    status: "verified" | "pending";
    questionVersionId?: string;
    stem?: string;
    reason?: string;
  }> {
    const task = await this.tasks.resume(scope, taskId);
    const shape = z
      .object({
        stem: z.string().min(1).max(20000),
        referenceAnswer: z.string().min(1).max(10000),
        knowledgePoint: z.string().max(200),
        role: z.enum(["variant", "diagnostic", "original"]),
        answerType: z.enum(["number", "choice", "worked", "open"]).optional(),
        requiresWorking: z.boolean().optional(),
        sourceQuestionId: z.uuid().optional(),
      })
      .strict();
    let v = shape.parse(input);
    if (!this.gateway) return { status: "pending", reason: "核验模型尚未配置" };
    if (
      task.kind === "daily_practice" &&
      (await this.tasks.items(scope, taskId)).length >= 5
    )
      return { status: "pending", reason: "本次每日5练已安排5题" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const reference: Reference = {
        referenceAnswer: v.referenceAnswer,
        answerType: v.answerType ?? "worked",
        requiresWorking: v.requiresWorking ?? true,
        reason: "Agent候选参考答案",
      };
      try {
        const checked = await checkReference(this.gateway, v.stem, reference);
        if (checked.verified) {
          const q = await this.tasks.addQuestion(scope, taskId, {
            stem: v.stem,
            referenceAnswer: v.referenceAnswer,
            knowledgePoint: v.knowledgePoint,
            role: v.role,
          });
          await this.db.pool.query(
            "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,$2,$3,$4,'verified',$5)",
            [
              q.questionVersionId,
              reference.referenceAnswer,
              reference.answerType,
              reference.requiresWorking,
              JSON.stringify({
                candidate: reference,
                independent: checked.independent,
                model: this.gateway.runtime.model.id,
              }),
            ],
          );
          await this.db.pool.query(
            "UPDATE question_versions SET verification='verified' WHERE id=$1",
            [q.questionVersionId],
          );
          if (v.role === "variant" && v.sourceQuestionId) {
            const parent = (
              await this.db.pool.query(
                "SELECT q.id,v.id AS version_id,v.stem FROM questions q JOIN LATERAL(SELECT id,stem FROM question_versions WHERE question_id=q.id ORDER BY version_no DESC LIMIT 1)v ON true WHERE q.id=$1 AND q.student_id=$2 AND q.revision_id IS NOT DISTINCT FROM $3",
                [v.sourceQuestionId, scope.studentId, task.revisionId],
              )
            ).rows[0];
            if (parent) {
              try {
                const match = await this.gateway.complete(
                  {
                    context: {
                      systemPrompt:
                        "判断两道题是否考查同一指定知识点且第二题是不同的变式。只输出JSON {sameGoal:boolean,distinct:boolean,reason:string}。不要把重述原题当新变式。",
                      messages: [
                        {
                          role: "user",
                          timestamp: Date.now(),
                          content: JSON.stringify({
                            original: parent.stem,
                            variant: v.stem,
                            knowledgePoint: v.knowledgePoint,
                          }),
                        },
                      ],
                    },
                  },
                  AbortSignal.timeout(60000),
                );
                const relation = z
                  .object({
                    sameGoal: z.boolean(),
                    distinct: z.boolean(),
                    reason: z.string(),
                  })
                  .parse(parseModelJson(match.text));
                if (relation.sameGoal && relation.distinct) {
                  const generated = (
                    await this.db.pool.query(
                      "SELECT question_id FROM question_versions WHERE id=$1",
                      [q.questionVersionId],
                    )
                  ).rows[0];
                  await this.db.pool.query(
                    "INSERT INTO question_relations(origin_question_id,origin_question_version_id,variant_question_id,knowledge_point,verified,evidence) VALUES($1,$2,$3,$4,true,$5)",
                    [
                      parent.id,
                      parent.version_id,
                      generated.question_id,
                      v.knowledgePoint,
                      JSON.stringify(relation),
                    ],
                  );
                }
              } catch {
                /* Unlinked practice cannot promote the original mistake. */
              }
            }
          }
          return {
            status: "verified",
            questionVersionId: q.questionVersionId,
            stem: v.stem,
          };
        }
      } catch {
        /* Keep the candidate unverified. */
      }
      if (attempt === 0) {
        const regenerated = await this.gateway.complete(
          {
            context: {
              systemPrompt:
                "重新生成一道明确可答、适合指定知识点的练习。输出JSON {stem,referenceAnswer,knowledgePoint,role,answerType,requiresWorking}；只要求最终数值的题用number、requiresWorking=false。",
              messages: [
                {
                  role: "user",
                  content: JSON.stringify(v),
                  timestamp: Date.now(),
                },
              ],
            },
          },
          AbortSignal.timeout(60000),
        );
        v = shape.parse(parseModelJson(regenerated.text));
      }
    }
    return {
      status: "pending",
      reason: "练习参考答案未通过独立核验，请换一道题",
    };
  }
}
