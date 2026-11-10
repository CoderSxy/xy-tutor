import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import type {
  InsightFilter,
  InsightListDTO,
  InsightListQuery,
  StudentOverviewResponse,
} from "../../../../../packages/contracts/src/student-insights.js";

export type StudentListInput = {
  filter: InsightFilter;
  q?: string;
  sort?: InsightListQuery["sort"];
  attention?: InsightListQuery["attention"];
  limit?: number;
  offset?: number;
};

function filterQuery(filter: InsightFilter): URLSearchParams {
  const params = new URLSearchParams({
    from: filter.from,
    to: filter.to,
  });
  if (filter.revisionId) params.set("revisionId", filter.revisionId);
  return params;
}

export function filterSearch(filter: InsightFilter): string {
  return `?${filterQuery(filter).toString()}`;
}

export function studentsPath(input: StudentListInput): string {
  const params = filterQuery(input.filter);
  if (input.q) params.set("q", input.q);
  if (input.sort) params.set("sort", input.sort);
  if (input.attention) params.set("attention", input.attention);
  if (input.limit) params.set("limit", String(input.limit));
  if (input.offset) params.set("offset", String(input.offset));
  return `/api/admin/student-insights/students?${params.toString()}`;
}

export function overviewPath(studentId: string, filter: InsightFilter): string {
  return `/api/admin/student-insights/students/${encodeURIComponent(studentId)}/overview?${filterQuery(filter).toString()}`;
}

type RemoteState<T> = {
  path: string | null;
  data?: T;
  loading: boolean;
  error: string;
  errorStatus?: number;
};

function useClearedRemote<T>(path: string | null) {
  const [state, setState] = useState<RemoteState<T>>({
    path,
    loading: !!path,
    error: "",
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) {
      setState({ path: null, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    setState({ path, loading: true, error: "" });
    void api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ path, data, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : undefined;
        setState({
          path,
          loading: false,
          error: errorMessage(error),
          ...(status ? { errorStatus: status } : {}),
        });
      });
    return () => controller.abort();
  }, [path, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const current: RemoteState<T> =
    state.path === path
      ? state
      : { path, loading: !!path, error: "" };
  return {
    data: current.data,
    loading: current.loading,
    error: current.error,
    errorStatus: current.errorStatus,
    reload,
  };
}

export function useStudents(input: StudentListInput) {
  return useClearedRemote<InsightListDTO>(studentsPath(input));
}

export function useStudentOverview(
  studentId: string | undefined,
  filter: InsightFilter,
) {
  return useClearedRemote<StudentOverviewResponse>(
    studentId ? overviewPath(studentId, filter) : null,
  );
}
