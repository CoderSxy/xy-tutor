import { useOutletContext } from "react-router-dom";
import { useActivity } from "../../../features/student-insights/api";
import { ActivityCalendar } from "../../../features/student-insights/ActivityCalendar";
import { dateTime } from "../../../features/student-insights/format";
import { CoverageNote, InsightStatus } from "../../../features/student-insights/InsightStatus";
import type { StudentOutletContext } from "./StudentLayout";

export function Activity() {
  const { studentId, filter } = useOutletContext<StudentOutletContext>();
  const result = useActivity(studentId, filter);

  return (
    <div className="insight-activity">
      <InsightStatus
        loading={result.loading}
        error={result.error}
        status={result.errorStatus}
        onRetry={result.reload}
        empty={!!result.data && result.data.activeDays === 0}
        emptyTitle="所选区间暂无学习活跃"
        emptyDetail={<p>可调整日期范围或教材后重试。</p>}
      >
        {result.data && (
          <>
            <CoverageNote meta={result.data.meta} />
            {result.data.meta.coverage.visitsStartedAt && (
              <p className="muted">
                页面访问数据自{" "}
                {dateTime(result.data.meta.coverage.visitsStartedAt)}{" "}
                起采集，此前日期不显示访问次数；访问仅表示打开页面，不作为学习证据。
              </p>
            )}
            <dl className="insight-summary" aria-label="学习活跃指标">
              <div>
                <dt>学习活跃天数</dt>
                <dd>{result.data.activeDays} 天</dd>
                <small className="muted">有学习行为记录的日期</small>
              </div>
              <div>
                <dt>当前连续</dt>
                <dd>{result.data.currentStreak} 天</dd>
                <small className="muted">截至数据截止日期</small>
              </div>
              <div>
                <dt>最长连续</dt>
                <dd>{result.data.longestStreak} 天</dd>
                <small className="muted">所选区间内</small>
              </div>
              <div>
                <dt>有访问记录天数</dt>
                <dd>{result.data.visitedDays} 天</dd>
                <small className="muted">访问与学习分开统计</small>
              </div>
            </dl>
            <section className="panel">
              <div className="section-head">
                <h2>每日学习活跃</h2>
              </div>
              <ActivityCalendar days={result.data.days} />
            </section>
          </>
        )}
      </InsightStatus>
    </div>
  );
}
