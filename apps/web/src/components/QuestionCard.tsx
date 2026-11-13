import { FileSearch } from "lucide-react";
import { Markdown } from "./Markdown";
import { Button } from "./ui/button";
export function QuestionCard({
  question,
  onViewSource,
}: {
  question: {
    stem: string;
    knowledgePoint?: string | null;
    position?: number;
    priorExposure?: boolean;
  };
  onViewSource?: () => void;
}) {
  return (
    <section className="question-card">
      <div className="section-head">
        <h2>
          {question.position === undefined
            ? "当前题目"
            : `第 ${question.position + 1} 题`}
        </h2>
        {onViewSource && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="查看原图"
            onClick={onViewSource}
          >
            <FileSearch size={16} />
          </Button>
        )}
      </div>
      {question.knowledgePoint && (
        <span className="badge">{question.knowledgePoint}</span>
      )}
      {question.priorExposure && (
        <span className="badge badge-muted">这题之前展示过</span>
      )}
      <Markdown>{question.stem}</Markdown>
    </section>
  );
}
