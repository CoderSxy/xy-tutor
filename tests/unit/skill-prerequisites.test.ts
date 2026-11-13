import { it, expect } from "vitest";
import { findPrerequisiteCycle } from "../../apps/server/src/modules/question-bank/skills.js";

type Edge = { skillId: string; prerequisiteId: string };

const edge = (skillId: string, prerequisiteId: string): Edge => ({
  skillId,
  prerequisiteId,
});

it("拒绝给已有前置的技能补回一条成环的边", () => {
  // b 依赖 a；再把 b 设成 a 的前置会形成 a → b → a。
  const edges: Edge[] = [edge("b", "a")];
  expect(findPrerequisiteCycle(edges, "a", ["b"])).toEqual(["a", "b", "a"]);
});

it("拒绝把技能设为自己的前置", () => {
  expect(findPrerequisiteCycle([], "a", ["a"])).toEqual(["a", "a"]);
});

it("拒绝更长的传递环", () => {
  // c 依赖 b，b 依赖 a；把 c 设成 a 的前置形成 a → b → c → a。
  const edges: Edge[] = [edge("c", "b"), edge("b", "a")];
  expect(findPrerequisiteCycle(edges, "a", ["c"])).toEqual([
    "a",
    "b",
    "c",
    "a",
  ]);
});

it("允许无环的并列前置", () => {
  const edges: Edge[] = [edge("c", "a")];
  expect(findPrerequisiteCycle(edges, "c", ["b"])).toBeNull();
  expect(findPrerequisiteCycle(edges, "b", ["a"])).toBeNull();
});

it("同一个共享前置不算环", () => {
  // b 和 c 都依赖 a：给 b 再加一条 c 的前置仍然是 DAG。
  const edges: Edge[] = [edge("b", "a"), edge("c", "a")];
  expect(findPrerequisiteCycle(edges, "b", ["c"])).toBeNull();
});
