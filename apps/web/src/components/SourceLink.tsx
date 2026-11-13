import { FileSearch } from "lucide-react";
import { Button } from "./ui/button";
export function SourceLink({
  source,
  onOpen,
}: {
  source: { label: string; pageIndex?: number };
  onOpen?: () => void;
}) {
  return (
    <Button variant="ghost" size="small" onClick={onOpen}>
      <FileSearch size={16} />
      {source.label}
      {source.pageIndex !== undefined ? ` · 第 ${source.pageIndex + 1} 页` : ""}
    </Button>
  );
}
