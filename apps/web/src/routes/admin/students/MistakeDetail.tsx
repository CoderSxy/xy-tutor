import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  filterSearch,
  useMistakeDetail,
  useMistakeEvents,
} from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import { stateLabels } from "../../../lib/types";
import type { StudentOutletContext } from "./StudentLayout";

const PAGE_SIZE = 20;

const EVENT_LABELS: Record<string, string> = {
  added: "加入错题",
  transition: "状态流转",
  corrected: "完成订正",
  reviewed: "复习",
  mastered: "标记掌握",
  reopened: "重新打开",
};

export function MistakeDetail() {
  const { studentId = "", mistakeId } =
    useParams<{ studentId: string; mistakeId: string }>();
  const { filter, listSearch } = useOutletContext<StudentOutletContext>();
  const [offset, setOffset] = useState(0);
  const detail = useMistakeDetail(studentId, mistakeId);
  const events = useMistakeEvents(studentId, mistakeId, {
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <div className="insight-detail-page">
      <p className="insight-back">
        <Link
          to={`/admin/students/${encodeURIComponent(studentId)}/mistakes${filterSearch(filter)}`}
          state={{ listSearch }}
        >
          ← 返回错题列表
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
              <h1>错题详情</h1>
              <p className="muted">
                {stateLabels[detail.data.mistake.status] ??
                  detail.data.mistake.status}
                {detail.data.mistake.dueAt
                  ? ` · 下次复习 ${dateTime(detail.data.mistake.dueAt)}`
                  : ""}
              </p>
            </div>

            <section className="panel">
              <div className="section-head">
                <h2>题目</h2>
              </div>
              <p className="insight-attempt-stem">{detail.data.mistake.stem}</p>
              <dl className="insight-mini-stats">
                <div>
                  <dt>知识点</dt>
                  <dd>{detail.data.mistake.knowledgePoint ?? "未标注"}</dd>
                </div>
                <div>
                  <dt>加入时间</dt>
                  <dd>{dateTime(detail.data.mistake.createdAt)}</dd>
                </div>
              </dl>
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>状态变更记录</h2>
                {events.data && (
                  <span className="muted">共 {events.data.total} 条</span>
                )}
              </div>
              {events.loading ? (
                <p className="muted">正在读取变更记录</p>
              ) : events.error ? (
                <p className="muted" role="alert">
                  {events.error}
                </p>
              ) : events.data && events.data.items.length ? (
                <>
                  <div className="insight-table-scroll">
                    <table className="insight-table">
                      <thead>
                        <tr>
                          <th scope="col">时间</th>
                          <th scope="col">类型</th>
                          <th scope="col">状态变化</th>
                          <th scope="col">原因</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.data.items.map((event) => (
                          <tr key={event.id}>
                            <th scope="row">{dateTime(event.createdAt)}</th>
                            <td>{EVENT_LABELS[event.type] ?? event.type}</td>
                            <td>
                              {stateLabels[event.fromState] ?? event.fromState}
                              {" → "}
                              {stateLabels[event.toState] ?? event.toState}
                            </td>
                            <td>{event.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ListPager
                    total={events.data.total}
                    limit={PAGE_SIZE}
                    offset={offset}
                    onChange={setOffset}
                    busy={events.loading}
                  />
                </>
              ) : (
                <p className="muted">暂无状态变更记录。</p>
              )}
            </section>
          </>
        )}
      </InsightStatus>
    </div>
  );
}
