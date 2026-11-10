import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatusPanel } from "../../components/StatusPanel";
import type { InsightMeta } from "../../../../../packages/contracts/src/student-insights.js";
import { dateTime } from "./format";

export function InsightStatus({
  loading,
  error,
  status,
  onRetry,
  empty,
  emptyTitle = "暂无学习记录",
  emptyDetail,
  children,
}: {
  loading: boolean;
  error: string;
  status?: number;
  onRetry: () => void;
  empty?: boolean;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
  children: ReactNode;
}) {
  if (loading)
    return <StatusPanel state="loading" title="正在读取学生学情" />;
  if (error) {
    if (status === 404)
      return (
        <StatusPanel state="empty" title="404 · 未找到该学生或记录">
          <p>地址中的学生或记录不存在，或不在当前可查看范围内。</p>
          <p>
            <Link to="/admin/students">返回学生总览</Link>
          </p>
        </StatusPanel>
      );
    return (
      <StatusPanel state="error" title={error} onRetry={onRetry}>
        <p>学情数据读取失败，可在此处重试。</p>
      </StatusPanel>
    );
  }
  if (empty)
    return (
      <StatusPanel state="empty" title={emptyTitle}>
        {emptyDetail}
      </StatusPanel>
    );
  return <>{children}</>;
}

export function CoverageNote({ meta }: { meta: InsightMeta }) {
  return (
    <div className="insight-coverage">
      <p>
        统计范围 {meta.from} 至 {meta.to}（{meta.timezone}），数据截至{" "}
        {dateTime(meta.dataAsOf)}。
      </p>
      {meta.coverage.learning === "partial" && (
        <p>历史学习数据仍在回填，覆盖不完整，较早日期可能缺少记录。</p>
      )}
      {meta.coverage.historicalInferred && (
        <p>部分历史有效学习记录由既有数据推算，可能与原始记录存在差异。</p>
      )}
    </div>
  );
}
