import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Field, Select } from "../../../components/ui/field";
import { filterSearch, useMaterials } from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import type { StudentOutletContext } from "./StudentLayout";

const PAGE_SIZE = 20;

const TYPE_LABELS: Record<string, string> = {
  homework: "作业",
  exam: "试卷",
  mistake: "错题资料",
  other: "其他",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  processing: "处理中",
  failed: "失败",
};

export function Materials() {
  const { studentId, filter, listSearch } =
    useOutletContext<StudentOutletContext>();
  const [types, setTypes] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const result = useMaterials(studentId, filter, {
    types,
    status,
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <div className="insight-list-page">
      <div className="insight-list-filters" role="group" aria-label="作业与试卷筛选">
        <Field label="资料类型">
          <Select
            value={types}
            onChange={(event) => {
              setOffset(0);
              setTypes(event.target.value);
            }}
          >
            <option value="">全部类型</option>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="资料状态">
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
      </div>

      <InsightStatus
        loading={result.loading}
        error={result.error}
        status={result.errorStatus}
        onRetry={result.reload}
        empty={!!result.data && result.data.items.length === 0}
        emptyTitle="所选区间暂无作业或试卷"
        emptyDetail={<p>可调整日期范围、类型或状态后重试。</p>}
      >
        {result.data && (
          <section className="panel">
            <div className="section-head">
              <h2>作业与试卷</h2>
              <span className="muted">共 {result.data.total} 条</span>
            </div>
            <div className="insight-table-scroll">
              <table className="insight-table">
                <thead>
                  <tr>
                    <th scope="col">资料</th>
                    <th scope="col">类型</th>
                    <th scope="col">状态</th>
                    <th scope="col">作答</th>
                    <th scope="col">已核验</th>
                    <th scope="col">上传时间</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((material) => (
                    <tr key={material.id}>
                      <th scope="row">
                        <Link
                          to={`/admin/students/${encodeURIComponent(studentId)}/materials/${encodeURIComponent(material.id)}${filterSearch(filter)}`}
                          state={{ listSearch }}
                        >
                          {material.name}
                        </Link>
                      </th>
                      <td>{TYPE_LABELS[material.type] ?? material.type}</td>
                      <td>
                        {STATUS_LABELS[material.status] ?? material.status}
                      </td>
                      <td>
                        {material.answered}/{material.questions} 题
                      </td>
                      <td>{material.verified} 题</td>
                      <td>{dateTime(material.createdAt)}</td>
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
