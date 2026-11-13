import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type {
  InsightFilter,
  InsightMeta,
  StudentOverviewDTO,
} from "../../../../../../packages/contracts/src/student-insights.js";
import { filterSearch, useStudentOverview } from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { useInsightFilter } from "../../../features/student-insights/filters";
import { InsightFilters } from "../../../features/student-insights/InsightFilters";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";

const TABS = [
  { path: "overview", label: "概览" },
  { path: "records", label: "学习记录" },
  { path: "mistakes", label: "错题" },
  { path: "materials", label: "作业与试卷" },
  { path: "activity", label: "活跃" },
  { path: "analysis", label: "AI 分析" },
];

export type StudentOutletContext = {
  studentId: string;
  overview: StudentOverviewDTO;
  meta: InsightMeta;
  filter: InsightFilter;
  setFilter: (filter: InsightFilter) => void;
  reload: () => void;
  listSearch: string;
};

export function StudentLayout() {
  const { studentId = "" } = useParams();
  const { filter, setFilter } = useInsightFilter();
  const overview = useStudentOverview(studentId, filter);
  const location = useLocation();
  const state = location.state as { listSearch?: string } | null;
  const listSearch = state?.listSearch ?? "";
  return (
    <>
      <p className="insight-back">
        <Link to={`/admin/students${listSearch}`}>
          <ArrowLeft size={16} />
          返回学生总览
        </Link>
      </p>
      <InsightStatus
        loading={overview.loading}
        error={overview.error}
        status={overview.errorStatus}
        onRetry={overview.reload}
      >
        {overview.data && (
          <>
            <div className="page-heading insight-detail-heading">
              <h1>{overview.data.overview.displayName}</h1>
              <p>
                最近学习：{dateTime(overview.data.overview.lastLearningAt)}
              </p>
            </div>
            <InsightFilters filter={filter} onChange={setFilter} />
            <nav className="insight-tabs" aria-label="学生学情页签">
              {TABS.map((tab) => (
                <NavLink
                  key={tab.path}
                  to={{
                    pathname: `/admin/students/${encodeURIComponent(studentId)}/${tab.path}`,
                    search: filterSearch(filter),
                  }}
                  state={{ listSearch }}
                >
                  {tab.label}
                </NavLink>
              ))}
            </nav>
            <Outlet
              context={
                {
                  studentId,
                  overview: overview.data.overview,
                  meta: overview.data.meta,
                  filter,
                  setFilter,
                  reload: overview.reload,
                  listSearch,
                } satisfies StudentOutletContext
              }
            />
          </>
        )}
      </InsightStatus>
    </>
  );
}
