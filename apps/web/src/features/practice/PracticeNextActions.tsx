import { Link } from "react-router-dom";
import { Button } from "../../components/ui/button";

export function PracticeNextActions({
  canContinue,
  onContinue,
}: {
  canContinue: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="practice-next">
      <Button disabled={!canContinue} onClick={onContinue}>
        再来五题
      </Button>
      <Button asChild variant="outline">
        <Link to="/mistakes?origin=learning">复习本组错题</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link to="/history">查看学习小结</Link>
      </Button>
    </div>
  );
}
