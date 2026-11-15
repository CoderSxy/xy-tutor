import { useEffect, useState } from "react";
import { CircleHelp, Check } from "lucide-react";
import type { PracticeItemDTO } from "../../../../../packages/contracts/src/practice-sets.js";
import type { AnswerPayload } from "../../../../../packages/contracts/src/question-presentation.js";
import type { ImageSubmission } from "../../../../../packages/contracts/src/conversation-images.js";
import { Button } from "../../components/ui/button";
import { StatusPanel } from "../../components/StatusPanel";
import { TutorPanel } from "../tutor/TutorPanel";
import { Composer } from "../tutor/Composer";
import { TimingStatus } from "../tutoring/TimingStatus";
import { TutoringActions } from "../tutoring/TutoringActions";
import { useQuestionTiming } from "../tutoring/useQuestionTiming";
import { useAuth } from "../../lib/auth";
import { errorMessage } from "../../lib/api";
import { kindLabels } from "../../lib/types";
import type { TaskDTO } from "../../lib/types";
import type { useTutorRun } from "../tutor/useTutorRun";
import type { ImageAttachments } from "../tutor/useImageAttachments";
import { MobileStudyShell } from "./MobileStudyShell";
import { PracticeComposerDock } from "./PracticeComposerDock";
import { PracticeModeSwitch } from "./PracticeModeSwitch";
import { PracticeNavigator } from "./PracticeNavigator";
import { PracticeNextActions } from "./PracticeNextActions";
import { PracticeQuestionCard } from "./PracticeQuestionCard";
import { PracticeResults } from "./PracticeResults";
import { useAnswerDrafts } from "./useAnswerDrafts";
import { usePracticeSet } from "./usePracticeSet";
import { useStudyViewport } from "./useStudyViewport";

function cardAnswer(item: PracticeItemDTO, answer?: AnswerPayload) {
  return !!answer && item.progress.submission === "unanswered";
}

export function PracticeStudyView({
  task,
  ready,
  practice,
  tutor,
  images,
  timingEnabled,
  onFinish,
}: {
  task: TaskDTO;
  ready: boolean;
  practice: ReturnType<typeof usePracticeSet>;
  tutor: ReturnType<typeof useTutorRun>;
  images: ImageAttachments;
  timingEnabled: boolean;
  onFinish: () => void;
}) {
  const a = useAuth();
  const viewport = useStudyViewport();
  const set = practice.set!;
  const drafts = useAnswerDrafts({
    studentId: a.studentId,
    setId: set.id,
    scoped: a.scoped,
  });
  const selected =
    set.items.find((item) => item.itemId === practice.selectedItemId) ??
    set.items.find((item) => item.itemId);
  const [intent, setIntent] = useState<"answer" | "question">(
    selected?.presentation?.kind === "worked" ? "answer" : "question",
  );
  const [consult, setConsult] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  const [error, setError] = useState("");
  const [dockHeight, setDockHeight] = useState(0);

  useEffect(() => {
    setIntent(
      selected?.presentation?.kind === "worked" &&
        selected.progress.submission === "unanswered"
        ? "answer"
        : "question",
    );
  }, [selected?.itemId, selected?.presentation?.kind, selected?.progress.submission]);

  const timing = useQuestionTiming({
    taskId: task.id,
    questionVersionId: selected?.questionVersionId ?? undefined,
    enabled: timingEnabled && task.status === "active" && !!selected,
    waiting: tutor.busy,
  });

  const visibleItems =
    set.mode === "batch" ? set.items : selected ? [selected] : [];
  const completed = set.canContinue || set.submission === "completed";
  const stepSubmit =
    set.mode === "step" &&
    selected?.presentation?.kind !== "worked" &&
    selected?.progress.submission === "unanswered";

  const submitItem = async (item: PracticeItemDTO, skipped = false) => {
    if (!item.itemId) return;
    const answer = drafts.drafts[item.itemId];
    try {
      await practice.submit({
        entries:
          skipped || !answer
            ? []
            : [{ itemId: item.itemId, answer }],
        skippedItemIds: skipped ? [item.itemId] : [],
        finalize: false,
      });
      if (!skipped) drafts.drop(item.itemId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const unanswered = set.items.filter(
    (item) => item.itemId && item.progress.submission === "unanswered",
  );
  const missing = unanswered.filter(
    (item) => !cardAnswer(item, drafts.drafts[item.itemId!]),
  );

  const submitBatch = async (skipRemaining: boolean) => {
    try {
      const entries = unanswered.flatMap((item) => {
        const answer = item.itemId ? drafts.drafts[item.itemId] : undefined;
        return item.itemId && answer
          ? [{ itemId: item.itemId, answer }]
          : [];
      });
      await practice.submit({
        entries,
        skippedItemIds: skipRemaining
          ? missing.map((item) => item.itemId!)
          : [],
        finalize: true,
      });
      setSkipOpen(false);
      for (const entry of entries) drafts.drop(entry.itemId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const sendComposer = async (submission: ImageSubmission) => {
    if (!ready) return false;
    if (intent === "answer" && selected?.itemId) {
      const answer: AnswerPayload = {
        kind: "worked",
        text: submission.message,
        attachmentIds: submission.attachmentIds,
      };
      drafts.update(selected.itemId, answer);
      try {
        await practice.submit({
          entries: [{ itemId: selected.itemId, answer }],
          skippedItemIds: [],
          finalize: false,
        });
        drafts.drop(selected.itemId);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    }
    return tutor.submit(submission, undefined, undefined, "question");
  };

  const header = (
    <div className="practice-toolbar">
      <div>
        <h1>{kindLabels[task.kind] ?? "每日5练"}</h1>
        <p className="practice-counts">
          已提交 {set.counts.submitted} · 待批改 {set.counts.pending} · 第{" "}
          {(selected?.position ?? 0) + 1}/5 题
        </p>
      </div>
      <div className="practice-toolbar">
        <PracticeModeSwitch
          mode={set.mode}
          onChange={(mode) => void practice.changeMode(mode)}
        />
        <Button
          variant="outline"
          disabled={!ready || tutor.busy || task.status === "completed"}
          onClick={onFinish}
        >
          <Check size={16} />
          结束本次学习
        </Button>
      </div>
    </div>
  );

  const cards = (
    <>
      <PracticeNavigator
        items={set.items}
        selectedItemId={practice.selectedItemId}
        onSelect={(itemId) => practice.selectItem(itemId)}
      />
      {visibleItems.map((item) => (
        <PracticeQuestionCard
          key={item.slotId}
          item={item}
          answer={item.itemId ? drafts.drafts[item.itemId] : undefined}
          priorExposure={
            timingEnabled &&
            item.itemId === selected?.itemId &&
            timing.snapshot.priorExposure
          }
          onChange={(answer) => item.itemId && drafts.update(item.itemId, answer)}
          onSubmit={
            stepSubmit && item.itemId === selected?.itemId
              ? () => void submitItem(item)
              : undefined
          }
        />
      ))}
      {itemFailed(set) && (
        <Button
          variant="outline"
          onClick={() =>
            void practice.retry(
              set.items
                .filter((item) => item.progress.grading === "failed" && item.itemId)
                .map((item) => item.itemId!),
            )
          }
        >
          重试失败的批改
        </Button>
      )}
    </>
  );

  const body = (
    <>
      {(error || practice.error || drafts.conflict || tutor.error) && (
        <p className="notice error-text" role="alert">
          {error || practice.error || drafts.conflict || tutor.error}
        </p>
      )}
      {set.generation === "preparing" && (
        <StatusPanel state="loading" title="正在准备五道练习题" />
      )}
      {set.generation === "awaiting_scope" && (
        <StatusPanel title="先确认学习范围">
          告诉老师当前章节后，再生成本组练习。
        </StatusPanel>
      )}
      {(set.generation === "failed" ||
        set.generation === "insufficient_pool") && (
        <StatusPanel
          state="error"
          title={
            set.generation === "insufficient_pool"
              ? "当前范围题目不足"
              : "题目准备失败"
          }
          onRetry={() => void practice.retryGeneration()}
        />
      )}
      {set.generation === "ready" && cards}
      {completed && <PracticeResults set={set} />}
      {skipOpen && (
        <div className="notice" role="dialog" aria-labelledby="skip-title">
          <h2 id="skip-title">还有未作答的题目</h2>
          <ul className="practice-skip-list">
            {missing.map((item) => (
              <li key={item.slotId}>第 {item.position + 1} 题</li>
            ))}
          </ul>
          <div className="form-actions">
            <Button variant="outline" onClick={() => setSkipOpen(false)}>
              继续作答
            </Button>
            <Button onClick={() => void submitBatch(true)}>
              确认跳过并交卷
            </Button>
          </div>
        </div>
      )}
    </>
  );

  const selectedDraft = selected?.itemId
    ? drafts.drafts[selected.itemId]
    : undefined;
  const selectedWorked =
    selectedDraft?.kind === "worked" ? selectedDraft : undefined;
  const dock = (
    <PracticeComposerDock
      target={
        intent === "answer"
          ? `正在回答第 ${(selected?.position ?? 0) + 1} 题`
          : "问老师"
      }
      onHeight={setDockHeight}
      actions={
        <>
          {task.status === "active" && selected && (
            <div className="question-tools">
              <Button
                variant="outline"
                disabled={!ready || tutor.busy}
                onClick={() =>
                  void tutor.submit(
                    "这道题我还不太会，请先给一个小提示，不要直接给完整解法。",
                    undefined,
                    undefined,
                    "question",
                  )
                }
              >
                <CircleHelp size={16} />
                给我一个提示
              </Button>
              {set.mode === "step" &&
                selected.progress.submission === "unanswered" && (
                  <Button
                    variant="ghost"
                    disabled={!ready}
                    onClick={() => void submitItem(selected, true)}
                  >
                    先跳过这题
                  </Button>
                )}
              {set.mode === "batch" && task.status === "active" && (
                <Button
                  disabled={!ready}
                  onClick={() =>
                    missing.length ? setSkipOpen(true) : void submitBatch(false)
                  }
                >
                  提交本组
                </Button>
              )}
            </div>
          )}
          {completed && (
            <PracticeNextActions
              canContinue={set.canContinue}
              onContinue={() => void practice.continueSet()}
            />
          )}
          <label className="practice-intent">
            作答意图
            <select
              aria-label="作答意图"
              value={intent}
              onChange={(event) =>
                setIntent(event.target.value as "answer" | "question")
              }
            >
              <option value="answer">
                回答第 {(selected?.position ?? 0) + 1} 题
              </option>
              <option value="question">问老师</option>
            </select>
          </label>
        </>
      }
    >
      {timingEnabled && selected && task.status === "active" && (
        <TimingStatus
          snapshot={timing.snapshot}
          onStart={(takeOver) => void timing.start(takeOver)}
          onPause={() => void timing.pause()}
          onResume={() => void timing.resume()}
        />
      )}
      <p className="muted text-small question-note">
        提示后的答对会保留记录；独立练习和延迟复习提供新的掌握证据。
      </p>
      {task.status === "active" || completed ? (
        <Composer
          busy={tutor.busy}
          hasQuestion={intent === "answer"}
          value={intent === "question" ? consult : (selectedWorked?.text ?? "")}
          onValueChange={(next) => {
            if (intent === "question") setConsult(next);
            else if (selected?.itemId)
              drafts.update(selected.itemId, {
                kind: "worked",
                text: next,
                attachmentIds: selectedWorked?.attachmentIds ?? [],
              });
          }}
          placeholder={
            intent === "question"
              ? "想问老师什么，直接说…"
              : "写下你的答案或解题过程…"
          }
          onSubmit={sendComposer}
          onCancel={tutor.cancel}
          attachments={images}
          imagesEnabled={a.capabilities?.images !== "disabled"}
        />
      ) : null}
    </PracticeComposerDock>
  );

  const workspace = (
    <section
      className="tutor-workspace"
      style={dockHeight ? { paddingBottom: dockHeight } : undefined}
    >
      <TutorPanel
        messages={tutor.messages}
        stream={tutor.stream}
        status={tutor.status}
        loading={tutor.messagesLoading}
        onRetry={() => void tutor.retry()}
        header={
          <TutoringActions
            taskId={task.id}
            enabled={
              a.capabilities?.selfCheck === "enabled" &&
              task.status === "active" &&
              !!selected
            }
            refreshKey={`${selected?.progress.submission ?? ""}:${set.counts.submitted}:${tutor.messages.length}:${tutor.status}`}
            busy={tutor.busy}
            onRequestSteps={() =>
              void tutor.submit(
                "我把这道题的中间步骤补在下面，请先别给完整解法。",
                undefined,
                undefined,
                "question",
              )
            }
          />
        }
      />
    </section>
  );

  if (viewport.phone || a.capabilities?.mobileStudy === "enabled")
    return (
      <MobileStudyShell header={header} progress={undefined} dock={dock}>
        {body}
        {workspace}
      </MobileStudyShell>
    );

  return (
    <div className={`practice-study${viewport.desktop ? " is-split" : ""}`}>
      <div>
        {header}
        {body}
      </div>
      <div>
        {workspace}
        {dock}
      </div>
    </div>
  );
}

function itemFailed(set: { items: PracticeItemDTO[] }) {
  return set.items.some((item) => item.progress.grading === "failed");
}
