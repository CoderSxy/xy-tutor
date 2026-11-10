import type {
  KnowledgeBatchDTO,
  KnowledgeItemDTO,
} from "../../../../../packages/contracts/src/knowledge-base.js";
import { useRemote } from "../../lib/useRemote";

export type KnowledgeItemList = {
  items: KnowledgeItemDTO[];
  total: number;
};

export function useKnowledgeItems(query: {
  batchId?: string;
  status?: string;
  q?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (query.batchId) params.set("batchId", query.batchId);
  if (query.status) params.set("status", query.status);
  if (query.q) params.set("q", query.q);
  params.set("limit", String(query.limit ?? 50));
  return useRemote<KnowledgeItemList>(
    `/api/admin/knowledge/items?${params.toString()}`,
  );
}

export function useKnowledgeBatch(batchId: string | undefined) {
  return useRemote<KnowledgeBatchDTO>(
    batchId ? `/api/admin/knowledge/batches/${batchId}` : null,
  );
}
