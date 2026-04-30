import { z } from 'zod';

export const reportBuildPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    reportId: z.string().uuid(),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ReportBuildPayload = z.infer<typeof reportBuildPayloadSchema>;
