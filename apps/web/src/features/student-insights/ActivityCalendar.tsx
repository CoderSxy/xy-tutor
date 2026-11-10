import type { ActivityDay } from "../../../../../packages/contracts/src/student-insights.js";
import { shortDay } from "./format";

function dayLabel(day: ActivityDay): string {
  const visits =
    day.visits === null ? "访问数据未采集" : `访问 ${day.visits} 次`;
  return `${day.date}：学习行为 ${day.events} 次，${visits}`;
}

export function ActivityCalendar({ days }: { days: ActivityDay[] }) {
  if (!days.length) return <p className="muted">所选区间暂无日期数据。</p>;
  return (
    <>
      <div
        className="insight-activity-calendar"
        role="group"
        aria-label="每日学习活跃日历"
      >
        {days.map((day) => (
          <div
            key={day.date}
            className={`insight-activity-day${day.active ? " is-active" : ""}`}
            tabIndex={0}
            aria-label={dayLabel(day)}
          >
            <span className="insight-activity-date">{shortDay(day.date)}</span>
            <span className="insight-activity-count">
              {day.active ? day.events : "·"}
            </span>
          </div>
        ))}
      </div>
      <details className="insight-trend-data insight-activity-data">
        <summary>查看每日数值</summary>
        <div className="insight-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">学习行为</th>
                <th scope="col">访问</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.date}>
                  <th scope="row">{day.date}</th>
                  <td>{day.events}</td>
                  <td>{day.visits === null ? "未采集" : day.visits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
