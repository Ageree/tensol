// Sprint 8 — DecepticonAdapter public types.
//
// Two implementations behind one interface: FakeDecepticonAdapter (fixture-
// driven, deterministic) and RealDecepticonAdapter (NotImplemented stub for
// Phase 2). Sprints 9-12 exercise the full pipeline against the fake.

import { z } from 'zod';

// ============================================================================
// OPPLAN — operator plan handed to a Decepticon session.
// ============================================================================

export const opplanSchema = z
  .object({
    assessmentId: z.string().uuid(),
    targets: z.array(z.string().min(1)).min(1),
    authorizedScope: z.array(z.string().min(1)),
    exclusions: z.array(z.string().min(1)),
    testingWindow: z.object({
      start: z.string().datetime().nullable(),
      end: z.string().datetime().nullable(),
    }),
    allowedTools: z.array(z.string().min(1)),
    unavailableTools: z.array(z.string().min(1)),
    engagementProfile: z.string().min(1),
    foothold: z.boolean(),
    postExploit: z.boolean(),
    c2: z.boolean(),
    ad: z.boolean(),
  })
  .strict();

export type Opplan = z.infer<typeof opplanSchema>;

// ============================================================================
// Status events — closed set, mirrors decepticon_sessions.status CHECK.
// ============================================================================

export const SESSION_STATUSES = [
  'started',
  'planning',
  'recon',
  'exploit',
  'reporting',
  'completed',
  'failed',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const statusEventSchema = z
  .object({
    sessionId: z.string().uuid(),
    status: z.enum(SESSION_STATUSES),
    occurredAt: z.string().datetime(),
    detail: z.record(z.unknown()).optional(),
  })
  .strict();

export type StatusEvent = z.infer<typeof statusEventSchema>;

// ============================================================================
// Candidate findings — pre-validation observations.
// ============================================================================

export const CANDIDATE_TYPES = [
  'xss_reflected',
  'xss_stored',
  'sqli',
  'idor',
  'open_redirect',
  'ssrf',
  'misconfig',
  'lfi',
  'rce',
] as const;

export type CandidateType = (typeof CANDIDATE_TYPES)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITIES)[number];

export const candidateFindingSchema = z
  .object({
    candidateId: z.string().uuid(),
    sessionId: z.string().uuid(),
    type: z.enum(CANDIDATE_TYPES),
    severity: z.enum(SEVERITIES),
    affectedUrl: z.string().min(1),
    source: z.string().min(1),
    payload: z.record(z.unknown()),
    observedAt: z.string().datetime(),
  })
  .strict();

export type CandidateFinding = z.infer<typeof candidateFindingSchema>;

// ============================================================================
// Session handle + Artifact.
// ============================================================================

export interface SessionHandle {
  readonly sessionId: string;
  readonly assessmentId: string;
  readonly tenantId: string;
  readonly startedAt: string;
  /** Sprint 13 — upstream LangGraph thread ID. Populated by RealDecepticonAdapter; undefined for fake. */
  readonly langgraphThreadId?: string;
}

export const ARTIFACT_KINDS = ['opplan', 'report', 'transcript'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Artifact {
  readonly kind: ArtifactKind;
  readonly objectStorageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly metadata: Record<string, unknown>;
}

// ============================================================================
// Adapter interface — every implementation conforms.
// ============================================================================

export interface StartSessionInput {
  readonly tenantId: string;
  readonly opplan: Opplan;
}

export interface DecepticonAdapter {
  start(input: StartSessionInput): Promise<SessionHandle>;
  streamStatus(sessionId: string): AsyncIterable<StatusEvent>;
  streamCandidates(sessionId: string): AsyncIterable<CandidateFinding>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  exportArtifacts(sessionId: string): Promise<readonly Artifact[]>;
}

// ============================================================================
// NotImplementedError — typed sentinel for the Real stub.
// ============================================================================

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  readonly method: string;

  constructor(method: string) {
    super(`RealDecepticonAdapter.${method} is not implemented in Sprint 8`);
    this.method = method;
  }
}

// ============================================================================
// AdapterKind — env selector closed set.
// ============================================================================

export const ADAPTER_KINDS = ['fake', 'real'] as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[number];
