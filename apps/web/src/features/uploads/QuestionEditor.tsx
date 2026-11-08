import { Button } from "../../components/ui/button";
import { Field, Input, Textarea } from "../../components/ui/field";
export type EditableQuestion = {
  key: string;
  candidateIds: string[];
  stem: string;
  studentAnswer?: string;
  teacherAnnotation?: string;
  sources: { pageIndex: number; bbox: number[] }[];
  selected: boolean;
};
export function QuestionEditor({
  question,
  index,
  onChange,
  onSplit,
  onView,
}: {
  question: EditableQuestion;
  index: number;
  onChange: (patch: Partial<EditableQuestion>) => void;
  onSplit: () => void;
  onView: () => void;
}) {
  return (
    <section className="recognition-question">
      <div className="section-head">
        <label className="checkline">
          <input
            type="checkbox"
            checked={question.selected}
            onChange={(e) => onChange({ selected: e.target.checked })}
            aria-label={`选择第${index + 1}题`}
          />
          <strong>第 {index + 1} 题</strong>
        </label>
        <div className="row-actions">
          <Button variant="ghost" onClick={onView}>
            核对原图
          </Button>
          <Button variant="ghost" onClick={onSplit}>
            拆分这题
          </Button>
        </div>
      </div>
      <Field label={`第${index + 1}题题干`}>
        <Textarea
          value={question.stem}
          onChange={(e) => onChange({ stem: e.target.value })}
        />
      </Field>
      <div className="form-grid">
        <Field
          label={`第${index + 1}题学生作答（可选）`}
          hint="只填写照片中学生实际写出的答案"
        >
          <Input
            value={question.studentAnswer ?? ""}
            onChange={(e) => onChange({ studentAnswer: e.target.value })}
          />
        </Field>
        <Field label={`第${index + 1}题教师批注（可选）`}>
          <Input
            value={question.teacherAnnotation ?? ""}
            onChange={(e) => onChange({ teacherAnnotation: e.target.value })}
          />
        </Field>
      </div>
      <small className="muted">
        来源：
        {[
          ...new Set(question.sources.map((s) => `第${s.pageIndex + 1}页`)),
        ].join("、")}
      </small>
    </section>
  );
}
