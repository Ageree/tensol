// Sprint 10 — XSS reflected validator. Two-run reproducibility.
//
// Decision tree:
//   - scope-deny on affectedUrl → out_of_scope (no driver call)
//   - driver throws BrowserReplayTimeoutError → inconclusive (reason=timeout)
//   - driver throws non-timeout Error → bubble up (worker classifies as transient)
//   - both runs report DOM nonce echo → confirmed (high confidence)
//   - DOM echo + console echo + alert → confirmed
//   - one run echo, other empty → inconclusive (non-reproducible)
//   - both runs alert-only (no DOM/console) → inconclusive (weak proof)
//   - both runs empty → rejected
//
// Pure decision; capture (screenshot/trace bytes) is the driver's job.

import type { ScopeActionInput } from '@cyberstrike/contracts';
import {
  type Clock,
  type DnsResolver,
  type EffectiveScope,
  type RateLimitCounter,
  decide,
} from '@cyberstrike/scope-engine';
import type {
  ValidationConfidence,
  ValidationInput,
  ValidationProofType,
  ValidationResult,
  ValidationStatus,
} from './contract.ts';
import { buildXssPayload, generateNonce } from './nonce.ts';
import {
  BrowserReplayTimeoutError,
  type XssReplayDriver,
  type XssReplayResult,
} from './xss-replay-driver.ts';

export interface ValidatorScopeDeps {
  readonly dns: DnsResolver;
  readonly clock: Clock;
  readonly rateLimit: RateLimitCounter;
}

export interface XssValidatorDeps {
  readonly driver: XssReplayDriver;
  readonly scope: EffectiveScope | null;
  readonly scopeDeps: ValidatorScopeDeps;
  /** Test seam — defaults to () => new Date().toISOString(). */
  readonly clockIso?: () => string;
  /** Test seam — defaults to a fresh nonce per call. */
  readonly nonceFactory?: () => string;
}

export interface XssDriverRunSnapshot {
  readonly attempt: number;
  readonly capturedAt: string;
  readonly httpStatus: number | null;
  readonly domContainsNonce: boolean;
  readonly consoleNonceHits: ReadonlyArray<string>;
  readonly alertDispatched: boolean;
}

export const validateXssReflected = async (
  input: ValidationInput,
  deps: XssValidatorDeps,
): Promise<ValidationResult> => {
  const validatedAt = (deps.clockIso ?? ((): string => new Date().toISOString()))();

  // 1. Scope-first: deny → out_of_scope (no driver call).
  const scopeDecision = await runScopeDecide(input.affectedUrl, deps);
  if (scopeDecision.kind !== 'allow') {
    const denyReason = scopeDecision.kind === 'no_scope' ? 'scope_not_found' : scopeDecision.reason;
    return finalise({
      status: 'out_of_scope',
      proofType: 'none',
      confidence: 'low',
      reason: denyReason,
      requestReplayable: false,
      sideEffectRisk: 'low',
      validatedAt,
      log: [{ phase: 'scope_check', allowed: false, reason: denyReason }],
    });
  }

  const nonce = (deps.nonceFactory ?? generateNonce)();
  const payload = buildXssPayload(nonce);

  // 2. Run twice for reproducibility (A-V-Confirm).
  let run1: XssReplayResult;
  let run2: XssReplayResult;
  try {
    run1 = await deps.driver.replay({
      affectedUrl: input.affectedUrl,
      nonce,
      payload,
      traceId: input.traceId,
    });
    run2 = await deps.driver.replay({
      affectedUrl: input.affectedUrl,
      nonce,
      payload,
      traceId: input.traceId,
    });
  } catch (err) {
    if (err instanceof BrowserReplayTimeoutError) {
      // A-V-Hang — explicit timeout → inconclusive.
      return finalise({
        status: 'inconclusive',
        proofType: 'none',
        confidence: 'low',
        reason: 'timeout',
        requestReplayable: true,
        sideEffectRisk: 'low',
        validatedAt,
        log: [{ phase: 'replay', error: 'browser_replay_timeout', name: (err as Error).name }],
      });
    }
    // Non-timeout error → bubble up so worker classifies as transient nack.
    throw err;
  }

  const snapshot1 = snapshotOf(run1, 1);
  const snapshot2 = snapshotOf(run2, 2);
  const log: Array<Record<string, unknown>> = [
    { phase: 'replay', ...snapshot1 },
    { phase: 'replay', ...snapshot2 },
  ];

  const bothDom = snapshot1.domContainsNonce && snapshot2.domContainsNonce;
  const bothConsole =
    snapshot1.consoleNonceHits.length > 0 && snapshot2.consoleNonceHits.length > 0;
  const bothEmpty =
    !snapshot1.domContainsNonce &&
    !snapshot2.domContainsNonce &&
    snapshot1.consoleNonceHits.length === 0 &&
    snapshot2.consoleNonceHits.length === 0 &&
    !snapshot1.alertDispatched &&
    !snapshot2.alertDispatched;
  const oneDomOneEmpty =
    snapshot1.domContainsNonce !== snapshot2.domContainsNonce &&
    !(snapshot1.domContainsNonce && snapshot2.domContainsNonce);
  const bothAlertNoEcho =
    snapshot1.alertDispatched &&
    snapshot2.alertDispatched &&
    !snapshot1.domContainsNonce &&
    !snapshot2.domContainsNonce &&
    snapshot1.consoleNonceHits.length === 0 &&
    snapshot2.consoleNonceHits.length === 0;

  let status: ValidationStatus;
  let proofType: ValidationProofType;
  let confidence: ValidationConfidence;
  let reason: string;
  if (bothDom) {
    status = 'confirmed';
    proofType = bothConsole ? 'console_nonce_echo' : 'dom_nonce_echo';
    confidence = 'high';
    reason = 'two_runs_dom_echo';
  } else if (oneDomOneEmpty) {
    status = 'inconclusive';
    proofType = 'dom_nonce_echo';
    confidence = 'low';
    reason = 'non_reproducible_dom_echo';
  } else if (bothAlertNoEcho) {
    status = 'inconclusive';
    proofType = 'alert_only';
    confidence = 'low';
    reason = 'alert_only_weak_proof';
  } else if (bothEmpty) {
    status = 'rejected';
    proofType = 'none';
    confidence = 'low';
    reason = 'no_echo_two_runs';
  } else {
    status = 'inconclusive';
    proofType = 'none';
    confidence = 'low';
    reason = 'mixed_signals';
  }

  return finalise({
    status,
    proofType,
    confidence,
    reason,
    requestReplayable: true,
    sideEffectRisk: 'low',
    validatedAt,
    log,
  });
};

const finalise = (args: {
  status: ValidationStatus;
  proofType: ValidationProofType;
  confidence: ValidationConfidence;
  reason: string;
  requestReplayable: boolean;
  sideEffectRisk: 'low' | 'medium' | 'high';
  validatedAt: string;
  log: ReadonlyArray<Record<string, unknown>>;
}): ValidationResult =>
  Object.freeze({
    status: args.status,
    confidence: args.confidence,
    proofType: args.proofType,
    requestReplayable: args.requestReplayable,
    sideEffectRisk: args.sideEffectRisk,
    evidenceIds: [] as ReadonlyArray<string>,
    reason: args.reason,
    validatedAt: args.validatedAt,
    log: args.log,
  });

const snapshotOf = (run: XssReplayResult, attempt: number): XssDriverRunSnapshot => ({
  attempt,
  capturedAt: run.capturedAt,
  httpStatus: run.httpStatus,
  domContainsNonce: run.domContainsNonce,
  consoleNonceHits: run.consoleNonceHits,
  alertDispatched: run.alertDispatched,
});

interface ScopeOk {
  readonly kind: 'allow';
}
interface ScopeDeny {
  readonly kind: 'deny';
  readonly reason: string;
}
interface ScopeNoScope {
  readonly kind: 'no_scope';
}

const runScopeDecide = async (
  url: string,
  deps: XssValidatorDeps,
): Promise<ScopeOk | ScopeDeny | ScopeNoScope> => {
  if (!deps.scope) return { kind: 'no_scope' };
  const action: ScopeActionInput = { kind: 'http_request', url, method: 'GET' };
  const decision = await decide(deps.scope, action, deps.scopeDeps);
  if (decision.allowed) return { kind: 'allow' };
  return { kind: 'deny', reason: decision.reason };
};
