// Sprint 19 — LFI/path-traversal validator. Sentinel-content match.
//
// Audit ownership (M1):
//   - validator.lfi.replay_denied reason:'no_scope'    → worker (handleLfiReplay step 5)
//   - validator.lfi.replay_denied reason:<engine deny> → this file (decide() denied)
//   - validator.lfi.confirmed                          → this file (sentinel match)
//   - validator.lfi.unmatched                          → this file (no sentinel match)
//
// Scope gate BEFORE network egress (S13 per-candidate-gate lesson):
//   1. scope is EffectiveScope (non-null — worker guards null before calling us).
//   2. Call decide(scope, {kind:'http_request', url:affectedUrl, method:'GET'}, scopeDeps).
//   3. Denied → emit validator.lfi.replay_denied, return out_of_scope. Zero HTTP calls.
//   4. Allowed → GET affectedUrl via injected httpClient.
//   5. Truncate body at 1MB (M3 — DoS guard).
//   6. Match body against sentinel patterns (first match wins, M4).
//   7. Match → emit validator.lfi.confirmed, return confirmed (worker inserts finding).
//   8. No match → emit validator.lfi.unmatched, return unmatched.

import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const VALIDATOR_WORKER_ACTOR_ID = 'validator-worker' as const;
const BODY_CAP = 1_048_576; // 1 MB (M3)

export interface LfiValidatorInput {
  readonly candidateFindingId: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId?: string | null;
  readonly affectedUrl: string;
  readonly scope: EffectiveScope;
  readonly traceId: string;
}

export interface LfiValidatorDeps {
  readonly scopeDeps: ValidatorScopeDeps;
  readonly auditEmitter: AuditEmitter;
  readonly httpClient: { get(url: string): Promise<{ body: string }>; readonly callCount: number };
}

export type LfiValidationStatus = 'confirmed' | 'unmatched' | 'out_of_scope' | 'fetch_failed';

export interface LfiValidationResult {
  readonly status: LfiValidationStatus;
  readonly reason?: string;
  readonly sentinelKey?: string;
  readonly matchedSnippet?: string | null;
}

// Sentinel patterns — first match wins (M4 priority order).
const SENTINELS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: 'unix_passwd', re: /^root:[x*]:0:0:/m },
  { key: 'unix_shadow', re: /^root:[!*$\w./]+:\d+:\d+:/m },
  { key: 'windows_hosts', re: /^# Copyright \(c\) 1993-\d{4} Microsoft Corp\./m },
  { key: 'windows_boot_ini', re: /^\[boot loader\]/m },
  { key: 'php_config', re: /^short_open_tag\s*=\s*(On|Off)/im }, // H1 — line-anchored
  { key: 'linux_generic', re: /^bin:[x*]:1:1:/m },
];

const matchSentinel = (body: string): { key: string; snippet: string } | null => {
  for (const { key, re } of SENTINELS) {
    const m = re.exec(body);
    if (m) {
      return { key, snippet: m[0].slice(0, 256) };
    }
  }
  return null;
};

const emitLfiAudit = async (
  auditEmitter: AuditEmitter,
  input: LfiValidatorInput,
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

export const validateLfiCandidate = async (
  input: LfiValidatorInput,
  deps: LfiValidatorDeps,
): Promise<LfiValidationResult> => {
  // 1. Scope gate BEFORE network egress. scope is always non-null here (worker guards it).
  const decision = await decide(
    input.scope,
    { kind: 'http_request', url: input.affectedUrl, method: 'GET' },
    deps.scopeDeps,
  );

  if (!decision.allowed) {
    await emitLfiAudit(deps.auditEmitter, input, 'validator.lfi.replay_denied', 'denied', {
      reason: decision.reason,
      affectedUrl: input.affectedUrl,
    });
    return { status: 'out_of_scope', reason: decision.reason };
  }

  // 2. Fetch candidate URL — bounded; degraded targets (timeout/reset) → fetch_failed terminal ack.
  let response: { body: string };
  try {
    response = await deps.httpClient.get(input.affectedUrl);
  } catch (err) {
    await emitLfiAudit(deps.auditEmitter, input, 'validator.lfi.fetch_failed', 'denied', {
      affectedUrl: input.affectedUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'fetch_failed', reason: err instanceof Error ? err.message : String(err) };
  }

  // 3. Truncate body at 1MB before regex (M3 — DoS guard).
  const safeBody = response.body.slice(0, BODY_CAP);

  // 4. Sentinel-content match — first match wins (M4).
  const hit = matchSentinel(safeBody);

  if (hit) {
    await emitLfiAudit(deps.auditEmitter, input, 'validator.lfi.confirmed', 'success', {
      sentinelKey: hit.key,
      affectedUrl: input.affectedUrl,
    });
    return { status: 'confirmed', sentinelKey: hit.key, matchedSnippet: hit.snippet };
  }

  // 5. No sentinel match.
  await emitLfiAudit(deps.auditEmitter, input, 'validator.lfi.unmatched', 'success', {
    affectedUrl: input.affectedUrl,
  });
  return { status: 'unmatched' };
};
