import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import {
  skillCreateInputSchema,
  skillPrerequisitesInputSchema,
  type SkillCreateInput,
  type SkillDTO,
} from "../../../../../packages/contracts/src/question-bank.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { PoolClient } from "pg";
import { requireAdmin } from "../auth/policy.js";

export type PrerequisiteEdge = { skillId: string; prerequisiteId: string };

/**
 * 返回「加入这些前置之后」形成的环，路径按依赖方向从 skillId 回到自身；
 * 无环返回 null。edges 只包含已存在的边，不含本次要写入的边。
 */
export function findPrerequisiteCycle(
  edges: PrerequisiteEdge[],
  skillId: string,
  prerequisiteIds: string[],
): string[] | null {
  const dependents = new Map<string, string[]>();
  const add = (prerequisiteId: string, dependentId: string) => {
    const list = dependents.get(prerequisiteId);
    if (list) list.push(dependentId);
    else dependents.set(prerequisiteId, [dependentId]);
  };
  for (const edge of edges) add(edge.prerequisiteId, edge.skillId);
  for (const prerequisiteId of prerequisiteIds)
    add(prerequisiteId, skillId);

  const path = [skillId];
  const visited = new Set([skillId]);
  const walk = (node: string): boolean => {
    for (const next of dependents.get(node) ?? []) {
      if (next === skillId) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      if (walk(next)) return true;
      path.pop();
    }
    return false;
  };
  return walk(skillId) ? [...path, skillId] : null;
}

type SkillRow = {
  id: string;
  code: string;
  name: string;
  status: "active" | "withdrawn";
};

async function skillDTO(c: Database, row: SkillRow): Promise<SkillDTO> {
  const prerequisites = (
    await c.pool.query<{ prerequisite_id: string }>(
      "SELECT prerequisite_id FROM skill_prerequisites WHERE skill_id=$1 ORDER BY created_at, prerequisite_id",
      [row.id],
    )
  ).rows;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    prerequisiteIds: prerequisites.map((p) => p.prerequisite_id),
  };
}

export class SkillService {
  constructor(private db: Database) {}

  async create(actor: Actor, input: SkillCreateInput): Promise<SkillDTO> {
    requireAdmin(actor);
    const parsed = skillCreateInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "技能参数不正确");
    try {
      const row = (
        await this.db.pool.query<SkillRow>(
          "INSERT INTO skills(code,name,created_by) VALUES($1,$2,$3) RETURNING id,code,name,status",
          [parsed.data.code, parsed.data.name, actor.userId],
        )
      ).rows[0]!;
      await this.audit(actor, "skill.create", { skillId: row.id });
      return skillDTO(this.db, row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError("CONFLICT", 409, "技能代码已存在");
      throw error;
    }
  }

  async linkContent(
    actor: Actor,
    skillId: string,
    knowledgeItemId: string,
  ): Promise<void> {
    requireAdmin(actor);
    await inTransaction(this.db, async (tx) => {
      await this.requireSkill(tx, skillId);
      const item = (
        await tx.query<{ status: string }>(
          "SELECT status FROM knowledge_items WHERE id=$1",
          [knowledgeItemId],
        )
      ).rows[0];
      if (!item) throw new AppError("NOT_FOUND", 404, "知识点不存在");
      if (item.status !== "published")
        throw new AppError("CONFLICT", 409, "只有已发布的知识点可以作为技能依据");
      await tx.query(
        `INSERT INTO skill_content_links(skill_id,knowledge_item_id,created_by)
         VALUES($1,$2,$3)
         ON CONFLICT (skill_id,knowledge_item_id) DO NOTHING`,
        [skillId, knowledgeItemId, actor.userId],
      );
      await this.audit(actor, "skill.content.link", {
        skillId,
        knowledgeItemId,
      });
    });
  }

  async setPrerequisites(
    actor: Actor,
    skillId: string,
    prerequisiteIds: string[],
  ): Promise<SkillDTO> {
    requireAdmin(actor);
    const parsed = skillPrerequisitesInputSchema.safeParse({ prerequisiteIds });
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "前置技能参数不正确");
    const unique = [...new Set(parsed.data.prerequisiteIds)];
    if (unique.includes(skillId))
      throw new AppError("CONFLICT", 409, "技能不能依赖自己");
    const row = await inTransaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('skill_prerequisites'))");
      const skill = await this.requireSkill(tx, skillId);
      const found = (
        await tx.query<{ id: string }>(
          "SELECT id FROM skills WHERE id=ANY($1::uuid[])",
          [unique],
        )
      ).rows;
      if (found.length !== unique.length)
        throw new AppError("NOT_FOUND", 404, "前置技能不存在");
      const edges = (
        await tx.query<{ skill_id: string; prerequisite_id: string }>(
          "SELECT skill_id,prerequisite_id FROM skill_prerequisites",
        )
      ).rows.map((e) => ({
        skillId: e.skill_id,
        prerequisiteId: e.prerequisite_id,
      }));
      const cycle = findPrerequisiteCycle(edges, skillId, unique);
      if (cycle)
        throw new AppError("CONFLICT", 409, "前置技能会形成循环", {
          cycle,
        });
      await tx.query("DELETE FROM skill_prerequisites WHERE skill_id=$1", [
        skillId,
      ]);
      for (const prerequisiteId of unique) {
        await tx.query(
          "INSERT INTO skill_prerequisites(skill_id,prerequisite_id) VALUES($1,$2)",
          [skillId, prerequisiteId],
        );
      }
      await this.audit(actor, "skill.prerequisites.set", {
        skillId,
        prerequisiteIds: unique,
      });
      return skill;
    });
    return skillDTO(this.db, row);
  }

  async list(actor: Actor): Promise<SkillDTO[]> {
    requireAdmin(actor);
    const rows = (
      await this.db.pool.query<SkillRow>(
        "SELECT id,code,name,status FROM skills ORDER BY code",
      )
    ).rows;
    return Promise.all(rows.map((row) => skillDTO(this.db, row)));
  }

  async requireSkill(tx: PoolClient, skillId: string): Promise<SkillRow> {
    const row = (
      await tx.query<SkillRow>(
        "SELECT id,code,name,status FROM skills WHERE id=$1",
        [skillId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "技能不存在");
    return row;
  }

  private async audit(
    actor: Actor,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db.pool.query(
      "INSERT INTO audit_events(actor_id,action,details) VALUES($1,$2,$3)",
      [actor.userId, action, JSON.stringify(details)],
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}
