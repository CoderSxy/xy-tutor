import { z } from "zod";

export const evidenceRefSchema = z
  .object({
    kind: z.string().trim().min(1).max(64),
    id: z.uuid(),
    versionId: z.uuid().optional(),
  })
  .strict();

export type EvidenceRefInput = z.infer<typeof evidenceRefSchema>;
