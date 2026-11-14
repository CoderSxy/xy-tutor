import type {
  LearningEvaluationDTO,
  MetricRatio,
} from "../../../../../packages/contracts/src/learning-evaluation.js";
import type { InsightFilter } from "../../../../../packages/contracts/src/student-insights.js";
import { useLearningEvaluation } from "./api";
import { dateTime, percent, sample } from "./format";

const EFFICIENCY_REASONS: Record<string, string> = {
  SAMPLES_BELOW_MINIMUM: "样本不足，暂不比较",
  BASELINE_MISSING: "缺少冻结基线",
};

function metricText(rate: MetricRatio): string {
  return rate.value === null ? "—" : percent(rate);
}

function Metric({
  label,
  rate,
  note,
}: {
  label: string;
  rate: MetricRatio;
  note?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{metricText(rate)}</dd>
      <small className="muted">
        {rate.denominator ? sample(rate) : "无样本"}
        {note ? ` · ${note}` : ""}
      </small>
    </div>
  );
}

function Layers({
  title,
  layers,
}: {
  title: string;
  layers: Record<string, MetricRatio>;
}) {
  const entries = Object.entries(layers);
  if (!entries.length) return null;
  return (
    <p className="muted">
      {title}：
      {entries
        .map(([key, rate]) => `${key} ${metricText(rate)}（${sample(rate)}）`)
        .join("，")}
    </p>
  );
}

function GroupNote({ evaluation }: { evaluation: LearningEvaluationDTO }) {
  const group = evaluation.groupReference;
  if (!group.enabled)
    return (
      <p className="muted">
        群体参照未启用；当前只把该学生与自身冻结基线比较，不与同学横向排名。
      </p>
    );
  if (!group.available)
    return (
      <p className="muted">
        群体样本未达匿名门槛（30 名学生、100 条样本、每人最多 5 条），暂不展示群体参照。
        {group.reasonCodes.length
          ? `（${group.reasonCodes.join("、")}）`
          : ""}
      </p>
    );
  return (
    <p className="muted">
      群体参照：{group.studentCount} 名学生、{group.sampleCount} 条匿名样本，每人最多计{" "}
      {group.maxSamplesPerStudent} 条。
    </p>
  );
}

export function LearningEvaluationPanel({
  studentId,
  filter,
}: {
  studentId: string;
  filter: InsightFilter;
}) {
  const { data, loading, error, reload } = useLearningEvaluation(
    studentId,
    filter,
  );

  return (
    <section className="panel insight-panel-wide">
      <div className="section-head">
        <h2>独立学习与效率证据</h2>
        {data && <span className="muted">样本 {data.sampleSize} 条</span>}
      </div>
      <p className="muted">
        只统计可核验的首次作答与已复核诊断：无数据时显示“—”而不是 0；看过解析、使用提示或此前做过的题不计入独立新题。
      </p>

      {loading && <p className="muted">正在计算学习证据指标…</p>}
      {!loading && error && (
        <p className="insight-analysis-error" role="alert">
          {error}{" "}
          <button type="button" className="link-button" onClick={reload}>
            重试
          </button>
        </p>
      )}

      {!loading && !error && data && (
        <>
          <dl className="insight-summary" aria-label="独立学习指标">
            <Metric
              label="独立新题正确率"
              rate={data.metrics.independentNewCorrect}
              note="仅在独立且核验可判定的首答中计算"
            />
            <Metric
              label="独立作答覆盖率"
              rate={data.metrics.independentCoverage}
              note="全部新题中独立作答的占比"
            />
            <Metric label="自查成功率" rate={data.metrics.selfCheckSuccess.overall} />
            <Metric
              label="复习完成率"
              rate={data.metrics.delayedReview.completion}
            />
            <Metric
              label="复习通过率"
              rate={data.metrics.delayedReview.pass}
              note="分母为已完成复习"
            />
            <Metric
              label="确认诊断精确率"
              rate={data.metrics.confirmedDiagnosis.overall}
              note="分母为已复核确认的诊断"
            />
            <Metric
              label="诊断覆盖率"
              rate={data.metrics.diagnosisCoverage}
              note={`待补证据 ${data.metrics.diagnosisGaps.insufficient} 例 · 证据不支持 ${data.metrics.diagnosisGaps.unsupported} 例`}
            />
            <Metric
              label="计时可靠率"
              rate={data.metrics.timing.reliable}
              note={`计时覆盖 ${sample(data.metrics.timing.coverage)}`}
            />
            <Metric label="题目质量" rate={data.metrics.questionQuality} />
          </dl>

          <Layers
            title="自查分层（按触发点）"
            layers={data.metrics.selfCheckSuccess.byAnchor}
          />
          <Layers
            title="自查分层（按提示层级）"
            layers={data.metrics.selfCheckSuccess.byHintLevel}
          />
          <Layers
            title="诊断分层（按错因）"
            layers={data.metrics.confirmedDiagnosis.byCode}
          />

          <h3 className="insight-subheading">同题桶效率对比</h3>
          {data.metrics.efficiency.length ? (
            <div className="insight-table-scroll">
              <table className="insight-table">
                <thead>
                  <tr>
                    <th scope="col">题桶</th>
                    <th scope="col">样本</th>
                    <th scope="col">中位用时</th>
                    <th scope="col">冻结基线</th>
                    <th scope="col">变化</th>
                    <th scope="col">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {data.metrics.efficiency.map((bucket) => (
                    <tr key={bucket.bucketKey}>
                      <td>{bucket.bucketKey}</td>
                      <td>{bucket.sampleCount}</td>
                      <td>
                        {bucket.medianMs === null
                          ? "—"
                          : `${Math.round(bucket.medianMs / 100) / 10} 秒`}
                      </td>
                      <td>
                        {bucket.baselineMedianMs === null
                          ? "—"
                          : `${Math.round(bucket.baselineMedianMs / 100) / 10} 秒（${bucket.baselineSampleCount} 条）`}
                      </td>
                      <td>
                        {bucket.comparable && bucket.changeRatio !== null
                          ? `${bucket.changeRatio > 0 ? "+" : ""}${Math.round(bucket.changeRatio * 100)}%`
                          : "不可比较"}
                      </td>
                      <td>
                        {bucket.reasonCodes.length
                          ? bucket.reasonCodes
                              .map(
                                (code) =>
                                  EFFICIENCY_REASONS[code] ?? code,
                              )
                              .join("、")
                          : "同题桶、同质量下比较"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">
              暂无可比题桶；不同难度或质量层级的用时不会被合并成“速度提升”。
            </p>
          )}

          <GroupNote evaluation={data} />

          {data.staleEvidenceCount > 0 && (
            <p className="muted" role="status">
              本区间有 {data.staleEvidenceCount} 条证据在生成快照后被撤销，本次指标已排除；历史报告保持生成时的内容，不会静默重算。
            </p>
          )}

          <p className="muted">
            快照生成于 {dateTime(data.generatedAt)}，数据截至{" "}
            {dateTime(data.dataAsOf)}。
          </p>
        </>
      )}
    </section>
  );
}
