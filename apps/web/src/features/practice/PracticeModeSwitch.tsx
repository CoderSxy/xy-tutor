import type { PracticeMode } from "../../../../../packages/contracts/src/practice-sets.js";
import { Button } from "../../components/ui/button";

export function PracticeModeSwitch({
  mode,
  onChange,
}: {
  mode: PracticeMode;
  onChange: (mode: PracticeMode) => void;
}) {
  return (
    <div className="practice-mode" role="group" aria-label="作答方式">
      <Button
        variant={mode === "step" ? "primary" : "outline"}
        aria-pressed={mode === "step"}
        onClick={() => onChange("step")}
      >
        逐题作答
      </Button>
      <Button
        variant={mode === "batch" ? "primary" : "outline"}
        aria-pressed={mode === "batch"}
        onClick={() => onChange("batch")}
      >
        整组作答
      </Button>
    </div>
  );
}
