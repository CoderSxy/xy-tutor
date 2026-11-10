import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type {
  InsightFilter,
  InsightListQuery,
  StudentRowDTO,
} from "../../../../../../packages/contracts/src/student-insights.js";
import { Button } from "../../../components/ui/button";
import { Field, Input, Select } from "../../../components/ui/field";
import { filterSearch, useStudents } from "../../../features/student-insights/api";
import {
  dateTime,
  limitedSample,
  percent,
  sample,
} from "../../../features/student-insights/format";
import { useInsightFilter } from "../../../features/student-insights/filters";
import {
  CoverageNote,
  InsightStatus,
} from "../../../features/student-insights/InsightStatus";
import { InsightFilters } from "../../../features/student-insights/InsightFilters";

const PAGE_SIZE = 20;

const SORTS: { value: NonNullable<InsightListQuery["sort"]>; label: string }[] = [
  { value: "last_learning_at", label: "最近学习时间" },
  { value: "active_days", label: "活跃天数" },
  { value: "first_attempt_accuracy", label: "首次正确率" },
];

const ATTENTIONS: {
  value: NonNullable<InsightListQuery["attention"]>;
  label: string;
}[] = [
  { value: "any", label: "全部学生" },
  { value: "inactive_7d", label: "近 7 天未学习" },
  { value: "pending_corrections_10", label: "待订正 ≥ 10" },
];

function parseSort(value: string | null): NonNullable<InsightListQuery["sort"]> {
  return SORTS.find((item) => item.value === value)?.value ?? "last_learning_at";
}

function parseAttention(
  value: string | null,
): NonNullable<InsightListQuery["attention"]> | undefined {
  if (value === "inactive_7d" || value === "pending_corrections_10") return value;
  return undefined;
}

function RateText({
  label,
  rate,
}: {
  label: string;
  rate: StudentRowDTO["firstAttemptAccuracy"];
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {percent(rate)}
        {rate.value !== null && (
          <small className="muted">
            {" "}
            {sample(rate)}
            {limitedSample(rate) ? " · 样本有限，仅供观察" : ""}
          </small>
        )}
      </dd>
    </div>
  );
}

function StudentCard({
  row,
  filter,
  listSearch,
}: {
  row: StudentRowDTO;
  filter: InsightFilter;
  listSearch: string;
}) {
  const noLearning =
    row.attempts === 0 && row.questions === 0 && !row.lastLearningAt;
  return (
    <article className="insight-student">
      <div className="insight-student-head">
        <div>
          <h3>{row.displayName}</h3>
          <p className="muted">
            {row.studentLogins.length
              ? row.studentLogins.join("、")
              : "未绑定学习账号"}
          </p>
        </div>
        <Button asChild size="small" variant="outline">
          <Link
            to={{
              pathname: `/admin/students/${encodeURIComponent(row.studentId)}/overview`,
              search: filterSearch(filter),
            }}
            state={{ listSearch }}
          >
            查看学情
          </Link>
        </Button>
      </div>
      {noLearning ? (
        <p className="muted">暂无学习记录</p>
      ) : (
        <>
          <dl className="insight-student-stats">
            <div>
              <dt>最近学习</dt>
              <dd>{dateTime(row.lastLearningAt)}</dd>
            </div>
            <div>
              <dt>活跃天数</dt>
              <dd>{row.activeDays} 天</dd>
            </div>
            <div>
              <dt>作答 / 题目</dt>
              <dd>
                {row.attempts} 次 / {row.questions} 道
              </dd>
            </div>
            <RateText label="首次正确率" rate={row.firstAttemptAccuracy} />
            <div>
              <dt>待订正 / 待复习</dt>
              <dd>
                {row.pendingCorrections} / {row.pendingReviews}
              </dd>
            </div>
            <RateText label="任务完成率" rate={row.taskCompletion} />
          </dl>
          <p className="insight-attention">
            {row.attentionReasons.length ? (
              <>
                <strong>关注：</strong>
                {row.attentionReasons
                  .map((reason) => reason.label)
                  .join("；")}
              </>
            ) : (
              <span className="muted">暂无关注项</span>
            )}
          </p>
        </>
      )}
    </article>
  );
}

export function Students() {
  const { filter, setFilter } = useInsightFilter();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const urlKeyword = params.get("q") ?? "";
  const [keyword, setKeyword] = useState(urlKeyword);
  useEffect(() => setKeyword(urlKeyword), [urlKeyword]);
  const sort = parseSort(params.get("sort"));
  const attention = parseAttention(params.get("attention"));
  const parsedOffset = Number(params.get("offset") ?? "0");
  const offset =
    Number.isFinite(parsedOffset) && parsedOffset > 0
      ? Math.floor(parsedOffset)
      : 0;
  const result = useStudents({
    filter,
    ...(urlKeyword.trim() ? { q: urlKeyword.trim() } : {}),
    sort,
    ...(attention ? { attention } : {}),
    limit: PAGE_SIZE,
    offset,
  });

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (!("offset" in changes)) next.delete("offset");
    setParams(next, { replace: true });
  };

  const onFilterChange = (next: InsightFilter) => {
    setFilter(next);
  };

  return (
    <>
      <div className="page-heading">
        <h1>学生学情</h1>
        <p>
          按学习区间查看已建档学生的作答、错题和任务进度。所有指标来自已有学习记录，缺失样本不做推算。
        </p>
      </div>
      {result.data && (
        <>
          <dl className="insight-summary" aria-label="学情区间汇总">
            <div>
              <dt>已建档学生</dt>
              <dd>{result.data.summary.students}</dd>
            </div>
            <div>
              <dt>区间活跃人数</dt>
              <dd>{result.data.summary.activeStudents}</dd>
            </div>
            <div>
              <dt>区间作答次数</dt>
              <dd>{result.data.summary.attempts}</dd>
            </div>
            <div>
              <dt>区间新增错题</dt>
              <dd>{result.data.summary.newMistakes}</dd>
            </div>
          </dl>
          <CoverageNote meta={result.data.meta} />
        </>
      )}
      <section className="panel insight-controls" aria-label="学生列表筛选">
        <InsightFilters filter={filter} onChange={onFilterChange} />
        <form
          className="insight-search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: keyword.trim() || null });
          }}
        >
          <Field label="搜索学生">
            <Input
              type="search"
              value={keyword}
              maxLength={80}
              placeholder="姓名或学习账号"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </Field>
          <Button type="submit" size="small">
            搜索
          </Button>
        </form>
        <div className="form-grid">
          <Field label="排序">
            <Select
              value={sort}
              onChange={(event) => update({ sort: event.target.value })}
            >
              {SORTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="关注筛选">
            <Select
              value={attention ?? "any"}
              onChange={(event) =>
                update({
                  attention:
                    event.target.value === "any" ? null : event.target.value,
                })
              }
            >
              {ATTENTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <div className="section-spacer" />
      <InsightStatus
        loading={result.loading}
        error={result.error}
        status={result.errorStatus}
        onRetry={result.reload}
        empty={!result.loading && !!result.data && result.data.items.length === 0}
        emptyTitle="没有符合条件的学生"
        emptyDetail={<p>调整筛选条件，或清空搜索关键词后再试。</p>}
      >
        {result.data && (
          <>
            <div className="insight-list-head">
              <p className="muted">
                共 {result.data.total} 人
                {result.data.total > 0
                  ? `，当前显示第 ${offset + 1}–${Math.min(
                      offset + PAGE_SIZE,
                      result.data.total,
                    )} 人`
                  : ""}
                。空学生仍会列出，但显示“暂无学习记录”。
              </p>
            </div>
            <div className="insight-student-list">
              {result.data.items.map((row) => (
                <StudentCard
                  key={row.studentId}
                  row={row}
                  filter={filter}
                  listSearch={location.search}
                />
              ))}
            </div>
            {result.data.total > PAGE_SIZE && (
              <div className="form-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="small"
                  disabled={offset === 0}
                  onClick={() =>
                    update({
                      offset: String(Math.max(0, offset - PAGE_SIZE)),
                    })
                  }
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="small"
                  disabled={offset + PAGE_SIZE >= result.data.total}
                  onClick={() =>
                    update({ offset: String(offset + PAGE_SIZE) })
                  }
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}
      </InsightStatus>
    </>
  );
}
