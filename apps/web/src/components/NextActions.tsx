import { ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
export function NextActions({
  actions,
  onSelect,
}: {
  actions: readonly { id: string; label: string }[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="next-actions" aria-label="后续操作建议">
      {actions.map((action) => (
        <Button
          key={action.id}
          variant="outline"
          onClick={() => onSelect(action.id)}
        >
          {action.label}
          <ArrowRight size={16} />
        </Button>
      ))}
    </div>
  );
}
