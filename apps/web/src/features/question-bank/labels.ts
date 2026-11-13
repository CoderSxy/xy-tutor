export const entryStatusLabels: Record<string, string> = {
  draft: "草稿",
  checking: "核验中",
  pending_review: "待审核",
  published: "已发布",
  rejected: "已驳回",
  withdrawn: "已撤回",
};

export const templateStatusLabels: Record<string, string> = {
  pending_review: "待审核",
  approved: "已批准",
  rejected: "已驳回",
};

export const difficultyLabels: Record<string, string> = {
  easy: "基础",
  medium: "进阶",
  challenge: "挑战",
};

export const goalLabels: Record<string, string> = {
  diagnostic: "诊断",
  repair: "巩固",
  transfer: "迁移",
  review: "复习",
};

export const sourceTypeLabels: Record<string, string> = {
  private_upload: "私人上传",
  shared_upload: "共享上传",
  template: "模板生成",
  generated: "模型生成",
};

export const verificationLabels: Record<string, string> = {
  verified: "已核验",
  pending: "待核验",
  unverified: "未核验",
};

export const trainingBandLabels: Record<string, string> = {
  repair: "需要补基础",
  consolidation: "正在巩固",
  advance: "可以进阶",
};

export const habitAnchorLabels: Record<string, string> = {
  sign_tracking: "符号跟着走",
  conditions_on_diagram: "条件上图",
  write_key_steps: "关键步骤落纸",
  restate_goal: "先看求什么",
  align_units: "单位对齐",
  balance_equation: "两边做同样的事",
  check_in_original: "答案回到原题",
  check_preconditions: "先查适用条件",
};

export function statusLabel(status: string): string {
  return { active: "启用中", withdrawn: "已停用" }[status] ?? status;
}
