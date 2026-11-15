import type { PracticeItemDTO } from "../../../../../packages/contracts/src/practice-sets.js";
import { Button } from "../../components/ui/button";

export function PracticeNavigator({
  items,
  selectedItemId,
  onSelect,
}: {
  items: PracticeItemDTO[];
  selectedItemId?: string;
  onSelect: (itemId: string) => void;
}) {
  return (
    <nav className="practice-nav" aria-label="题号">
      {items.map((item) => (
        <Button
          key={item.slotId}
          size="icon"
          variant={item.itemId === selectedItemId ? "primary" : "outline"}
          disabled={!item.itemId}
          aria-current={item.itemId === selectedItemId}
          aria-label={`第 ${item.position + 1} 题`}
          onClick={() => item.itemId && onSelect(item.itemId)}
        >
          {item.position + 1}
        </Button>
      ))}
    </nav>
  );
}
