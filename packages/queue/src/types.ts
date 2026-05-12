// Sprint 7 §5.1, §5.3 — public types for the queue abstraction.
//
// `QueueAdapter` is the single interface every consumer (coordinator,
// workers, validators) depends on. `LocalQueueAdapter` (Sprint 7) is the
// only implementation. Future sprints may add `RedisQueueAdapter`.

import type { z } from 'zod';
import type { jobEnvelopeSchema } from './envelope.ts';

/** Closed-set envelope kinds. Adding a kind requires a code change. */
export const ENVELOPE_KINDS = [
  'assessment.start',
  // Sprint 10 — coordinator publishes one envelope per candidate after
  // the decepticon stream emits it. Validator-worker subscribes, replays
  // in a scope-guarded browser context, and persists findings ONLY on
  // confirmed status (DirectInsertForbidden invariant lives in the
  // findings repo, not at the queue boundary).
  'validate.finding',
  // Sprint 14 — API enqueues one envelope per report build request.
  // Report-builder worker subscribes and renders HTML+JSON+ZIP.
  'report.build',
  // Sprint 18 — validator-worker subscribes to replay SSRF candidates.
  'validator.ssrf.replay',
  // Sprint 19 — validator-worker subscribes to replay LFI candidates.
  'validator.lfi.replay',
  // Sprint 20 — validator-worker subscribes to replay RCE candidates.
  'validator.rce.replay',
  // validator-worker subscribes to replay SQLi candidates (HTTP-body replay).
  'validator.sqli.replay',
  // Sprint 21 — coordinator publishes one envelope per recon job.
  // Recon-runner worker subscribes and orchestrates subfinder+httpx+nuclei.
  'recon.subfinder.run',
] as const;

export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

/** Job status state machine — mirrors the DB CHECK constraint on `jobs.status`. */
export const JOB_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed_transient',
  'failed_terminal',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Inferred from the zod schema for type ergonomics. */
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

/** Result of a successful (or deduped) publish. */
export interface PublishResult {
  /** True when the (tenant_id, idempotency_key) row already existed. */
  readonly deduped: boolean;
  /** The DB row id (whether newly inserted or pre-existing). */
  readonly jobId: string;
}

/** Handler return value — the consumer's verdict on the envelope. */
export type HandlerOutcome =
  | { readonly kind: 'ack' }
  | { readonly kind: 'nack'; readonly error: Error };

export type Handler = (envelope: JobEnvelope) => Promise<HandlerOutcome>;

export interface SubscribeOptions {
  /** Tenant filter — null = all tenants (admin/coordinator). UUID = single tenant. */
  readonly tenantId?: string | null;
  /** Poll cadence in ms. Default 100ms in tests, 1000ms in prod. */
  readonly pollIntervalMs?: number;
  /** Rows claimed per poll. Default 10. */
  readonly batchSize?: number;
}

export interface Subscription {
  /** Stop polling and drain in-flight handlers. Default timeout 5000ms. */
  readonly stop: (opts?: { timeoutMs?: number }) => Promise<void>;
}

export interface QueueAdapter {
  publish(envelope: JobEnvelope): Promise<PublishResult>;
  subscribe(queueName: EnvelopeKind, handler: Handler, opts?: SubscribeOptions): Subscription;
  /** Direct ack for fire-and-forget consumers (rarely used; subscribe loop ack's by default). */
  ack(jobId: string): Promise<void>;
  /** Direct nack — same retry-classifier logic as the subscribe loop. */
  nack(jobId: string, error: Error): Promise<void>;
}

/**
 * Envelope-validation failure — terminal-classified per A-Q-Retry-1.
 * Thrown by `publish()` when zod-parse fails. Never retried.
 */
export class EnvelopeValidationError extends Error {
  override readonly name = 'EnvelopeValidationError';
  readonly __terminal = true as const;
}

/**
 * Scope-deny terminal — thrown by coordinator when scope-engine denies a
 * declared target. Retry classifier sees `__terminal` flag → never retried.
 */
export class ScopeDenyError extends Error {
  override readonly name = 'ScopeDenyError';
  readonly __terminal = true as const;
  readonly matchedDenyRuleIds: readonly string[];
  readonly reason: string;

  constructor(reason: string, matchedDenyRuleIds: readonly string[]) {
    super(`scope_deny: ${reason}`);
    this.reason = reason;
    this.matchedDenyRuleIds = matchedDenyRuleIds;
  }
}
