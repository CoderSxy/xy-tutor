import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Field, Select } from "../../../components/ui/field";
import { filterSearch, useTasks } from "../../../features/student-insights/api";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import { dateTime } from "../../../features/student-insights/format";
import { kindLabels } from "../../../lib/types";
import type { StudentOutletContext } from "./StudentLayout";

const PAGE_SIZE = 20;

const STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  abandoned: "已结束",
};

export function Records() {
  const { studentId, filter, listSearch } =
    useOutletContext<StudentOutletContext>();
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
  const result = useTasks(studentId, filter, {
    status,
    kind,
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <div className="insight-list-page">
      <div className="insight-list-filters" role="group" aria-label="学习记录筛选">
        <Field label="任务状态">
          <Select
            value={status}
            onChange={(event) => {
              setOffset(0);
              setStatus(event.target.value);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="任务类型">
          <Select
            value={kind}
            onChange={(event) => {
              setOffset(0);
              setKind(event.target.value);
            }}
          >
            <option value="">全部类型</option>
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <InsightStatus
        loading={result.loading}
        error={result.error}
        status={result.errorStatus}
        onRetry={result.reload}
        empty={!!result.data && result.data.items.length === 0}
        emptyTitle="所选区间暂无学习记录"
        emptyDetail={<p>可调整日期范围或教材后重试。</p>}
      >
        {result.data && (
          <section className="panel">
            <div className="section-head">
              <h2>学习任务</h2>
              <span className="muted">共 {result.data.total} 条</span>
            </div>
            <div className="insight-table-scroll">
              <table className="insight-table">
                <thead>
                  <tr>
                    <th scope="col">任务</th>
                    <th scope="col">类型</th>
                    <th scope="col">状态</th>
                    <th scope="col">创建时间</th>
                    <th scope="col">完成情况</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((task) => (
                    <tr key={task.id}>
                      <th scope="row">
                        <Link
                          to={`/admin/students/${encodeURIComponent(studentId)}/records/${encodeURIComponent(task.id)}${filterSearch(filter)}`}
                          state={{ listSearch }}
                        >
                          {task.title?.trim() || "未命名任务"}
                        </Link>
                      </th>
                      <td>{kindLabels[task.kind] ?? task.kind}</td>
                      <td>{STATUS_LABELS[task.status] ?? task.status}</td>
                      <td>{dateTime(task.createdAt)}</td>
                      <td>
                        {task.answeredCount}/{task.itemCount} 题
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ListPager
              total={result.data.total}
              limit={PAGE_SIZE}
              offset={offset}
              onChange={setOffset}
              busy={result.loading}
            />
          </section>
        )}
      </InsightStatus>
    </div>
  );
}
