// Sprint 18 — SSRF replay validator.
//
// Scope gate BEFORE network egress (S13 per-candidate-gate lesson):
//   1. Call decide(scope, {kind:'http_request', url:replayUrl, method:'GET'}, scopeDeps).
//   2. Denied → emit validator.ssrf.replay_denied audit, return out_of_scope. Zero HTTP calls.
//   3. Allowed → send HTTP GET to replayUrl via injected httpClient.
//   4. Poll oobCallbackLoader(token) until match or oobVerifyTimeoutMs elapsed.
//   5. Match → confirmed; timeout → inconclusive/timeout.

import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const VALIDATOR_WORKER_ACTOR_ID = 'validator-worker' as const;
const POLL_INTERVAL_MS = 500;

export interface SsrfValidatorInput {
  readonly candidateFindingId: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId?: string | null;
  readonly replayUrl: string;
  readonly token: string;
  readonly scope: EffectiveScope | null;
  readonly traceId: string;
}

export interface SsrfValidatorDeps {
  readonly scopeDeps: ValidatorScopeDeps;
  readonly auditEmitter: AuditEmitter;
  readonly httpClient: { get(url: string): Promise<void>; readonly callCount: number };
  readonly oobCallbackLoader: (token: string) => Promise<boolean>;
  readonly oobVerifyTimeoutMs?: number;
}

export type SsrfValidationStatus = 'confirmed' | 'inconclusive' | 'out_of_scope';

export interface SsrfValidationResult {
  readonly status: SsrfValidationStatus;
  readonly reason?: string;
}

const emitSsrfAudit = async (
  deps: SsrfDepsForAudit,
  input: SsrfValidatorInput,
  action: AuditAction,
  outcome: 'success' | 'denied',
  metadata: Record<string, unknown>,
): Promise<void> => {
  const args: AuditEmitterArgs = {
    tenantId: input.tenantId,
    action,
    outcome,
    actorType: 'service',
    actorId: VALIDATOR_WORKER_ACTOR_ID,
    actorName: 'validator-worker',
    resourceType: 'candidate_finding',
    resourceId: input.candidateFindingId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    assessmentId: input.assessmentId,
    ip: 'validator-worker',
    userAgent: null,
    traceId: input.traceId,
    metadata,
  };
  await deps.auditEmitter(args);
};

interface SsrfDepsForAudit {
  readonly auditEmitter: AuditEmitter;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const validateSsrfCandidate = async (
  input: SsrfValidatorInput,
  deps: SsrfValidatorDeps,
): Promise<SsrfValidationResult> => {
  const timeoutMs = deps.oobVerifyTimeoutMs ?? 10_000;

  // 1. Scope gate BEFORE any network egress.
  const decision = await decide(
    input.scope as EffectiveScope,
    { kind: 'http_request', url: input.replayUrl, method: 'GET' },
    deps.scopeDeps,
  );

  if (!decision.allowed) {
    await emitSsrfAudit(deps, input, 'validator.ssrf.replay_denied', 'denied', {
      reason: decision.reason,
      replayUrl: input.replayUrl,
    });
    return { status: 'out_of_scope', reason: decision.reason };
  }

  // 2. Replay — send GET to replayUrl. Any outgoing Authorization/Cookie headers
  //    are not set here (injected httpClient is a plain GET with no auth headers).
  // Fetch error → terminal fetch_failed audit (no retry — degraded target).
  try {
    await deps.httpClient.get(input.replayUrl);
  } catch (err) {
    await emitSsrfAudit(deps, input, 'validator.ssrf.fetch_failed', 'denied', {
      replayUrl: input.replayUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'inconclusive', reason: 'fetch_failed' };
  }

  // 3. Poll for OOB callback match.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await deps.oobCallbackLoader(input.token);
    if (matched) {
      await emitSsrfAudit(deps, input, 'validator.ssrf.confirmed', 'success', {
        token: input.token,
        replayUrl: input.replayUrl,
      });
      return { status: 'confirmed' };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  // 4. Timeout — no callback arrived.
  await emitSsrfAudit(deps, input, 'validator.ssrf.timeout', 'success', {
    token: input.token,
    replayUrl: input.replayUrl,
    timeoutMs,
  });
  return { status: 'inconclusive', reason: 'timeout' };
};
