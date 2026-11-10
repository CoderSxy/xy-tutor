import { AppError } from "../../../../../packages/contracts/src/api.js";
import type {
  InsightFilter,
  Rate,
} from "../../../../../packages/contracts/src/student-insights.js";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatDay(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function parseDay(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new AppError("VALIDATION", 422, "日期格式应为 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  )
    throw new AppError("VALIDATION", 422, "日期不存在");
  return { year, month, day };
}

export function dayNumber(value: string): number {
  const { year, month, day } = parseDay(value);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function dayFromNumber(n: number): string {
  const date = new Date(n * DAY_MS);
  return formatDay(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

export function addDays(value: string, delta: number): string {
  return dayFromNumber(dayNumber(value) + delta);
}

export function shanghaiToday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return formatDay(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

export function dayStartUtc(value: string): Date {
  const { year, month, day } = parseDay(value);
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
}

export type ResolvedRange = {
  from: string;
  to: string;
  start: Date;
  endExclusive: Date;
};

export function resolveInsightRange(
  filter: Partial<Pick<InsightFilter, "from" | "to">>,
  now: Date = new Date(),
): ResolvedRange {
  const today = shanghaiToday(now);
  const to = filter.to ?? today;
  const from = filter.from ?? addDays(to, -29);
  parseDay(to);
  parseDay(from);
  if (from > to) throw new AppError("VALIDATION", 422, "开始日期不能晚于结束日期");
  if (to > today) throw new AppError("VALIDATION", 422, "结束日期不能晚于今天");
  const span = dayNumber(to) - dayNumber(from) + 1;
  if (span > MAX_RANGE_DAYS)
    throw new AppError("VALIDATION", 422, "查询范围不能超过366天");
  return {
    from,
    to,
    start: dayStartUtc(from),
    endExclusive: dayStartUtc(addDays(to, 1)),
  };
}

export function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
  };
}

export function dayOf(instant: Date): string {
  return shanghaiToday(instant);
}

export function streaks(
  days: string[],
  today: string,
): { current: number; longest: number } {
  const unique = [...new Set(days)].sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const value of unique) {
    const n = dayNumber(value);
    run = previous !== null && n === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = n;
  }
  const todayNumber = dayNumber(today);
  const present = new Set(unique.map(dayNumber));
  let anchor: number | null = null;
  if (present.has(todayNumber)) anchor = todayNumber;
  else if (present.has(todayNumber - 1)) anchor = todayNumber - 1;
  let current = 0;
  if (anchor !== null) {
    let cursor = anchor;
    while (present.has(cursor)) {
      current += 1;
      cursor -= 1;
    }
  }
  return { current, longest };
}

export function inclusiveDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n += 1)
    out.push(dayFromNumber(n));
  return out;
}
