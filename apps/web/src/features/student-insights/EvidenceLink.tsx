import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InsightEvidenceDetail } from "../../../../../packages/contracts/src/student-insights.js";
import { api, errorMessage } from "../../lib/api";

const base = (studentId: string) =>
  `/api/admin/student-insights/students/${encodeURIComponent(studentId)}`;

export function EvidenceLink({
  studentId,
  reportId,
  evidenceKey,
  label = "查看证据",
}: {
  studentId: string;
  reportId: string;
  evidenceKey: string;
  label?: string;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <span className="evidence-link">
      <button
        type="button"
        className="link-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void api<InsightEvidenceDetail>(
            `${base(studentId)}/reports/${encodeURIComponent(reportId)}/evidence/${encodeURIComponent(evidenceKey)}`,
          )
            .then((result) => navigate(result.href))
            .catch((failure: unknown) => setError(errorMessage(failure)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在打开证据" : label}
      </button>
      {error && (
        <small className="muted" role="alert">
          {" "}
          {error}
        </small>
      )}
    </span>
  );
}
