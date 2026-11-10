import { it, expect } from "vitest";
import {
  addDays,
  inclusiveDays,
  parseDay,
  rate,
  resolveInsightRange,
  shanghaiToday,
  streaks,
} from "../../apps/server/src/modules/student-insights/metrics.js";

it("uses_shanghai_midnight", () => {
  const now = new Date("2026-11-10T03:00:00.000Z");
  expect(shanghaiToday(now)).toBe("2026-11-10");
  const range = resolveInsightRange(
    { from: "2026-11-09", to: "2026-11-10" },
    now,
  );
  expect(range.start.toISOString()).toBe("2026-11-08T16:00:00.000Z");
  expect(range.endExclusive.toISOString()).toBe("2026-11-10T16:00:00.000Z");
  // 上海时间 23:59 仍属于当天
  expect(shanghaiToday(new Date("2026-11-10T15:59:59.000Z"))).toBe("2026-11-10");
  expect(shanghaiToday(new Date("2026-11-10T16:00:00.000Z"))).toBe("2026-11-11");
});

it("defaults_to_the_last_thirty_shanghai_days", () => {
  const now = new Date("2026-11-10T03:00:00.000Z");
  const range = resolveInsightRange({}, now);
  expect(range.to).toBe("2026-11-10");
  expect(range.from).toBe("2026-10-12");
  expect(inclusiveDays(range.from, range.to)).toHaveLength(30);
});

it("rejects_invalid_ranges", () => {
  const now = new Date("2026-11-10T03:00:00.000Z");
  expect(() =>
    resolveInsightRange({ from: "2026-11-10", to: "2026-11-11" }, now),
  ).toThrow("结束日期不能晚于今天");
  expect(() =>
    resolveInsightRange({ from: "2026-11-08", to: "2026-11-05" }, now),
  ).toThrow("开始日期不能晚于结束日期");
  expect(() =>
    resolveInsightRange({ from: "2020-01-01", to: "2026-11-10" }, now),
  ).toThrow("查询范围不能超过366天");
  expect(() => parseDay("2026-02-30")).toThrow("日期不存在");
  expect(() => parseDay("2026-13-01")).toThrow("日期不存在");
  expect(() => resolveInsightRange({ from: "2026-2-1" }, now)).toThrow(
    "日期格式应为 YYYY-MM-DD",
  );
});

it("zero_denominator_is_null", () => {
  expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
  expect(rate(3, 4)).toEqual({ numerator: 3, denominator: 4, value: 0.75 });
});

it("leap_day_and_cross_year_ranges_are_calendar_exact", () => {
  expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(inclusiveDays("2026-12-30", "2027-01-02")).toEqual([
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
  ]);
});

it("streak_can_anchor_yesterday", () => {
  expect(streaks(["2026-11-07", "2026-11-08", "2026-11-09"], "2026-11-10")).toEqual({
    current: 3,
    longest: 3,
  });
  expect(
    streaks(["2026-11-01", "2026-11-08", "2026-11-09", "2026-11-10"], "2026-11-10"),
  ).toEqual({ current: 3, longest: 3 });
  expect(streaks(["2026-11-05", "2026-11-06"], "2026-11-10")).toEqual({
    current: 0,
    longest: 2,
  });
  expect(streaks([], "2026-11-10")).toEqual({ current: 0, longest: 0 });
});

it("streaks_span_leap_day_and_year_boundary", () => {
  expect(
    streaks(["2028-02-28", "2028-02-29", "2028-03-01"], "2028-03-01"),
  ).toEqual({ current: 3, longest: 3 });
  expect(
    streaks(["2026-12-30", "2026-12-31", "2027-01-01"], "2027-01-01"),
  ).toEqual({ current: 3, longest: 3 });
});
