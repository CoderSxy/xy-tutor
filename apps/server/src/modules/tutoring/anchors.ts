import type { DiagnosisCode } from "../../../../../packages/contracts/src/tutoring.js";

/** 锚点内容随内容版本升级；诊断与提示都引用这个版本。 */
export const ANCHOR_VERSION = "anchors-v1";

export type AnchorCode =
  | "sign_tracking"
  | "conditions_on_diagram"
  | "write_key_steps"
  | "restate_goal"
  | "align_units"
  | "balance_equation"
  | "check_in_original"
  | "check_preconditions";

export type Anchor = {
  code: AnchorCode;
  name: string;
  /** 适用错因；空字符串表示通用自查动作。 */
  appliesTo: DiagnosisCode[];
  action: string;
  hint: string;
  example: string;
  counterexample: string;
  version: string;
};

const V = ANCHOR_VERSION;

export const ANCHORS: readonly Anchor[] = [
  {
    code: "sign_tracking",
    name: "符号跟着走",
    appliesTo: ["execution_slip", "rule_misuse"],
    action: "从原式抄写到每一步结果时，逐行写出这一项前面的正负号，移项或去括号后单独核对一次符号。",
    hint: "先只看符号：这一步的每一项，符号和上一行是同一条吗？",
    example: "解 2x - 5 = 9 时，先写 2x = 9 + 5，再核对“-5 移过去变成 +5”。",
    counterexample: "直接从 2x - 5 = 9 跳到 x = 2，省掉移项那一行的符号变化。",
    version: V,
  },
  {
    code: "conditions_on_diagram",
    name: "条件上图",
    appliesTo: ["condition_omission", "input_issue"],
    action: "把题干给出的每个数值、垂直、平行或等长条件标到图上，缺一个条件就停下来先补齐。",
    hint: "题干里还有哪个条件没有标到图上？",
    example: "看到“AB∥CD”就在图上画平行箭头，看到“∠1=40°”就标在对应角上。",
    counterexample: "只在脑子里记条件，写步骤时漏用了“等腰”这一条。",
    version: V,
  },
  {
    code: "write_key_steps",
    name: "关键步骤落纸",
    appliesTo: ["execution_slip", "strategy_gap", "expression_gap"],
    action: "把从已知到答案的关键中间量各写一行，不跳步；每一步都写出计算或依据。",
    hint: "把中间那一步单独写出来，先别急着算最终答案。",
    example: "求面积先写“底=6，高=4”，再写“面积=6×4÷2=12”。",
    counterexample: "心算三步合成一行，最后只写一个答案。",
    version: V,
  },
  {
    code: "restate_goal",
    name: "先看求什么",
    appliesTo: ["strategy_gap", "expression_gap"],
    action: "先用一句话写下题目要求求的量或证的关系，再回头检查已知条件是否都指向这个目标。",
    hint: "这道题最后要你求的是什么？先说这一句再动笔。",
    example: "题目问“还剩多少页”，就先写“目标：剩余页数 = 总页数 - 已读页数”。",
    counterexample: "看到数字就开始乘除，算完才发现题目要的是比例。",
    version: V,
  },
  {
    code: "align_units",
    name: "单位对齐",
    appliesTo: ["execution_slip", "expression_gap", "input_issue"],
    action: "计算前把所有量换成同一单位并写出来，结果再换回题目要求的单位。",
    hint: "这两个量的单位一样吗？先统一再算。",
    example: "把 1.2 米写成 120 厘米，再和 35 厘米相加。",
    counterexample: "米和厘米直接相减，答案数量级差 100 倍。",
    version: V,
  },
  {
    code: "balance_equation",
    name: "两边做同样的事",
    appliesTo: ["rule_misuse", "execution_slip"],
    action: "每次对方程做变形，都在等号两边同时写同样的操作，并检查等式仍然成立。",
    hint: "这一步你只对一边做了运算吗？另一边呢？",
    example: "3x + 2 = 11，两边同时减 2 得 3x = 9，再两边同时除以 3。",
    counterexample: "只在左边减 2，右边不动就得出答案。",
    version: V,
  },
  {
    code: "check_in_original",
    name: "答案回到原题",
    appliesTo: ["concept_gap", "execution_slip", "rule_misuse"],
    action: "把算出的结果代回原题或原方程，逐条核对是否满足所有条件，再决定是否保留这个答案。",
    hint: "把答案代回原式算一遍，左右两边相等吗？",
    example: "解得 x=3 后，代回 2x-5 检查是否等于 1。",
    counterexample: "算出答案就交，不检查是否满足题目的取值范围。",
    version: V,
  },
  {
    code: "check_preconditions",
    name: "先查适用条件",
    appliesTo: ["rule_misuse", "condition_omission", "input_issue"],
    action: "用公式或性质前，先逐条写出它的适用前提，确认题目条件都满足再套用。",
    hint: "这个公式在这里能用吗？先把它的前提条件念一遍。",
    example: "用勾股定理前先确认是直角三角形；用分式基本性质前先确认分母不为 0。",
    counterexample: "看到两个数就套公式，不检查是否满足前提。",
    version: V,
  },
];

const BY_CODE = new Map(ANCHORS.map((anchor) => [anchor.code, anchor]));

export function getAnchor(code: AnchorCode): Anchor {
  return BY_CODE.get(code)!;
}

export function anchorForCode(code: DiagnosisCode | null): Anchor {
  switch (code) {
    case "condition_omission":
      return getAnchor("conditions_on_diagram");
    case "rule_misuse":
      return getAnchor("check_preconditions");
    case "strategy_gap":
    case "expression_gap":
      return getAnchor("restate_goal");
    case "input_issue":
      return getAnchor("check_preconditions");
    case "concept_gap":
      return getAnchor("check_in_original");
    case "execution_slip":
    default:
      return getAnchor("write_key_steps");
  }
}

export function describeAnchor(anchor: Anchor): string {
  return [
    `自查锚点：${anchor.name}`,
    `怎么做：${anchor.action}`,
    `例子：${anchor.example}`,
    `不要这样做：${anchor.counterexample}`,
  ].join("\n");
}

export const DEFAULT_PROBE =
  "把这道题最关键的那一步单独写出来，只写这一步和它的依据。";
