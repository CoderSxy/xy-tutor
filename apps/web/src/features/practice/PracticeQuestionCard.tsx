import type { PracticeItemDTO } from "../../../../../packages/contracts/src/practice-sets.js";
import type { AnswerPayload } from "../../../../../packages/contracts/src/question-presentation.js";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import { Field, Input, Textarea } from "../../components/ui/field";

const progressLabel: Record<string, string> = {
  unanswered: "未作答",
  submitted: "已提交",
  skipped: "已跳过",
  none: "",
  queued: "批改排队中",
  running: "正在批改",
  verified: "已核验",
  pending: "待核验",
  failed: "批改失败",
};

const typeLabel: Record<string, string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  fill_blank: "填空题",
  worked: "解答题",
  legacy: "练习题",
};

export function PracticeQuestionCard({
  item,
  answer,
  onChange,
  onSubmit,
  priorExposure,
  disabled,
}: {
  item: PracticeItemDTO;
  answer?: AnswerPayload;
  onChange: (answer: AnswerPayload) => void;
  onSubmit?: () => void;
  priorExposure?: boolean;
  disabled?: boolean;
}) {
  const presentation = item.presentation;
  const locked =
    disabled ||
    item.progress.submission === "submitted" ||
    item.progress.submission === "skipped";
  return (
    <article className="practice-card">
      <header className="practice-card-head">
        <h2>第 {item.position + 1} 题</h2>
        <span className="badge">{typeLabel[item.questionType]}</span>
        <span className="badge">
          {progressLabel[item.progress.grading] ||
            progressLabel[item.progress.submission]}
        </span>
        {priorExposure && (
          <span className="badge badge-muted">这题之前展示过</span>
        )}
      </header>
      {item.stem ? <Markdown>{item.stem}</Markdown> : <p>题目准备中…</p>}
      {presentation?.kind === "choice" && (
        <fieldset className="practice-choices" disabled={locked}>
          <legend className="sr-only">选项</legend>
          {presentation.options.map((option) => {
            const selected =
              answer?.kind === "choice" &&
              answer.optionIds.includes(option.optionId);
            return (
              <label key={option.optionId} className="practice-choice">
                <input
                  type={presentation.multiple ? "checkbox" : "radio"}
                  name={`item-${item.slotId}`}
                  checked={!!selected}
                  onChange={() =>
                    onChange({
                      kind: "choice",
                      optionIds: presentation.multiple
                        ? selected
                          ? answer?.kind === "choice"
                            ? answer.optionIds.filter(
                                (id) => id !== option.optionId,
                              )
                            : []
                          : [
                              ...(answer?.kind === "choice"
                                ? answer.optionIds
                                : []),
                              option.optionId,
                            ]
                        : [option.optionId],
                    })
                  }
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      {presentation?.kind === "blank" && (
        <div className="practice-blanks">
          {presentation.blanks.map((blank) => {
            const value =
              answer?.kind === "blanks"
                ? (answer.values.find((entry) => entry.blankId === blank.blankId)
                    ?.value ?? "")
                : "";
            return (
              <Field key={blank.blankId} label={blank.label ?? "填空"}>
                <Input
                  value={value}
                  disabled={locked}
                  placeholder={blank.placeholder ?? "填写答案"}
                  onChange={(event) => {
                    const others =
                      answer?.kind === "blanks"
                        ? answer.values.filter(
                            (entry) => entry.blankId !== blank.blankId,
                          )
                        : [];
                    onChange({
                      kind: "blanks",
                      values: [
                        ...others,
                        { blankId: blank.blankId, value: event.target.value },
                      ],
                    });
                  }}
                />
              </Field>
            );
          })}
        </div>
      )}
      {presentation?.kind === "worked" && (
        <Field label="解答过程">
          <Textarea
            rows={6}
            disabled={locked}
            value={answer?.kind === "worked" ? answer.text : ""}
            placeholder={presentation.requirements}
            onChange={(event) =>
              onChange({
                kind: "worked",
                text: event.target.value,
                attachmentIds:
                  answer?.kind === "worked" ? answer.attachmentIds : [],
              })
            }
          />
        </Field>
      )}
      {onSubmit && item.progress.submission === "unanswered" && (
        <Button disabled={locked || !answer} onClick={onSubmit}>
          提交本题
        </Button>
      )}
    </article>
  );
}
