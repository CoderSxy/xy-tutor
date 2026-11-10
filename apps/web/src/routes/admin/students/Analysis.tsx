import { useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type {
  ReportStatus,
  ReportSummary,
} from "../../../../../../packages/contracts/src/student-insights.js";
import { Button } from "../../../components/ui/button";
import { useAuth } from "../../../lib/auth";
import { errorMessage } from "../../../lib/api";
import {
  createReport,
  filterSearch,
  useReports,
} from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import type { StudentOutletContext } from "./StudentLayout";

const PAGE_SIZE = 10;

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "生成失败",
};

function ReportRow({
  studentId,
  filterSearchValue,
  listSearch,
  report,
}: {
  studentId: string;
  filterSearchValue: string;
  listSearch: string;
  report: ReportSummary;
}) {
  return (
    <tr>
      <td>{dateTime(report.createdAt)}</td>
      <td>
        {report.filter.from} 至 {report.filter.to}
      </td>
      <td>{REPORT_STATUS_LABELS[report.status]}</td>
      <td>{report.evidenceCount} 条</td>
      <td>
        <Link
          to={`/admin/students/${encodeURIComponent(studentId)}/analysis/${encodeURIComponent(report.id)}${filterSearchValue}`}
          state={{ listSearch }}
        >
          查看报告
        </Link>
      </td>
    </tr>
  );
}

export function Analysis() {
  const { studentId, filter, listSearch } =
    useOutletContext<StudentOutletContext>();
  const { capabilities } = useAuth();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const history = useReports(studentId, { limit: PAGE_SIZE, offset });
  const llmConfigured = capabilities?.llmConfigured === true;
  const search = filterSearch(filter);

  const generate = () => {
    setBusy(true);
    setError("");
    void createReport(studentId, filter)
      .then((result) => {
        navigate(
          `/admin/students/${encodeURIComponent(studentId)}/analysis/${encodeURIComponent(result.reportId)}${search}`,
          { state: { listSearch } },
        );
      })
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="insight-analysis">
      <section className="panel insight-analysis-generate">
        <div className="section-head">
          <h2>生成学情报告</h2>
        </div>
        <p className="muted">
          基于 {filter.from} 至 {filter.to} 的学习记录生成结构化观察与建议。
        </p>
        <p className="muted">
          报告由 AI 辅助生成，只依据生成时的数据快照；之后的记录不会出现在该报告中，结论需回到原始证据核对。
        </p>
        {capabilities && !llmConfigured && (
          <p className="muted">未配置 AI 模型，暂时无法生成报告。</p>
        )}
        <div className="form-actions">
          <Button
            type="button"
            variant="primary"
            disabled={busy || !llmConfigured}
            onClick={generate}
          >
            {busy ? "正在提交生成请求" : "生成学情报告"}
          </Button>
        </div>
        {error && (
          <p className="insight-analysis-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>报告历史</h2>
          {history.data && (
            <span className="muted">共 {history.data.total} 份</span>
          )}
        </div>
        <InsightStatus
          loading={history.loading}
          error={history.error}
          status={history.errorStatus}
          onRetry={history.reload}
          empty={!!history.data && history.data.items.length === 0}
          emptyTitle="还没有生成过学情报告"
          emptyDetail={<p>选择日期范围后生成第一份报告。</p>}
        >
          {history.data && (
            <>
              <div className="insight-table-scroll">
                <table className="insight-table">
                  <thead>
                    <tr>
                      <th scope="col">生成时间</th>
                      <th scope="col">统计范围</th>
                      <th scope="col">状态</th>
                      <th scope="col">证据</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.items.map((report) => (
                      <ReportRow
                        key={report.id}
                        studentId={studentId}
                        filterSearchValue={search}
                        listSearch={listSearch}
                        report={report}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPager
                total={history.data.total}
                limit={PAGE_SIZE}
                offset={offset}
                onChange={setOffset}
                busy={history.loading}
              />
            </>
          )}
        </InsightStatus>
      </section>
    </div>
  );
}
