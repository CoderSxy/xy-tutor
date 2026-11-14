import { useOutletContext } from "react-router-dom";
import type {
  KnowledgeSummary,
  MaterialCoverage,
  MistakeCounts,
  Rate,
} from "../../../../../../packages/contracts/src/student-insights.js";
import { limitedSample, percent, sample } from "../../../features/student-insights/format";
import { CoverageNote } from "../../../features/student-insights/InsightStatus";
import { InsightTrend } from "../../../features/student-insights/InsightTrend";
import { LearningEvaluationPanel } from "../../../features/student-insights/LearningEvaluationPanel";
import { useAuth } from "../../../lib/auth";
import type { StudentOutletContext } from "./StudentLayout";

const MISTAKE_LABELS: Record<keyof MistakeCounts, string> = {
  pending_correction: "待订正",
  correcting: "订正中",
  corrected_pending_practice: "已订正待练习",
  consolidated_pending_review: "已巩固待复习",
  mastered: "已掌握",
};

const HINT_LABELS: Record<string, string> = {
  none: "无提示",
  hint: "使用提示",
  answer: "查看答案",
};

const MATERIAL_TYPES: Record<string, string> = {
  homework: "作业",
  exam: "试卷",
  practice: "练习",
};

const MATERIAL_STATUS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  processing: "处理中",
  failed: "失败",
};

function rateOf(correct: number, verified: number): Rate {
  return {
    numerator: correct,
    denominator: verified,
    value: verified ? correct / verified : null,
  };
}

function KnowledgeRow({ item }: { item: KnowledgeSummary }) {
  const rate = rateOf(item.correct, item.verified);
  const hints = Object.entries(item.hintDependency).filter(
    ([, count]) => count > 0,
  );
  return (
    <tr>
      <th scope="row">{item.knowledgePoint}</th>
      <td>{item.attempts}</td>
      <td>{item.verified}</td>
      <td>
        {percent(rate)}
        {rate.value !== null && (
          <small className="muted"> {sample(rate)}</small>
        )}
      </td>
      <td>
        {hints.length
          ? hints
              .map(
                ([key, count]) =>
                  `${HINT_LABELS[key] ?? key} ${count}`,
              )
              .join("、")
          : "无提示记录"}
      </td>
    </tr>
  );
}

function MaterialRow({ item }: { item: MaterialCoverage }) {
  return (
    <div className="insight-material">
      <div>
        <strong>{item.name}</strong>
        <p className="muted">
          {MATERIAL_TYPES[item.type] ?? item.type} ·{" "}
          {MATERIAL_STATUS[item.status] ?? item.status}
        </p>
      </div>
      <div className="insight-material-counts">
        <span>
          已答 {item.answeredQuestions}/{item.totalQuestions} 题
        </span>
        <span className="muted">
          <span className="verify-dot" aria-hidden />
          已核验 {item.verifiedQuestions} 题
        </span>
      </div>
    </div>
  );
}

export function Overview() {
  const { studentId, overview, meta, filter } =
    useOutletContext<StudentOutletContext>();
  const { capabilities } = useAuth();
  const evaluationEnabled = capabilities?.learningEvaluation === "enabled";
  const counts = overview.counts;
  const noLearning =
    counts.attempts === 0 &&
    counts.questions === 0 &&
    counts.tasks === 0 &&
    !overview.lastLearningAt;
  const mistakes = Object.entries(counts.mistakes) as [
    keyof MistakeCounts,
    number,
  ][];
  return (
    <div className="insight-overview">
      <CoverageNote meta={meta} />
      {noLearning && <p className="insight-empty-note">这位学生还没有作答记录。</p>}
      <dl className="insight-summary" aria-label="学生核心指标">
        <div>
          <dt>作答次数</dt>
          <dd>{counts.attempts}</dd>
          <small className="muted">
            题目 {counts.questions} 道 ·{" "}
            <span className="verify-state">
              <span className="verify-dot is-pending" aria-hidden />
              待核验 {counts.firstAttemptPending}
            </span>
          </small>
        </div>
        <div>
          <dt>首次正确率</dt>
          <dd>{percent(overview.firstAttemptAccuracy)}</dd>
          <small className="muted">
            {overview.firstAttemptAccuracy.value !== null
              ? `${sample(overview.firstAttemptAccuracy)}${
                  limitedSample(overview.firstAttemptAccuracy)
                    ? " · 样本有限，仅供观察"
                    : ""
                }`
              : "暂无可核验样本"}
          </small>
        </div>
        <div>
          <dt>任务完成率</dt>
          <dd>{percent(overview.taskCompletion)}</dd>
          <small className="muted">
            本期创建任务当前完成率
            {overview.taskCompletion.value !== null
              ? ` · ${sample(overview.taskCompletion)}`
              : ""}
          </small>
        </div>
        <div>
          <dt>活跃天数</dt>
          <dd>{counts.activeDays} 天</dd>
          <small className="muted">
            当前连续 {counts.currentStreak} 天 · 最长 {counts.longestStreak} 天
          </small>
        </div>
      </dl>

      <div className="insight-grid">
        <section className="panel insight-panel-wide">
          <div className="section-head">
            <h2>每日学习趋势</h2>
          </div>
          <InsightTrend points={overview.daily} />
        </section>

        <section className="panel">
          <div className="section-head">
            <h2>学习任务</h2>
          </div>
          <dl className="insight-mini-stats">
            <div>
              <dt>本期创建</dt>
              <dd>{counts.tasks}</dd>
            </div>
            <div>
              <dt>已完成</dt>
              <dd>{counts.completedTasks}</dd>
            </div>
            <div>
              <dt>未完成</dt>
              <dd>{Math.max(0, counts.tasks - counts.completedTasks)}</dd>
            </div>
          </dl>
          <p className="muted">
            仅统计所选区间内创建的任务，当前完成情况会随后续学习变化。
          </p>
        </section>

        <section className="panel">
          <div className="section-head">
            <h2>当前错题状态</h2>
          </div>
          <p className="muted">区间新增错题 {counts.newMistakes} 道。</p>
          <ul className="insight-status-list">
            {mistakes.map(([key, value]) => (
              <li key={key}>
                <span>{MISTAKE_LABELS[key]}</span>
                <strong>{value}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel insight-panel-wide">
          <div className="section-head">
            <h2>知识点证据样本</h2>
          </div>
          {overview.knowledge.length ? (
            <>
              <div className="insight-table-scroll">
                <table className="insight-table">
                  <thead>
                    <tr>
                      <th scope="col">知识点</th>
                      <th scope="col">作答</th>
                      <th scope="col">已核验</th>
                      <th scope="col">首次正确率</th>
                      <th scope="col">提示依赖</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.knowledge.map((item) => (
                      <KnowledgeRow key={item.knowledgePoint} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                已核验样本少于 5 条的知识点仅供观察，不据此下结论。
              </p>
            </>
          ) : (
            <p className="muted">暂无可核验样本。</p>
          )}
        </section>

        {evaluationEnabled && (
          <LearningEvaluationPanel studentId={studentId} filter={filter} />
        )}

        <section className="panel">
          <div className="section-head">
            <h2>资料覆盖</h2>
          </div>
          {overview.materials.length ? (
            <div className="insight-material-list">
              {overview.materials.map((item) => (
                <MaterialRow key={item.materialId} item={item} />
              ))}
            </div>
          ) : (
            <p className="muted">还没有可用的资料。</p>
          )}
        </section>
      </div>
    </div>
  );
}
