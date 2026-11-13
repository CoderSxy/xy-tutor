import type { DailyPoint } from "../../../../../packages/contracts/src/student-insights.js";
import { percent, shortDay } from "./format";

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 20, right: 24, bottom: 30, left: 40 };

export function InsightTrend({ points }: { points: DailyPoint[] }) {
  const totalAttempts = points.reduce((sum, point) => sum + point.attempts, 0);
  if (!points.length || totalAttempts === 0)
    return <p className="muted">暂无学习记录</p>;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const maxAttempts = Math.max(1, ...points.map((point) => point.attempts));
  const xAt = (index: number) =>
    points.length === 1
      ? PAD.left + plotWidth / 2
      : PAD.left + (index / (points.length - 1)) * plotWidth;
  const accuracyY = (value: number) => PAD.top + (1 - value) * plotHeight;
  const barWidth = Math.min(18, Math.max(2, (plotWidth / points.length) * 0.55));
  const accuracyPoints = points.flatMap((point, index) =>
    point.firstAttempts.value === null
      ? []
      : [{ index, value: point.firstAttempts.value }],
  );
  const labelIndices = Array.from(
    new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]),
  );
  const lastAccuracy = accuracyPoints[accuracyPoints.length - 1];
  const summary = `${first.date} 至 ${last.date}，共 ${totalAttempts} 次作答${
    lastAccuracy
      ? `，最后有样本的日期首次正确率 ${Math.round(lastAccuracy.value * 100)}%`
      : "，期间暂无可核验样本"
  }。`;
  return (
    <div className="insight-trend">
      <svg
        className="insight-trend-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
      >
        <title>{summary}</title>
        {[0, 0.5, 1].map((ratio) => {
          const y = PAD.top + ratio * plotHeight;
          const value = Math.round(maxAttempts * (1 - ratio));
          return (
            <g key={ratio}>
              <line
                x1={PAD.left}
                y1={y}
                x2={WIDTH - PAD.right}
                y2={y}
                className="trend-grid"
                strokeWidth="1"
              />
              <text
                className="trend-axis"
                x={PAD.left - 8}
                y={y + 4}
                textAnchor="end"
                fontSize="12"
              >
                {value}
              </text>
            </g>
          );
        })}
        {points.map((point, index) => {
          const height = (point.attempts / maxAttempts) * plotHeight;
          return (
            <rect
              key={point.date}
              x={xAt(index) - barWidth / 2}
              y={PAD.top + plotHeight - height}
              width={barWidth}
              height={Math.max(point.attempts > 0 ? 2 : 0, height)}
              rx="2"
              className="trend-bar"
            >
              <title>
                {point.date}：作答 {point.attempts} 次，题目 {point.questions} 道
              </title>
            </rect>
          );
        })}
        {accuracyPoints.length > 1 && (
          <polyline
            fill="none"
            className="trend-line"
            strokeWidth="2"
            strokeLinejoin="round"
            points={accuracyPoints
              .map(({ index, value }) => `${xAt(index)},${accuracyY(value)}`)
              .join(" ")}
          />
        )}
        {accuracyPoints.map(({ index, value }) => (
          <circle
            key={`accuracy-${points[index]!.date}`}
            cx={xAt(index)}
            cy={accuracyY(value)}
            r="3.5"
            className="trend-dot"
          >
            <title>
              {points[index]!.date}：首次正确率 {Math.round(value * 100)}%
            </title>
          </circle>
        ))}
        {lastAccuracy && (
          <text
            x={Math.min(
              xAt(lastAccuracy.index) + 8,
              WIDTH - PAD.right - 96,
            )}
            y={Math.max(PAD.top + 10, accuracyY(lastAccuracy.value) - 8)}
            fontSize="12"
            className="trend-callout"
          >
            首次正确率 {Math.round(lastAccuracy.value * 100)}%
          </text>
        )}
        {labelIndices.map((index) => (
          <text
            key={`label-${points[index]!.date}`}
            x={xAt(index)}
            y={HEIGHT - 8}
            textAnchor="middle"
            fontSize="12"
            className="trend-axis"
          >
            {shortDay(points[index]!.date)}
          </text>
        ))}
      </svg>
      <p className="insight-trend-legend muted">
        柱形为每日作答次数；折线为首次正确率，分母为零的日期不绘制。
      </p>
      <details className="insight-trend-data">
        <summary>查看每日数值</summary>
        <div className="insight-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">作答次数</th>
                <th scope="col">题目数</th>
                <th scope="col">首次正确率</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date}>
                  <th scope="row">{point.date}</th>
                  <td>{point.attempts}</td>
                  <td>{point.questions}</td>
                  <td>{percent(point.firstAttempts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
