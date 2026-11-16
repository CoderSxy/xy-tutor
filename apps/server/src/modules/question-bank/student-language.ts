import { z } from "zod";
import { LANGUAGE_POLICY_VERSION } from "../../../../../packages/contracts/src/question-presentation.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { ModelGateway } from "../../agent/provider.js";

function parseModelJson(text: string): unknown {
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

export const STUDENT_LANGUAGE_POLICY = LANGUAGE_POLICY_VERSION;
export const LANGUAGE_RECOVERY_HINT = "内容整理失败，请稍后重试。";
export const LANGUAGE_STATUS_HINT = "正在整理反馈";
const MAX_UNCLOSED_BLOCK = 4096;

export type LanguageInspectResult = {
  status: "accepted" | "repair_required";
  reasonCodes: string[];
};

export type LanguageCheckedContent = {
  fields: Record<string, string>;
  status: "accepted" | "repair_required" | "failed";
  policyVersion: string;
  reasonCodes: string[];
};

const MATH_WORDS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "lg",
  "lim",
  "max",
  "min",
  "gcd",
  "lcm",
  "mod",
  "abs",
  "exp",
  "sqrt",
  "det",
  "dim",
  "sup",
  "inf",
]);

const UNITS = new Set([
  "cm",
  "mm",
  "km",
  "kg",
  "mg",
  "g",
  "m",
  "s",
  "h",
  "min",
  "ml",
  "l",
  "n",
  "pa",
  "j",
  "w",
  "v",
  "a",
  "hz",
]);

const PROPER_NOUNS = new Set([
  "newton",
  "pythagoras",
  "euclid",
  "gauss",
  "euler",
  "fibonacci",
  "dna",
  "rna",
]);

const repairedFieldsSchema = z.record(z.string(), z.string());

function maskProtected(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ");
}

function allowedToken(word: string): boolean {
  const lower = word.toLowerCase();
  if (word.length === 1) return true;
  if (MATH_WORDS.has(lower) || UNITS.has(lower) || PROPER_NOUNS.has(lower))
    return true;
  if (/^[A-D]$/i.test(word)) return true;
  return false;
}

export function inspectStudentText(text: string): LanguageInspectResult {
  const masked = maskProtected(text);
  const tokens = masked.match(/[A-Za-z]{2,}/g) ?? [];
  const prose = tokens.filter((word) => !allowedToken(word));
  if (prose.length === 0) return { status: "accepted", reasonCodes: [] };
  let consecutive = 0;
  let maxConsecutive = 0;
  for (const word of tokens) {
    if (allowedToken(word)) {
      consecutive = 0;
      continue;
    }
    consecutive += 1;
    maxConsecutive = Math.max(maxConsecutive, consecutive);
  }
  if (maxConsecutive >= 3 || prose.length >= 4)
    return { status: "repair_required", reasonCodes: ["ENGLISH_PROSE"] };
  return { status: "accepted", reasonCodes: [] };
}

function latexOpen(text: string): boolean {
  const dollars = (text.match(/(?<!\\)\$/g) ?? []).length;
  if (dollars % 2 === 1) return true;
  const openParen = (text.match(/\\\(/g) ?? []).length;
  const closeParen = (text.match(/\\\)/g) ?? []).length;
  const openBrack = (text.match(/\\\[/g) ?? []).length;
  const closeBrack = (text.match(/\\\]/g) ?? []).length;
  return openParen > closeParen || openBrack > closeBrack;
}

function nextSegment(buffer: string): { segment: string; rest: string } | null {
  if (!buffer) return null;
  if (buffer.length >= MAX_UNCLOSED_BLOCK)
    return { segment: buffer, rest: "" };
  const match = buffer.match(/[\s\S]*?(?:[。！？.!?\n]|$)/);
  if (!match || match[0].length === 0) return null;
  const segment = match[0];
  if (segment.length < buffer.length && !latexOpen(segment))
    return { segment, rest: buffer.slice(segment.length) };
  if (/[。！？.!?]$/.test(segment) && !latexOpen(segment))
    return { segment, rest: buffer.slice(segment.length) };
  return null;
}

export class StudentTextGate {
  private buffer = "";
  private body: string[] = [];
  private cancelled = false;

  push(delta: string): { published: string[] } {
    if (this.cancelled || !delta) return { published: [] };
    this.buffer += delta;
    return { published: this.drain() };
  }

  pushStatus(text: string): { published: string[] } {
    return { published: text ? [text] : [] };
  }

  finish(): {
    published: string[];
    text: string;
    status: "accepted" | "repair_required";
  } {
    if (this.cancelled) return { published: [], text: "", status: "accepted" };
    const published = this.drain(true);
    return {
      published,
      text: this.publishedText(),
      status: inspectStudentText(this.publishedText()).status,
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.buffer = "";
  }

  publishedText(): string {
    return this.body.join("");
  }

  private drain(flush = false): string[] {
    const published: string[] = [];
    while (this.buffer) {
      const next = nextSegment(this.buffer);
      if (!next && !flush) break;
      const segment = next?.segment ?? this.buffer;
      this.buffer = next ? next.rest : "";
      const checked = inspectStudentText(segment);
      if (checked.status === "accepted") {
        this.body.push(segment);
        published.push(segment);
      } else if (flush && this.body.length === 0 && published.length === 0) {
        this.body.push(LANGUAGE_RECOVERY_HINT);
        published.push(LANGUAGE_RECOVERY_HINT);
      }
      if (!next) break;
    }
    return published;
  }
}

function containsMath(haystack: string, token: string): boolean {
  if (!token) return true;
  if (haystack.includes(token)) return true;
  return haystack.replace(/\s+/g, "").includes(token.replace(/\s+/g, ""));
}

function mathIntact(
  original: Record<string, string>,
  repaired: Record<string, string>,
  immutableMath: string[] | undefined,
): boolean {
  const haystack = Object.values(repaired).join("\n");
  for (const token of immutableMath ?? []) {
    if (!containsMath(haystack, token)) return false;
  }
  const originalMath = Object.values(original)
    .join("\n")
    .match(/\$[^$]+\$|\\sin|\\cos|[a-zA-Z]\s*=\s*sin[^.\n]*|sin\s*x|cos\s*[a-zA-Zθ]/g);
  if (!originalMath) return true;
  return originalMath.every((token) => containsMath(haystack, token));
}

export async function ensureStudentContent(
  input: {
    fields: Record<string, string>;
    immutableMath?: string[];
    policyVersion?: string;
  },
  gateway?: ModelGateway,
  signal?: AbortSignal,
): Promise<LanguageCheckedContent> {
  const policyVersion = input.policyVersion ?? STUDENT_LANGUAGE_POLICY;
  const reasonCodes = new Set<string>();
  let needsRepair = false;
  for (const value of Object.values(input.fields)) {
    const inspected = inspectStudentText(value);
    if (inspected.status === "repair_required") {
      needsRepair = true;
      for (const code of inspected.reasonCodes) reasonCodes.add(code);
    }
  }
  if (!needsRepair)
    return {
      fields: { ...input.fields },
      status: "accepted",
      policyVersion,
      reasonCodes: [],
    };
  if (!gateway)
    return {
      fields: { ...input.fields },
      status: "repair_required",
      policyVersion,
      reasonCodes: [...reasonCodes],
    };
  try {
    const result = await gateway.complete(
      {
        context: {
          systemPrompt:
            '把学生可见叙述改写成简体中文。保留公式、变量、单位和必要专名，不要改数学条件或答案。只输出JSON对象，键与输入字段相同，值为改写后的字符串。',
          messages: [
            {
              role: "user",
              content: JSON.stringify(input.fields),
              timestamp: Date.now(),
            },
          ],
        },
      },
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    );
    const repaired = repairedFieldsSchema.parse(parseModelJson(result.text));
    const fields: Record<string, string> = { ...input.fields };
    for (const key of Object.keys(input.fields)) {
      if (typeof repaired[key] === "string") fields[key] = repaired[key]!;
    }
    if (!mathIntact(input.fields, fields, input.immutableMath))
      return {
        fields: { ...input.fields },
        status: "repair_required",
        policyVersion,
        reasonCodes: [...reasonCodes, "MATH_CHANGED"],
      };
    const leftover = new Set<string>();
    for (const value of Object.values(fields)) {
      const inspected = inspectStudentText(value);
      if (inspected.status === "repair_required")
        for (const code of inspected.reasonCodes) leftover.add(code);
    }
    if (leftover.size)
      return {
        fields: { ...input.fields },
        status: "failed",
        policyVersion,
        reasonCodes: [...leftover],
      };
    return { fields, status: "accepted", policyVersion, reasonCodes: [] };
  } catch {
    return {
      fields: { ...input.fields },
      status: "failed",
      policyVersion,
      reasonCodes: [...reasonCodes, "REPAIR_FAILED"],
    };
  }
}

export async function publishStudentText(
  text: string,
  gateway?: ModelGateway,
  signal?: AbortSignal,
): Promise<string> {
  const checked = await ensureStudentContent({ fields: { text } }, gateway, signal);
  if (checked.status === "accepted") return checked.fields.text ?? text;
  return LANGUAGE_RECOVERY_HINT;
}

export async function localizeQuestionStem(
  db: Database,
  questionVersionId: string,
  gateway?: ModelGateway,
  signal?: AbortSignal,
): Promise<{
  stem: string;
  status: "original" | "pending" | "ready" | "failed";
  originalUnchanged: boolean;
}> {
  const version = (
    await db.pool.query<{ stem: string }>(
      "SELECT stem FROM question_versions WHERE id=$1",
      [questionVersionId],
    )
  ).rows[0];
  if (!version) throw Error("QUESTION_VERSION_NOT_FOUND");
  const original = version.stem;
  if (inspectStudentText(original).status === "accepted")
    return { stem: original, status: "original", originalUnchanged: true };
  const cached = (
    await db.pool.query<{ status: string; payload: { stem?: string } }>(
      "SELECT status,payload FROM question_localizations WHERE question_version_id=$1 AND policy_version=$2",
      [questionVersionId, STUDENT_LANGUAGE_POLICY],
    )
  ).rows[0];
  if (cached?.status === "ready" && cached.payload?.stem)
    return {
      stem: cached.payload.stem,
      status: "ready",
      originalUnchanged: true,
    };
  await db.pool.query(
    `INSERT INTO question_localizations(question_version_id,policy_version,payload,status)
     VALUES($1,$2,'{}','pending')
     ON CONFLICT (question_version_id,policy_version)
     DO UPDATE SET status='pending',updated_at=now()`,
    [questionVersionId, STUDENT_LANGUAGE_POLICY],
  );
  const checked = await ensureStudentContent(
    { fields: { stem: original } },
    gateway,
    signal,
  );
  if (checked.status === "accepted") {
    await db.pool.query(
      `INSERT INTO question_localizations(question_version_id,policy_version,payload,status)
       VALUES($1,$2,$3,'ready')
       ON CONFLICT (question_version_id,policy_version)
       DO UPDATE SET payload=EXCLUDED.payload,status='ready',updated_at=now()`,
      [
        questionVersionId,
        STUDENT_LANGUAGE_POLICY,
        JSON.stringify({ stem: checked.fields.stem }),
      ],
    );
    const still = (
      await db.pool.query<{ stem: string }>(
        "SELECT stem FROM question_versions WHERE id=$1",
        [questionVersionId],
      )
    ).rows[0]!;
    return {
      stem: checked.fields.stem ?? original,
      status: "ready",
      originalUnchanged: still.stem === original,
    };
  }
  await db.pool.query(
    `UPDATE question_localizations SET status='failed',updated_at=now()
     WHERE question_version_id=$1 AND policy_version=$2`,
    [questionVersionId, STUDENT_LANGUAGE_POLICY],
  );
  return { stem: original, status: "failed", originalUnchanged: true };
}
