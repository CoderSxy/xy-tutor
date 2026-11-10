import { Button } from "../../components/ui/button";

export function ListPager({
  total,
  limit,
  offset,
  onChange,
  busy,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  busy?: boolean;
}) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="form-actions insight-pager">
      <Button
        type="button"
        size="small"
        variant="outline"
        disabled={busy || offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        上一页
      </Button>
      <span className="muted">
        第 {page}/{pages} 页 · 共 {total} 条
      </span>
      <Button
        type="button"
        size="small"
        variant="outline"
        disabled={busy || offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        下一页
      </Button>
    </div>
  );
}
