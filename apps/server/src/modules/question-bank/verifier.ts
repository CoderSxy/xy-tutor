import type { ModelGateway } from "../../agent/provider.js";
import { checkReference } from "../learning/practice.js";
import { equivalent } from "../learning/verifier.js";
import { instantiateTemplate, TemplateValidationError } from "./templates.js";

export type FrozenKnowledge = {
  id: string;
  title: string;
  summary: string;
  updatedAt: string;
  contentHash: string;
};

export type BankCandidateInput = {
  stem: string;
  referenceAnswer: string;
  answerType: "number" | "choice" | "worked" | "open";
  requiresWorking: boolean;
  knowledge: FrozenKnowledge[];
  template?: {
    code: string;
    version: number;
    params: unknown;
    approved: boolean;
  };
  gateway?: ModelGateway;
  signal?: AbortSignal;
};

export type BankVerification = {
  status: "verified" | "rejected" | "pending_review";
  checks: Record<string, boolean>;
  reasons: string[];
};

function leakCheck(stem: string, answer: string): boolean {
  const normalizedStem = stem.replace(/\s+/g, " ");
  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) return false;
  if (normalizedAnswer.length < 2) return false;
  const index = normalizedStem.indexOf(normalizedAnswer);
  if (index < 0) return false;
  const before = normalizedStem[index - 1];
  const after = normalizedStem[index + normalizedAnswer.length];
  const boundary = (ch: string | undefined) =>
    ch === undefined || !/[0-9A-Za-z/.]/.test(ch);
  return boundary(before) && boundary(after);
}

export async function verifyBankCandidate(
  input: BankCandidateInput,
): Promise<BankVerification> {
  const checks: Record<string, boolean> = {};
  const reasons: string[] = [];

  checks.evidencePresent =
    input.knowledge.length > 0 &&
    input.knowledge.every(
      (item) =>
        item.title.length > 0 &&
        item.summary.length > 0 &&
        /^[0-9a-f]{64}$/.test(item.contentHash),
    );
  if (!checks.evidencePresent) reasons.push("缺少已发布知识点依据");

  checks.stemClear =
    input.stem.trim().length > 0 && input.stem.length <= 20000;
  if (!checks.stemClear) reasons.push("题干为空或过长");

  checks.noLeak =
    checks.stemClear && !leakCheck(input.stem, input.referenceAnswer);
  if (!checks.noLeak) reasons.push("题干包含参考答案，疑似泄露");

  checks.answerConfirmed = false;
  checks.templateValid = true;
  checks.templateApproved = false;

  if (input.template) {
    checks.templateApproved = input.template.approved;
    if (!checks.templateApproved) reasons.push("模板尚未经管理员批准");
    try {
      const solved = instantiateTemplate(
        input.template.code,
        input.template.version,
        input.template.params,
      );
      const same =
        solved.answerType === input.answerType &&
        equivalent(solved.answer, input.referenceAnswer, "number");
      checks.answerConfirmed = same === true;
      if (!checks.answerConfirmed) reasons.push("模板求解结果与参考答案不一致");
    } catch (error) {
      checks.templateValid = false;
      if (error instanceof TemplateValidationError) {
        reasons.push(`模板参数不合法：${error.code}`);
      } else {
        reasons.push("模板实例化失败");
      }
    }
  } else if (input.gateway) {
    try {
      const checked = await checkReference(
        input.gateway,
        input.stem,
        {
          referenceAnswer: input.referenceAnswer,
          answerType: input.answerType,
          requiresWorking: input.requiresWorking,
          reason: "题库候选参考答案",
        },
        input.signal,
      );
      checks.answerConfirmed = checked.verified;
      if (!checked.verified) reasons.push("独立求解与参考答案不一致");
    } catch {
      reasons.push("模型核验未完成，暂不发布");
    }
  } else {
    reasons.push("缺少独立核验模型");
  }

  if (!checks.templateValid) {
    return { status: "rejected", checks, reasons };
  }
  if (!checks.answerConfirmed) {
    const timedOut = reasons.includes("模型核验未完成，暂不发布");
    return {
      status: timedOut ? "pending_review" : "rejected",
      checks,
      reasons,
    };
  }
  const verified =
    !!input.template &&
    checks.templateApproved &&
    checks.evidencePresent &&
    checks.stemClear &&
    checks.noLeak &&
    checks.answerConfirmed;
  if (!verified) {
    if (!input.template) reasons.push("纯生成题需人工审核后发布");
    return { status: "pending_review", checks, reasons };
  }
  return { status: "verified", checks, reasons };
}
