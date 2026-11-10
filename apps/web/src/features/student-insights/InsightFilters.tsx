import type { InsightFilter } from "../../../../../packages/contracts/src/student-insights.js";
import { Button } from "../../components/ui/button";
import { Field, Input, Select } from "../../components/ui/field";
import { useAuth } from "../../lib/auth";
import { addDays, shanghaiToday } from "./filters";

const PRESETS = [7, 30] as const;

export function InsightFilters({
  filter,
  onChange,
}: {
  filter: InsightFilter;
  onChange: (filter: InsightFilter) => void;
}) {
  const { catalog } = useAuth();
  const today = shanghaiToday();
  const preset = PRESETS.find(
    (days) =>
      filter.to === today && filter.from === addDays(today, -(days - 1)),
  );
  const setRange = (days: number) =>
    onChange({
      ...filter,
      from: addDays(today, -(days - 1)),
      to: today,
    });
  const setFrom = (from: string) => {
    if (!from) return;
    onChange({
      ...filter,
      from,
      ...(from > filter.to ? { to: from } : {}),
    });
  };
  const setTo = (to: string) => {
    if (!to) return;
    onChange({
      ...filter,
      to,
      ...(to < filter.from ? { from: to } : {}),
    });
  };
  return (
    <div className="insight-filters" role="group" aria-label="学情筛选">
      <div className="insight-presets">
        {PRESETS.map((days) => (
          <Button
            key={days}
            type="button"
            size="small"
            variant={preset === days ? "primary" : "outline"}
            aria-pressed={preset === days}
            onClick={() => setRange(days)}
          >
            近{days}天
          </Button>
        ))}
      </div>
      <Field label="开始日期">
        <Input
          type="date"
          value={filter.from}
          max={filter.to}
          onChange={(event) => setFrom(event.target.value)}
        />
      </Field>
      <Field label="结束日期">
        <Input
          type="date"
          value={filter.to}
          min={filter.from}
          max={today}
          onChange={(event) => setTo(event.target.value)}
        />
      </Field>
      <Field label="教材">
        <Select
          value={filter.revisionId ?? ""}
          onChange={(event) =>
            onChange({
              ...filter,
              ...(event.target.value
                ? { revisionId: event.target.value }
                : {}),
            })
          }
        >
          <option value="">全部教材</option>
          {catalog.map((revision) => (
            <option key={revision.id} value={revision.id}>
              {revision.title} · 第{revision.revisionNo}版
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
