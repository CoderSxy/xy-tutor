import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type {
  ReportDTO,
  ReportStatus,
} from "../../../../../../packages/contracts/src/student-insights.js";
import { Button } from "../../../components/ui/button";
import { errorMessage } from "../../../lib/api";
import {
  filterSearch,
  retryReport,
  useInsightReport,
} from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ReportContent } from "../../../features/student-insights/ReportContent";
import { REPORT_STATUS_LABELS } from "./Analysis";
import type { StudentOutletContext } from "./StudentLayout";

const ERROR_LABELS: Record<string, string> = {
  INVALID_OUTPUT: "模型输出无法解析",
  TIMEOUT: "生成超时",
  UPSTREAM_UNAVAILABLE: "模型服务不可用",
  PROCESSING_FAILED: "处理失败",
  INTERRUPTED: "生成被中断",
  STALE_GENERATION: "已被更新的一次生成替代",
};

const POLLING_STATUSES: ReportStatus[] = ["queued", "running"];

function ReportMeta({ report }: { report: ReportDTO }) {
  return (
    <>
      <dl className="insight-summary insight-report-meta" aria-label="报告信息">
        <div>
          <dt>状态</dt>
          <dd>{REPORT_STATUS_LABELS[report.status]}</dd>
        </div>
        <div>
          <dt>统计范围</dt>
          <dd>
            {report.filter.from} 至 {report.filter.to}
          </dd>
        </div>
        <div>
          <dt>数据截至</dt>
          <dd>{dateTime(report.dataAsOf)}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{report.model ?? "未记录"}</dd>
        </div>
        <div>
          <dt>尝试次数</dt>
          <dd>{report.attempts}</dd>
        </div>
        <div>
          <dt>有效证据</dt>
          <dd>{report.evidence.length} 条</dd>
        </div>
      </dl>
      <p className="muted">
        本报告基于 {dateTime(report.createdAt)} 生成时的数据快照，数据截至{" "}
        {dateTime(report.dataAsOf)}；此后的学习记录不会出现在正文中。若生成时历史学习数据仍在回填，报告可能未覆盖更早的记录。
      </p>
    </>
  );
}

export function AnalysisDetail() {
  const { studentId, filter, listSearch } =
    useOutletContext<StudentOutletContext>();
  const { reportId } = useParams<{ reportId: string }>();
  const result = useInsightReport(studentId, reportId);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const backSearch = filterSearch(filter);
  const report = result.report;

  const retry = () => {
    if (!studentId || !reportId) return;
    setRetrying(true);
    setRetryError("");
    void retryReport(studentId, reportId)
      .then(() => result.refetch())
      .catch((failure: unknown) => setRetryError(errorMessage(failure)))
      .finally(() => setRetrying(false));
  };

  return (
    <div className="insight-analysis-detail">
      <p className="insight-back">
        <Link
          to={`/admin/students/${encodeURIComponent(studentId)}/analysis${backSearch}`}
          state={{ listSearch }}
        >
          <ArrowLeft size={16} />
          返回 AI 分析
        </Link>
      </p>
      <InsightStatus
        loading={result.loading}
        error={result.error}
        status={result.errorStatus}
        onRetry={result.refetch}
      >
        {report && (
          <>
            <div className="page-heading insight-detail-heading">
              <h2>学情报告</h2>
            </div>
            <ReportMeta report={report} />
            {POLLING_STATUSES.includes(report.status) && (
              <p className="muted" role="status">
                报告生成中，页面会自动刷新；离开本页后将停止刷新。
              </p>
            )}
            {report.status === "failed" && (
              <section className="panel">
                <p role="alert">
                  本次生成失败：
                  {report.errorCode
                    ? (ERROR_LABELS[report.errorCode] ?? report.errorCode)
                    : "未知原因"}
                </p>
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={retrying}
                    onClick={retry}
                  >
                    {retrying ? "正在重新提交" : "重试生成"}
                  </Button>
                </div>
                {retryError && <p role="alert">{retryError}</p>}
              </section>
            )}
            {report.status === "completed" && report.content && (
              <ReportContent
                studentId={studentId}
                reportId={report.id}
                content={report.content}
                evidence={report.evidence}
              />
            )}
            {report.status === "completed" && !report.content && (
              <p className="muted">报告已完成，但没有可展示的正文。</p>
            )}
          </>
        )}
      </InsightStatus>
    </div>
  );
}
