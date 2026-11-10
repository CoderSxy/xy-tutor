import type {
  Finding,
  InsightEvidence,
  Recommendation,
  ReportContent as ReportContentDTO,
} from "../../../../../packages/contracts/src/student-insights.js";
import { EvidenceLink } from "./EvidenceLink";

const PRIORITY_LABELS: Record<Recommendation["priority"], string> = {
  high: "优先处理",
  medium: "建议跟进",
  low: "可选",
};

function EvidenceRefs({
  studentId,
  reportId,
  keys,
  available,
}: {
  studentId: string;
  reportId: string;
  keys: string[];
  available: Set<string>;
}) {
  return (
    <span className="insight-evidence-refs">
      {keys.map((key) =>
        available.has(key) ? (
          <EvidenceLink
            key={key}
            studentId={studentId}
            reportId={reportId}
            evidenceKey={key}
          />
        ) : (
          <span key={key} className="muted text-small" title={key}>
            证据已不可用
          </span>
        ),
      )}
    </span>
  );
}

function FindingList({
  title,
  findings,
  emptyText,
  studentId,
  reportId,
  available,
}: {
  title: string;
  findings: Finding[];
  emptyText: string;
  studentId: string;
  reportId: string;
  available: Set<string>;
}) {
  return (
    <section className="panel insight-report-section">
      <div className="section-head">
        <h3>{title}</h3>
      </div>
      {findings.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="insight-report-list">
          {findings.map((finding, index) => (
            <li key={`${title}-${index}`}>
              <p>{finding.text}</p>
              <EvidenceRefs
                studentId={studentId}
                reportId={reportId}
                keys={finding.evidenceKeys}
                available={available}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReportContent({
  studentId,
  reportId,
  content,
  evidence,
}: {
  studentId: string;
  reportId: string;
  content: ReportContentDTO;
  evidence: InsightEvidence[];
}) {
  const available = new Set(evidence.map((item) => item.key));
  return (
    <div className="insight-report">
      <p className="insight-report-notice">
        AI 辅助分析，结合具体记录判断；观察与建议均需回到原始证据核对。
      </p>
      <section className="panel insight-report-section">
        <div className="section-head">
          <h3>概述</h3>
        </div>
        <p>{content.summary}</p>
      </section>
      <FindingList
        title="观察到的优势"
        findings={content.strengths}
        emptyText="本期没有足够证据支持优势判断。"
        studentId={studentId}
        reportId={reportId}
        available={available}
      />
      <FindingList
        title="可能的学习困难"
        findings={content.difficulties}
        emptyText="本期没有足够证据支持困难判断。"
        studentId={studentId}
        reportId={reportId}
        available={available}
      />
      <FindingList
        title="学习习惯观察"
        findings={content.habits}
        emptyText="本期没有足够证据支持习惯判断。"
        studentId={studentId}
        reportId={reportId}
        available={available}
      />
      <section className="panel insight-report-section">
        <div className="section-head">
          <h3>建议</h3>
        </div>
        {content.recommendations.length === 0 ? (
          <p className="muted">本期没有生成建议。</p>
        ) : (
          <ul className="insight-report-list">
            {content.recommendations.map((recommendation, index) => (
              <li key={`recommendation-${index}`}>
                <p>
                  <span className="insight-priority">
                    {PRIORITY_LABELS[recommendation.priority]}
                  </span>
                  {recommendation.text}
                </p>
                <EvidenceRefs
                  studentId={studentId}
                  reportId={reportId}
                  keys={recommendation.basisEvidenceKeys}
                  available={available}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel insight-report-section">
        <div className="section-head">
          <h3>分析局限</h3>
        </div>
        {content.limitations.length === 0 ? (
          <p className="muted">模型未标注额外局限。</p>
        ) : (
          <ul className="insight-report-limitations">
            {content.limitations.map((limitation, index) => (
              <li key={`limitation-${index}`}>{limitation}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
