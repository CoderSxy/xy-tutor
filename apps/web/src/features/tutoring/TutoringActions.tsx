import { useCallback, useEffect, useState } from "react";
import { Lightbulb, Pause, Play, StepForward } from "lucide-react";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Button } from "../../components/ui/button";
import { Markdown } from "../../components/Markdown";
import type {
  EpisodeDTO,
  TutoringActionDTO,
} from "../../../../../packages/contracts/src/tutoring.js";

const teachingLabels: Record<string, string> = {
  awaiting_evidence: "先自己试一步",
  self_check: "自查",
  focused_check: "聚焦检查",
  micro_probe: "微题",
  explanation: "讲解",
  independent_check: "独立练习",
  scheduled_review: "隔天复习",
};

const steps = [
  { kind: "request_hint", label: "自查一下" },
  { kind: "request_probe", label: "聚焦检查" },
  { kind: "request_example", label: "看个同类例子" },
  { kind: "request_explanation", label: "请完整讲解" },
] as const;

const disclosure = (episode: EpisodeDTO) =>
  episode.exposure === "solution_exposed"
    ? "这道题已经看过解法，之后答对只算带提示完成，不算独立掌握。"
    : episode.exposure === "unknown"
      ? "这次的提示方式无法可靠判断，作答会按独立性未知记录。"
      : null;

export function TutoringActions({
  taskId,
  enabled,
  refreshKey,
  busy,
  onRequestSteps,
}: {
  taskId?: string;
  enabled: boolean;
  refreshKey: string;
  busy: boolean;
  onRequestSteps: () => void;
}) {
  const a = useAuth();
  const [episode, setEpisode] = useState<EpisodeDTO | null>(null);
  const [action, setAction] = useState<TutoringActionDTO | null>(null);
  const [pending, setPending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!enabled || !taskId) return;
    try {
      const result = await api<{ episode: EpisodeDTO | null }>(
        a.scoped(`/api/tasks/${taskId}/tutoring`),
      );
      setEpisode(result.episode);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [a.studentId, enabled, taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!enabled) return null;

  const run = async (kind: string) => {
    if (!episode) return;
    setPending(true);
    setError("");
    try {
      const result = await api<TutoringActionDTO>(
        a.scoped(`/api/tutoring/episodes/${episode.id}/actions`),
        {
          method: "POST",
          ...jsonBody({
            requestKey: crypto.randomUUID(),
            expectedVersion: episode.version,
            kind,
          }),
        },
      );
      setAction(result);
      setPaused(kind === "pause");
      if (result.content && result.displayStatus !== "acknowledged")
        void api(
          a.scoped(
            `/api/tutoring/episodes/${episode.id}/actions/${result.id}/acknowledge`,
          ),
          { method: "POST", ...jsonBody({}) },
        ).catch(() => undefined);
      await load();
    } catch (e) {
      setError(errorMessage(e));
      await load();
    } finally {
      setPending(false);
    }
  };

  if (!episode)
    return (
      <p className="muted text-small tutoring-note">
        这一题还没有开始记录。先开始作答，再按需要一层层自查。
      </p>
    );

  const notice = disclosure(episode);
  return (
    <section className="tutoring-actions" aria-label="自查与提示">
      <div className="tutoring-head">
        <span className="badge">
          自查进行中 · {teachingLabels[episode.teachingState] ?? "自查"}
        </span>
        {paused ? (
          <Button
            variant="ghost"
            size="small"
            disabled={pending || busy}
            onClick={() => void run("resume")}
          >
            <Play size={16} />
            继续这道题
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="small"
            disabled={pending || busy}
            onClick={() => void run("pause")}
          >
            <Pause size={16} />
            先停一下
          </Button>
        )}
      </div>
      {notice && (
        <p className="notice text-small" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text text-small" role="alert">
          {error}
        </p>
      )}
      {!paused && (
        <>
          <div className="tutoring-steps">
            {steps.map((step) => (
              <Button
                key={step.kind}
                variant={step.kind === "request_hint" ? "outline" : "ghost"}
                size="small"
                disabled={pending || busy}
                onClick={() => void run(step.kind)}
              >
                <Lightbulb size={16} />
                {step.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="small"
              disabled={pending || busy}
              onClick={onRequestSteps}
            >
              <StepForward size={16} />
              补上中间步骤
            </Button>
          </div>
          <p className="muted text-small tutoring-note">
            一次只走一层：先自己检查，再聚焦检查，仍不会再做微题，最后才看讲解。
          </p>
        </>
      )}
      {action?.content && (
        <div className="tutoring-content" aria-live="polite">
          <div className="tutoring-content-head">
            <strong>这一层的提示</strong>
            {action.exposure === "solution_exposed" && (
              <span className="badge">已接触解法</span>
            )}
          </div>
          <Markdown>{action.content}</Markdown>
        </div>
      )}
    </section>
  );
}
