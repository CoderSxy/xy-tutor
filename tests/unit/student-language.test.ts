import { describe, expect, it } from "vitest";
import {
  LANGUAGE_RECOVERY_HINT,
  StudentTextGate,
  inspectStudentText,
} from "../../apps/server/src/modules/question-bank/student-language.js";

describe("inspectStudentText", () => {
  it("accepts Chinese stems that keep math identifiers and units", () => {
    for (const text of [
      "求 y=sin x 的周期",
      "已知 cos θ = 1/2，求 θ",
      "点 (x,y) 在直线 2x+y=1 上",
      "把 3 cm 换成 m",
      "牛顿第一定律说明了什么？",
    ]) {
      expect(inspectStudentText(text)).toEqual({
        status: "accepted",
        reasonCodes: [],
      });
    }
  });

  it("requires repair for English prose while keeping math intact", () => {
    expect(inspectStudentText("Find the period of y = sin x.")).toMatchObject({
      status: "repair_required",
      reasonCodes: expect.arrayContaining(["ENGLISH_PROSE"]),
    });
    expect(
      inspectStudentText("计算下列各题。Then explain your reasoning carefully."),
    ).toMatchObject({
      status: "repair_required",
      reasonCodes: expect.arrayContaining(["ENGLISH_PROSE"]),
    });
    expect(
      inspectStudentText("选项 A 表示向右平移。This option shifts the graph."),
    ).toMatchObject({
      status: "repair_required",
      reasonCodes: expect.arrayContaining(["ENGLISH_PROSE"]),
    });
    expect(
      inspectStudentText("答案是 2。The detailed solution is shown below."),
    ).toMatchObject({
      status: "repair_required",
      reasonCodes: expect.arrayContaining(["ENGLISH_PROSE"]),
    });
  });
});

describe("StudentTextGate", () => {
  it("does not emit English before a completed check", () => {
    const gate = new StudentTextGate();
    const first = gate.push("Please calculate the ");
    expect(first.published.join("")).not.toMatch(/Please/);
    const second = gate.push("period of y = sin x.");
    expect(`${first.published.join("")}${second.published.join("")}`).not.toMatch(
      /Please calculate/,
    );
    const done = gate.finish();
    expect(done.published.join("")).not.toMatch(/Please calculate/);
    expect(gate.publishedText()).toBe(done.text);
    expect(done.text === "" || done.text === LANGUAGE_RECOVERY_HINT).toBe(true);
  });

  it("keeps unclosed LaTeX buffered and publishes the intact formula", () => {
    const gate = new StudentTextGate();
    expect(gate.push("公式 $y=").published).toEqual([]);
    const closed = gate.push("\\sin x$ 的周期是多少？");
    expect(closed.published.join("")).toContain("$y=\\sin x$");
    expect(closed.published.join("")).toContain("周期");
    expect(gate.finish().text).toBe("公式 $y=\\sin x$ 的周期是多少？");
  });

  it("does not publish leftover buffer after cancel", () => {
    const gate = new StudentTextGate();
    gate.push("正在计算 $\\frac{1}{2");
    gate.cancel();
    expect(gate.finish()).toEqual({
      published: [],
      text: "",
      status: "accepted",
    });
    expect(gate.publishedText()).toBe("");
  });

  it("checks an oversized unclosed block instead of passing it through", () => {
    const gate = new StudentTextGate();
    const huge = `Please rewrite this explanation in English. ${"word ".repeat(900)}$`;
    expect(huge.length).toBeGreaterThan(4096);
    const result = gate.push(huge);
    expect(result.published.join("")).not.toMatch(/Please rewrite/);
    expect(gate.publishedText().length).toBeLessThanOrEqual(4096);
  });

  it("lets status hints through without waiting for a sentence", () => {
    const gate = new StudentTextGate();
    const result = gate.pushStatus("正在整理反馈");
    expect(result.published).toEqual(["正在整理反馈"]);
    expect(gate.publishedText()).toBe("");
  });
});
