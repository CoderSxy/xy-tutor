import { useState } from "react";
import type { KnowledgeItemDTO } from "../../../../../packages/contracts/src/knowledge-base.js";
import { Button } from "../../components/ui/button";
import { Field, Input, Textarea } from "../../components/ui/field";

export function KnowledgeItemEditor({
  item,
  suffix = "",
  onSave,
  onCancel,
}: {
  item: KnowledgeItemDTO;
  suffix?: string;
  onSave: (patch: { title: string; summary: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary);
  const [busy, setBusy] = useState(false);
  return (
    <div className="form-stack">
      <Field label={`标题${suffix}`}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={`总结${suffix}`}>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </Field>
      <div className="form-actions">
        <Button
          disabled={busy || !title.trim() || !summary.trim()}
          onClick={() => {
            setBusy(true);
            void onSave({ title: title.trim(), summary: summary.trim() }).finally(
              () => setBusy(false),
            );
          }}
        >
          保存修改
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            取消编辑
          </Button>
        )}
      </div>
    </div>
  );
}
