import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { InsightFilter } from "../../../../../packages/contracts/src/student-insights.js";

export function shanghaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(day: string, amount: number): string {
  const parts = day.split("-").map(Number);
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const date = parts[2] ?? 1;
  const value = new Date(Date.UTC(year, month - 1, date + amount));
  return value.toISOString().slice(0, 10);
}

export function useInsightFilter(): {
  filter: InsightFilter;
  setFilter: (filter: InsightFilter) => void;
} {
  const [params, setParams] = useSearchParams();
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const revisionId = params.get("revisionId");
  const filter = useMemo(() => {
    const to = toParam ?? shanghaiToday();
    return {
      from: fromParam ?? addDays(to, -29),
      to,
      ...(revisionId ? { revisionId } : {}),
    };
  }, [fromParam, toParam, revisionId]);
  const setFilter = useCallback(
    (next: InsightFilter) => {
      setParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          updated.set("from", next.from);
          updated.set("to", next.to);
          if (next.revisionId) updated.set("revisionId", next.revisionId);
          else updated.delete("revisionId");
          updated.delete("offset");
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { filter, setFilter };
}
