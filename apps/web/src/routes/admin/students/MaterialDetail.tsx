import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
  filterSearch,
  useMaterialDetail,
  useMaterialQuestions,
} from "../../../features/student-insights/api";
import { dateTime } from "../../../features/student-insights/format";
import { InsightStatus } from "../../../features/student-insights/InsightStatus";
import { ListPager } from "../../../features/student-insights/ListPager";
import { useSignedDownload } from "../../../features/student-insights/useSignedDownload";
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

export function MaterialDetail() {
  const { studentId = "", materialId } =
    useParams<{ studentId: string; materialId: string }>();
  const { filter, listSearch } = useOutletContext<StudentOutletContext>();
  const [offset, setOffset] = useState(0);
  const detail = useMaterialDetail(studentId, materialId);
  const questions = useMaterialQuestions(studentId, materialId, {
    limit: PAGE_SIZE,
    offset,
  });
  const file = useSignedDownload(
    studentId,
    detail.data?.material.fileId ?? "",
    false,
  );
  const seen = new Set<string>();
  const rows =
    questions.data?.items.filter((question) => {
      if (seen.has(question.questionId)) return false;
      seen.add(question.questionId);
      return true;
    }) ?? [];

  return (
    <div className="insight-detail-page">
      <p className="insight-back">
        <Link
          to={`/admin/students/${encodeURIComponent(studentId)}/materials${filterSearch(filter)}`}
          state={{ listSearch }}
        >
          <ArrowLeft size={16} />
          返回作业与试卷
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
              <h1>{detail.data.material.name}</h1>
              <p className="muted">
                {TYPE_LABELS[detail.data.material.type] ??
                  detail.data.material.type}
                {" · "}
                {STATUS_LABELS[detail.data.material.status] ??
                  detail.data.material.status}
                {" · 上传于 "}
                {dateTime(detail.data.material.createdAt)}
              </p>
            </div>

            <section className="panel">
              <div className="section-head">
                <h2>资料原件</h2>
              </div>
              <p className="muted">{detail.data.material.contentType}</p>
              {!detail.data.material.fileId ? (
                <p className="muted">该资料没有可下载的原件。</p>
              ) : file.error ? (
                <p className="muted" role="alert">
                  {file.error}{" "}
                  <Button
                    type="button"
                    size="small"
                    variant="outline"
                    onClick={() => void file.fetchLink()}
                  >
                    重试
                  </Button>
                </p>
              ) : file.url ? (
                <p>
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    下载原件 {detail.data.material.name}
                  </a>{" "}
                  <Button
                    type="button"
                    size="small"
                    variant="outline"
                    disabled={file.loading}
                    onClick={() => void file.fetchLink()}
                  >
                    刷新链接
                  </Button>
                </p>
              ) : (
                <Button
                  type="button"
                  size="small"
                  variant="outline"
                  disabled={file.loading}
                  onClick={() => void file.fetchLink()}
                >
                  {file.loading ? "正在获取下载链接" : "获取原件下载链接"}
                </Button>
              )}
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>题目提取</h2>
              </div>
              {detail.data.extraction ? (
                <dl className="insight-mini-stats">
                  <div>
                    <dt>提取版本</dt>
                    <dd>第 {detail.data.extraction.versionNo} 版</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>{detail.data.extraction.model}</dd>
                  </div>
                  <div>
                    <dt>提示词版本</dt>
                    <dd>{detail.data.extraction.promptVersion}</dd>
                  </div>
                  <div>
                    <dt>提取时间</dt>
                    <dd>{dateTime(detail.data.extraction.createdAt)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted">该资料尚未完成题目提取。</p>
              )}
            </section>

            <section className="panel">
              <div className="section-head">
                <h2>关联题目</h2>
                {questions.data && (
                  <span className="muted">共 {questions.data.total} 题</span>
                )}
              </div>
              {questions.loading ? (
                <p className="muted">正在读取关联题目</p>
              ) : questions.error ? (
                <p className="muted" role="alert">
                  {questions.error}
                </p>
              ) : rows.length ? (
                <>
                  <ol className="insight-question-list">
                    {rows.map((question) => (
                      <li key={question.questionVersionId}>
                        <p>{question.stem}</p>
                        <p className="muted">
                          <span
                            className={`verify-dot ${question.verified ? "" : "is-pending"}`}
                            aria-hidden
                          />
                          {question.knowledgePoint ?? "未标注知识点"}
                          {question.answered ? " · 已作答" : " · 未作答"}
                          {question.verified ? " · 已核验" : " · 待核验"}
                        </p>
                      </li>
                    ))}
                  </ol>
                  <ListPager
                    total={questions.data!.total}
                    limit={PAGE_SIZE}
                    offset={offset}
                    onChange={setOffset}
                    busy={questions.loading}
                  />
                </>
              ) : (
                <p className="muted">该资料暂无关联题目。</p>
              )}
            </section>
          </>
        )}
      </InsightStatus>
    </div>
  );
}
