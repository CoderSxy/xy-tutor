import type {
  DiagnosisDTO,
  Exposure,
  TeachingState,
  TeachingTransitionInput,
} from "../../../../../packages/contracts/src/tutoring.js";

export const TEACHING_RULE_VERSION = "teaching-v1";

export type TeachingDecision = {
  next: TeachingState;
  exposure: Exposure;
  reason: string;
  ruleVersion: string;
};

const EXPOSURE_RANK: Record<Exposure, number> = {
  none: 0,
  guided: 1,
  unknown: 2,
  solution_exposed: 3,
};

/** 取更保守的一方，绝不让提示记录变得更乐观。 */
function worse(a: Exposure, b: Exposure): Exposure {
  return EXPOSURE_RANK[a] >= EXPOSURE_RANK[b] ? a : b;
}

/**
 * 学生新提交步骤才算一次尝试：消息刷新、重试和重复点击不增加失败次数。
 * 调用方负责判断自上次动作后是否出现了新的学生步骤。
 */
export function nextFailedChecks(
  current: number,
  sawNewAttempt: boolean,
): number {
  return sawNewAttempt ? current + 1 : current;
}

function confirmedKnowledgeGap(diagnosis: DiagnosisDTO | null): boolean {
  return (
    diagnosis?.status === "confirmed" &&
    (diagnosis.primaryCode === "concept_gap" ||
      diagnosis.primaryCode === "rule_misuse")
  );
}

const NEXT_LEVEL: Partial<Record<TeachingState, TeachingState>> = {
  awaiting_evidence: "self_check",
  self_check: "focused_check",
  focused_check: "micro_probe",
  micro_probe: "explanation",
  independent_check: "self_check",
  scheduled_review: "self_check",
};

export function decideTeachingTransition(
  input: TeachingTransitionInput,
): TeachingDecision {
  const { action, diagnosis, failedChecks } = input;
  const current = input.episode.teachingState;

  if (
    action.kind === "pause" ||
    action.kind === "resume" ||
    action.kind === "acknowledge_display"
  )
    return {
      next: current,
      exposure: input.episode.exposure,
      reason: "显示或暂停操作不改变教学状态",
      ruleVersion: TEACHING_RULE_VERSION,
    };

  if (action.kind === "request_explanation")
    return {
      next: "explanation",
      exposure: worse(input.episode.exposure, "solution_exposed"),
      reason: "学生主动求助完整讲解",
      ruleVersion: TEACHING_RULE_VERSION,
    };

  if (action.kind === "request_example")
    return {
      next: "explanation",
      exposure: worse(input.episode.exposure, "guided"),
      reason: "学生主动求助同类示例",
      ruleVersion: TEACHING_RULE_VERSION,
    };

  if (action.kind === "request_probe") {
    if (current === "micro_probe" || failedChecks >= 2)
      return {
        next: "explanation",
        exposure: worse(input.episode.exposure, "guided"),
        reason: "微题已达上限，转为讲解",
        ruleVersion: TEACHING_RULE_VERSION,
      };
    return {
      next: "micro_probe",
      exposure: worse(input.episode.exposure, "guided"),
      reason: "用一个小题区分当前错因",
      ruleVersion: TEACHING_RULE_VERSION,
    };
  }

  // request_hint
  if (confirmedKnowledgeGap(diagnosis))
    return {
      next: "explanation",
      exposure: worse(input.episode.exposure, "guided"),
      reason: "已确认知识缺口，直接讲解",
      ruleVersion: TEACHING_RULE_VERSION,
    };

  if (current === "explanation" || current === "independent_check")
    return {
      next: current,
      exposure: worse(input.episode.exposure, "guided"),
      reason: "讲解阶段不再重复同一层提示",
      ruleVersion: TEACHING_RULE_VERSION,
    };

  let next = NEXT_LEVEL[current] ?? "focused_check";
  if (failedChecks >= 2 && EXPOSURE_ONLY_SELF_CHECKS.has(next))
    next = "micro_probe";
  return {
    next,
    exposure: worse(input.episode.exposure, "guided"),
    reason:
      failedChecks >= 2
        ? "两次检查没有进展，升级提示层级"
        : "同一检查层级不重复提示",
    ruleVersion: TEACHING_RULE_VERSION,
  };
}

const EXPOSURE_ONLY_SELF_CHECKS = new Set<TeachingState>([
  "self_check",
  "focused_check",
]);

/**
 * 教师消息的暴露等级无法从文本可靠判定时一律取 unknown，
 * 不能因为“看起来只是提问”就当成没有提示。
 */
export function classifyTutorMessage(text: string): Exposure {
  if (/完整解|解法如下|最终答案[:：]|答案是[:：]/.test(text))
    return "solution_exposed";
  if (/提示|先写|第一步|想一想|试一试/.test(text)) return "guided";
  return "unknown";
}

/**
 * 复核一次评估的提示依赖。作用域必须同时包含学生、任务和题目版本；
 * 任何无法可靠归属的自由文本都按 unknown 处理，不能当作独立完成。
 */
export function combineHintDependency(input: {
  hints: readonly string[];
  actions: readonly Exposure[];
  unattributed: Exposure;
}): Exposure {
  let result: Exposure = input.unattributed;
  for (const exposure of input.actions)
    result = worse(result, exposure);
  for (const level of input.hints) {
    if (level === "solution_exposed" || level === "guided")
      result = worse(result, level);
    else if (level === "unknown") result = worse(result, "unknown");
  }
  return result;
}
