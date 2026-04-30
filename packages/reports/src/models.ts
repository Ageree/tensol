import { z } from 'zod';

export const reportFindingEvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(['screenshot', 'har', 'trace', 'json', 'log']),
  objectStorageKey: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
});

export type ReportFindingEvidence = z.infer<typeof reportFindingEvidenceSchema>;

export const reportFindingSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  confidence: z.string(),
  affectedUrl: z.string(),
  reproduction: z.record(z.unknown()),
  validatedAt: z.string(),
  evidence: z.array(reportFindingEvidenceSchema),
});

export type ReportFinding = z.infer<typeof reportFindingSchema>;

export const reportSnapshotSchema = z.object({
  reportId: z.string(),
  assessmentId: z.string(),
  tenantId: z.string(),
  generatedAt: z.string(),
  findings: z.array(reportFindingSchema),
  excludedFindingCount: z.number(),
  methodology: z.string(),
});

export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;

export const reportBuildEnvelopeSchema = z.object({
  tenantId: z.string().uuid(),
  assessmentId: z.string().uuid(),
  reportId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
});

export type ReportBuildEnvelope = z.infer<typeof reportBuildEnvelopeSchema>;
