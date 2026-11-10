import type { Rate } from "../../../../../packages/contracts/src/student-insights.js";

export function percent(rate: Rate): string {
  if (rate.value === null) return "暂无可核验样本";
  return `${Math.round(rate.value * 100)}%`;
}

export function sample(rate: Rate): string {
  return `${rate.numerator}/${rate.denominator}`;
}

export function limitedSample(rate: Rate): boolean {
  return rate.denominator > 0 && rate.denominator < 5;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "暂无学习记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function shortDay(day: string): string {
  return day.slice(5);
}
