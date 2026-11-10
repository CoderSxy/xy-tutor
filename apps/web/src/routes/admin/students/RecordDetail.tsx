import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  filterSearch,
  useTaskAttempts,
  useTaskDetail,
} from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import { ReadOnlyConversation } from "../../../features/student-insights/ReadOnlyConversation";
import { kindLabels } from "../../../lib/types";
import type { StudentOutletContext } from "./StudentLayout";

const PAGE_SIZE = 20;

const STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  abandoned: "已结束",
};

const CORRECTNESS_LABELS: Record<string, string> = {
  correct: "正确",
  incorrect: "错误",
  pending: "待核验",
  unknown: "未知",
};

const VERIFICATION_LABELS: Record<string, string> = {
  verified: "已核验",
  pending: "待核验",
};

const HINT_LABELS: Record<string, string> = {
  none: "无提示",
  hint: "使用提示",
  answer: "查看答案",
};

export function RecordDetail() {
  const { studentId = "", taskId } =
    useParams<{ studentId: string; taskId: string }>();
  const { filter, listSearch } = useOutletContext<StudentOutletContext>();
  const [offset, setOffset] = useState(0);
  const [attemptOffset, setAttemptOffset] = useState(0);
  const detail = useTaskDetail(studentId, taskId, {
    limit: PAGE_SIZE,
    offset,
  });
  const attempts = useTaskAttempts(studentId, taskId, {
    limit: PAGE_SIZE,
    offset: attemptOffset,
  });

  return (
    <div className="insight-detail-page">
      <p className="insight-back">
        <Link
          to={`/admin/students/${encodeURIComponent(studentId)}/records${filterSearch(filter)}`}
          state={{ listSearch }}
        >
          ← 返回学习记录
        </Link>
      </p>
      <InsightStatus
        loading={detail.loading}
        error={detail.error}
        status={detail.errorStatus}
        onRetry={detail.reload}
      >
        {detail.data && (
          <>
            <div className="page-heading insight-detail-heading">
              <h1>{detail.data.task.title?.trim() || "未命名任务"}</h1>
              <p className="muted">
                {kindLabels[detail.data.task.kind] ?? detail.data.task.kind} ·{" "}
                {STATUS_LABELS[detail.data.task.status] ??
                  detail.data.task.status}
              </p>
              <p className="muted">
                创建于 {dateTime(detail.data.task.createdAt)} · 更新于{" "}
                {dateTime(detail.data.task.updatedAt)}
              </p>
            </div>

            <section className="panel">
              <div className="section-head">
                <h2>任务题目</h2>
                <span className="muted">
                  已答 {detail.data.task.answeredCount}/
                  {detail.data.task.itemCount} 题
                </span>
              </div>
              {detail.data.items.items.length ? (
                <>
                  <div className="insight-table-scroll">
                    <table className="insight-table">
                      <thead>
                        <tr>
                          <th scope="col">序号</th>
                          <th scope="col">题目</th>
                          <th scope="col">知识点</th>
                          <th scope="col">作答状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.items.items.map((item) => (
                          <tr key={item.id}>
                            <th scope="row">{item.position + 1}</th>
                            <td>{item.stem}</td>
                            <td>{item.knowledgePoint ?? "未标注"}</td>
                            <td>{item.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ListPager
                    total={detail.data.items.total}
                    limit={PAGE_SIZE}
                    offset={offset}
                    onChange={setOffset}
                    busy={detail.loading}
                  />
                </>
              ) : (
                <p className="muted">该任务没有题目记录。</p>
              )}
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>作答与核验</h2>
                {attempts.data && (
                  <span className="muted">共 {attempts.data.total} 条</span>
                )}
              </div>
              {attempts.loading ? (
                <p className="muted">正在读取作答记录</p>
              ) : attempts.error ? (
                <p className="muted" role="alert">
                  {attempts.error}
                </p>
              ) : attempts.data && attempts.data.items.length ? (
                <>
                  <ol className="insight-attempt-list">
                    {attempts.data.items.map((attempt) => (
                      <li key={attempt.id} className="insight-attempt">
                        <header>
                          <span className="muted">
                            {dateTime(attempt.createdAt)}
                          </span>
                          {attempt.assessment && (
                            <strong>
                              {CORRECTNESS_LABELS[
                                attempt.assessment.correctness
                              ] ?? attempt.assessment.correctness}
                              {" · "}
                              {VERIFICATION_LABELS[
                                attempt.assessment.verification
                              ] ?? attempt.assessment.verification}
                            </strong>
                          )}
                        </header>
                        <p className="insight-attempt-stem">{attempt.stem}</p>
                        <div className="insight-attempt-answer">
                          <span className="muted">学生答案</span>
                          <p>{attempt.answer}</p>
                        </div>
                        {attempt.hints.length > 0 && (
                          <div className="insight-attempt-hints">
                            <span className="muted">使用提示</span>
                            <ul>
                              {attempt.hints.map((hint, index) => (
                                <li key={`${attempt.id}-${index}`}>
                                  {HINT_LABELS[hint.level] ?? hint.level}：
                                  {hint.content}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {attempt.assessment?.feedback && (
                          <p className="muted">
                            核验反馈：{attempt.assessment.feedback}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                  <ListPager
                    total={attempts.data.total}
                    limit={PAGE_SIZE}
                    offset={attemptOffset}
                    onChange={setAttemptOffset}
                    busy={attempts.loading}
                  />
                </>
              ) : (
                <p className="muted">该任务暂无作答记录。</p>
              )}
            </section>

            {detail.data.task.conversationId && (
              <ReadOnlyConversation
                studentId={studentId}
                conversationId={detail.data.task.conversationId}
              />
            )}
          </>
        )}
      </InsightStatus>
    </div>
  );
}
