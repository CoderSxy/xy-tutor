import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Button } from "../../../components/ui/button";
import { Field, Input, Select } from "../../../components/ui/field";
import { filterSearch, useMistakes } from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import { stateLabels } from "../../../lib/types";
import type { StudentOutletContext } from "./StudentLayout";

const PAGE_SIZE = 20;

export function Mistakes() {
  const { studentId, filter, listSearch } =
    useOutletContext<StudentOutletContext>();
  const [status, setStatus] = useState("");
  const [pointDraft, setPointDraft] = useState("");
  const [knowledgePoint, setKnowledgePoint] = useState("");
  const [offset, setOffset] = useState(0);
  const result = useMistakes(studentId, filter, {
    status,
    knowledgePoint,
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <div className="insight-list-page">
      <form
        className="insight-list-filters"
        role="search"
        aria-label="错题筛选"
        onSubmit={(event) => {
          event.preventDefault();
          setOffset(0);
          setKnowledgePoint(pointDraft.trim());
        }}
      >
        <Field label="错题状态">
          <Select
            value={status}
            onChange={(event) => {
              setOffset(0);
              setStatus(event.target.value);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(stateLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="知识点">
          <Input
            value={pointDraft}
            maxLength={120}
            placeholder="输入知识点关键词"
            onChange={(event) => setPointDraft(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" size="small">
          筛选
        </Button>
      </form>

      <InsightStatus
        loading={result.loading}
        error={result.error}
        status={result.errorStatus}
        onRetry={result.reload}
        empty={!!result.data && result.data.items.length === 0}
        emptyTitle="所选区间暂无错题"
        emptyDetail={<p>可调整日期范围、状态或知识点后重试。</p>}
      >
        {result.data && (
          <section className="panel">
            <div className="section-head">
              <h2>错题记录</h2>
              <span className="muted">共 {result.data.total} 条</span>
            </div>
            <div className="insight-table-scroll">
              <table className="insight-table">
                <thead>
                  <tr>
                    <th scope="col">题目</th>
                    <th scope="col">知识点</th>
                    <th scope="col">状态</th>
                    <th scope="col">加入时间</th>
                    <th scope="col">下次复习</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((mistake) => (
                    <tr key={mistake.id}>
                      <th scope="row">
                        <Link
                          to={`/admin/students/${encodeURIComponent(studentId)}/mistakes/${encodeURIComponent(mistake.id)}${filterSearch(filter)}`}
                          state={{ listSearch }}
                        >
                          {mistake.stem}
                        </Link>
                      </th>
                      <td>{mistake.knowledgePoint ?? "未标注"}</td>
                      <td>{stateLabels[mistake.status] ?? mistake.status}</td>
                      <td>{dateTime(mistake.createdAt)}</td>
                      <td>
                        {mistake.dueAt ? dateTime(mistake.dueAt) : "未安排"}
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
