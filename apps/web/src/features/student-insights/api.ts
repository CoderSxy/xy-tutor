import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import type {
  ActivityDTO,
  AttemptRecordDTO,
  InsightFilter,
  InsightListDTO,
  InsightListQuery,
  InsightPage,
  MaterialExtractionDTO,
  MaterialQuestionDTO,
  MaterialRecordDTO,
  MessageRecordDTO,
  MistakeEventDTO,
  MistakeRecordDTO,
  ReportCreateResult,
  ReportDTO,
  ReportHistory,
  ReportRetryResult,
  StudentOverviewResponse,
  TaskItemDTO,
  TaskRecordDTO,
} from "../../../../../packages/contracts/src/student-insights.js";
import type { LearningEvaluationDTO } from "../../../../../packages/contracts/src/learning-evaluation.js";

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

function studentBase(studentId: string): string {
  return `/api/admin/student-insights/students/${encodeURIComponent(studentId)}`;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

type PageInput = { limit?: number; offset?: number };

function pageParams(input: PageInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input.limit) params.set("limit", String(input.limit));
  if (input.offset) params.set("offset", String(input.offset));
  return params;
}

function filterPageParams(
  filter: InsightFilter,
  input: PageInput & Record<string, string | undefined>,
): URLSearchParams {
  const params = filterQuery(filter);
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  return params;
}

export function evaluationPath(
  studentId: string,
  filter: InsightFilter,
): string {
  // 评测接口只接受时间窗口，revisionId 属于列表筛选，不参与指标计算。
  const params = new URLSearchParams({ from: filter.from, to: filter.to });
  return `${studentBase(studentId)}/evaluation?${params.toString()}`;
}

export function useLearningEvaluation(
  studentId: string | undefined,
  filter: InsightFilter,
) {
  return useClearedRemote<LearningEvaluationDTO>(
    studentId ? evaluationPath(studentId, filter) : null,
  );
}

export type TaskListInput = PageInput & { status?: string; kind?: string };

export function tasksPath(
  studentId: string,
  filter: InsightFilter,
  input: TaskListInput,
): string {
  const params = filterPageParams(filter, {
    status: input.status,
    kind: input.kind,
  });
  if (input.limit) params.set("limit", String(input.limit));
  if (input.offset) params.set("offset", String(input.offset));
  return withQuery(`${studentBase(studentId)}/tasks`, params);
}

export function taskPath(
  studentId: string,
  taskId: string,
  input: PageInput,
): string {
  return withQuery(
    `${studentBase(studentId)}/tasks/${encodeURIComponent(taskId)}`,
    pageParams(input),
  );
}

export function taskAttemptsPath(
  studentId: string,
  taskId: string,
  input: PageInput,
): string {
  return withQuery(
    `${studentBase(studentId)}/tasks/${encodeURIComponent(taskId)}/attempts`,
    pageParams(input),
  );
}

export function conversationMessagesPath(
  studentId: string,
  conversationId: string,
  input: PageInput,
): string {
  return withQuery(
    `${studentBase(studentId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    pageParams(input),
  );
}

export type MistakeListInput = PageInput & {
  status?: string;
  chapterId?: string;
  knowledgePoint?: string;
};

export function mistakesPath(
  studentId: string,
  filter: InsightFilter,
  input: MistakeListInput,
): string {
  const params = filterPageParams(filter, {
    status: input.status,
    chapterId: input.chapterId,
    knowledgePoint: input.knowledgePoint,
  });
  if (input.limit) params.set("limit", String(input.limit));
  if (input.offset) params.set("offset", String(input.offset));
  return withQuery(`${studentBase(studentId)}/mistakes`, params);
}

export function mistakePath(
  studentId: string,
  mistakeId: string,
): string {
  return `${studentBase(studentId)}/mistakes/${encodeURIComponent(mistakeId)}`;
}

export function mistakeEventsPath(
  studentId: string,
  mistakeId: string,
  input: PageInput,
): string {
  return withQuery(
    `${studentBase(studentId)}/mistakes/${encodeURIComponent(mistakeId)}/events`,
    pageParams(input),
  );
}

export type MaterialListInput = PageInput & {
  types?: string;
  status?: string;
};

export function materialsPath(
  studentId: string,
  filter: InsightFilter,
  input: MaterialListInput,
): string {
  const params = filterPageParams(filter, {
    types: input.types,
    status: input.status,
  });
  if (input.limit) params.set("limit", String(input.limit));
  if (input.offset) params.set("offset", String(input.offset));
  return withQuery(`${studentBase(studentId)}/materials`, params);
}

export function materialPath(
  studentId: string,
  materialId: string,
): string {
  return `${studentBase(studentId)}/materials/${encodeURIComponent(materialId)}`;
}

export function materialQuestionsPath(
  studentId: string,
  materialId: string,
  input: PageInput,
): string {
  return withQuery(
    `${studentBase(studentId)}/materials/${encodeURIComponent(materialId)}/questions`,
    pageParams(input),
  );
}

export function activityPath(
  studentId: string,
  filter: InsightFilter,
): string {
  return withQuery(`${studentBase(studentId)}/activity`, filterQuery(filter));
}

export function insightFileDownloadPath(
  studentId: string,
  fileId: string,
): string {
  return `${studentBase(studentId)}/files/${encodeURIComponent(fileId)}/download`;
}

export type DiagnosisReviewRequest = {
  diagnosisId: string;
  expectedVersion: number;
  decision: "accept" | "correct" | "insufficient";
  correctedCode: string | null;
  reason: string;
  evidence: { kind: string; id: string; versionId?: string }[];
  requestKey: string;
};

export function submitDiagnosisReview(
  studentId: string,
  input: DiagnosisReviewRequest,
): Promise<{ reviewId: string; diagnosisVersion: number }> {
  return api<{ reviewId: string; diagnosisVersion: number }>(
    `${studentBase(studentId)}/diagnosis-reviews`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function reportsPath(studentId: string, input: PageInput): string {
  return withQuery(`${studentBase(studentId)}/reports`, pageParams(input));
}

export function reportPath(studentId: string, reportId: string): string {
  return `${studentBase(studentId)}/reports/${encodeURIComponent(reportId)}`;
}

export function createReport(
  studentId: string,
  filter: InsightFilter,
): Promise<ReportCreateResult> {
  return api<ReportCreateResult>(`${studentBase(studentId)}/reports`, {
    method: "POST",
    body: JSON.stringify({
      from: filter.from,
      to: filter.to,
      ...(filter.revisionId ? { revisionId: filter.revisionId } : {}),
    }),
  });
}

export function retryReport(
  studentId: string,
  reportId: string,
): Promise<ReportRetryResult> {
  return api<ReportRetryResult>(
    `${reportPath(studentId, reportId)}/retry`,
    { method: "POST" },
  );
}

export function useReports(studentId: string | undefined, input: PageInput) {
  return useClearedRemote<ReportHistory>(
    studentId ? reportsPath(studentId, input) : null,
  );
}

export function useTasks(
  studentId: string | undefined,
  filter: InsightFilter,
  input: TaskListInput,
) {
  return useClearedRemote<InsightPage<TaskRecordDTO>>(
    studentId ? tasksPath(studentId, filter, input) : null,
  );
}

export function useTaskDetail(
  studentId: string | undefined,
  taskId: string | undefined,
  input: PageInput,
) {
  return useClearedRemote<{ task: TaskRecordDTO; items: InsightPage<TaskItemDTO> }>(
    studentId && taskId ? taskPath(studentId, taskId, input) : null,
  );
}

export function useTaskAttempts(
  studentId: string | undefined,
  taskId: string | undefined,
  input: PageInput,
) {
  return useClearedRemote<InsightPage<AttemptRecordDTO>>(
    studentId && taskId ? taskAttemptsPath(studentId, taskId, input) : null,
  );
}

export function useConversationMessages(
  studentId: string | undefined,
  conversationId: string | null | undefined,
  input: PageInput,
) {
  return useClearedRemote<InsightPage<MessageRecordDTO>>(
    studentId && conversationId
      ? conversationMessagesPath(studentId, conversationId, input)
      : null,
  );
}

export function useMistakes(
  studentId: string | undefined,
  filter: InsightFilter,
  input: MistakeListInput,
) {
  return useClearedRemote<InsightPage<MistakeRecordDTO>>(
    studentId ? mistakesPath(studentId, filter, input) : null,
  );
}

export function useMistakeDetail(
  studentId: string | undefined,
  mistakeId: string | undefined,
) {
  return useClearedRemote<{
    mistake: MistakeRecordDTO;
    recentEvents: MistakeEventDTO[];
  }>(studentId && mistakeId ? mistakePath(studentId, mistakeId) : null);
}

export function useMistakeEvents(
  studentId: string | undefined,
  mistakeId: string | undefined,
  input: PageInput,
) {
  return useClearedRemote<InsightPage<MistakeEventDTO>>(
    studentId && mistakeId
      ? mistakeEventsPath(studentId, mistakeId, input)
      : null,
  );
}

export function useMaterials(
  studentId: string | undefined,
  filter: InsightFilter,
  input: MaterialListInput,
) {
  return useClearedRemote<InsightPage<MaterialRecordDTO>>(
    studentId ? materialsPath(studentId, filter, input) : null,
  );
}

export function useMaterialDetail(
  studentId: string | undefined,
  materialId: string | undefined,
) {
  return useClearedRemote<{
    material: MaterialRecordDTO;
    extraction: MaterialExtractionDTO | null;
  }>(studentId && materialId ? materialPath(studentId, materialId) : null);
}

export function useMaterialQuestions(
  studentId: string | undefined,
  materialId: string | undefined,
  input: PageInput,
) {
  return useClearedRemote<InsightPage<MaterialQuestionDTO>>(
    studentId && materialId
      ? materialQuestionsPath(studentId, materialId, input)
      : null,
  );
}

export function useActivity(
  studentId: string | undefined,
  filter: InsightFilter,
) {
  return useClearedRemote<ActivityDTO>(
    studentId ? activityPath(studentId, filter) : null,
  );
}

const REPORT_POLL_MS = 3_000;
const REPORT_SLOW_POLL_MS = 15_000;
const REPORT_SLOW_AFTER_MS = 120_000;

export function useInsightReport(
  studentId: string | undefined,
  reportId: string | undefined,
) {
  const path =
    studentId && reportId ? reportPath(studentId, reportId) : null;
  const [state, setState] = useState<RemoteState<ReportDTO>>({
    path,
    loading: !!path,
    error: "",
  });
  const [revision, setRevision] = useState(0);
  const refetch = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!path) {
      setState({ path: null, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      setState((current) => ({
        path,
        data: current.path === path ? current.data : undefined,
        loading: current.path !== path || !current.data,
        error: "",
      }));
      void api<ReportDTO>(path, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          setState({ path, data, loading: false, error: "" });
          if (data.status === "queued" || data.status === "running") {
            const wait =
              Date.now() - startedAt >= REPORT_SLOW_AFTER_MS
                ? REPORT_SLOW_POLL_MS
                : REPORT_POLL_MS;
            timer = setTimeout(load, wait);
          }
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
    };
    load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, revision]);

  const current: RemoteState<ReportDTO> =
    state.path === path ? state : { path, loading: !!path, error: "" };
  return {
    report: current.data,
    loading: current.loading,
    error: current.error,
    errorStatus: current.errorStatus,
    refetch,
  };
}
