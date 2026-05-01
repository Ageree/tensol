// Sprint 21 — recon-runner envelope payload schema.
//
// projectId is non-nullable: targets.project_id is notNull (migration 003).

import { z } from 'zod';

export const reconSubfinderRunPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid(),
    assessmentId: z.string().uuid(),
    primaryDomain: z.string().min(1).max(253),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ReconSubfinderRunPayload = z.infer<typeof reconSubfinderRunPayloadSchema>;
