// SQLi replay validator — confirms Decepticon-found SQL injection via HTTP body replay.
//
// Mirrors LFI/RCE structure (scope-gate-before-egress + signal detection).
//
// Audit ownership (M1):
//   - validator.sqli.replay_denied reason:'no_scope'              → worker (handleSqliReplay)
//   - validator.sqli.replay_denied reason:'assessment_mismatch'   → worker
//   - validator.sqli.replay_denied reason:<engine deny>           → this file (decide() denied)
//   - validator.sqli.confirmed                                    → this file (signal match)
//   - validator.sqli.unmatched                                    → this file (no signal / baseline parity)
//   - validator.sqli.fetch_failed                                 → this file (httpFetcher throw)
//
// Algorithm:
//   1. scope.decide({kind:'http_request', url, method}). Denied → out_of_scope. Zero HTTP egress.
//   2. Replay (positive): send method+payloadBody+contentType to affectedUrl.
//      Fetch throw → fetch_failed.
//   3. Run SIGNAL_PATTERNS regex array against response body (truncated to 1MB).
//      Each hit appends pattern.name to signalHits[].
//   4. If baselineBody provided: replay (negative-control) with baselineBody.
//      Compare:
//        - baseline body length within 20% of positive → likely no real bypass; treat hits as weak.
//          BUT: if no positive signal hits at all, status is unmatched regardless.
//        - Stub-injection ZFP guard: if baseline body ALSO matches the same signalHits,
//          the endpoint authentically returns those tokens — not a SQLi confirmation.
//   5. Verdict:
//        signalHits.length >= 1 AND (no baseline OR positive ≠ baseline) → confirmed
//        otherwise → unmatched
//
// Response time is captured (Date.now() before/after) for future time-based blind SQLi
// iterations; MVP records only.

import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const VALIDATOR_WORKER_ACTOR_ID = 'validator-worker' as const;
const BODY_CAP = 1_048_576; // 1 MB — DoS guard (mirrors LFI M3)
const BODY_EXCERPT_CAP = 512;
const BASELINE_LENGTH_PARITY_RATIO = 0.2; // ±20% similarity = no real bypass

export type SqliHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface HttpReplayRequest {
  readonly url: string;
  readonly method: SqliHttpMethod;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpReplayResponse {
  readonly status: number;
  readonly body: string;
}

export interface SqliValidatorInput {
  readonly tenantId: string;
  readonly projectId: string | null;
  readonly assessmentId: string;
  readonly candidateFindingId: string;
  readonly affectedUrl: string;
  /** HTTP method to replay (default 'POST' for login-style SQLi). */
  readonly method?: SqliHttpMethod;
  /** Request body / query string carrying the SQL injection payload. */
  readonly payloadBody: string;
  /** Optional content-type header for the payload request. */
  readonly contentType?: string;
  /** Optional negative-control body. If omitted, validator skips negative
   *  control and uses only positive-side signatures. */
  readonly baselineBody?: string;
  readonly traceId: string;
}

export interface SqliValidatorDeps {
  readonly scope: EffectiveScope;
  readonly scopeDeps: ValidatorScopeDeps;
  readonly httpFetcher: (req: HttpReplayRequest) => Promise<HttpReplayResponse>;
  readonly clock: () => Date;
  readonly auditEmitter: AuditEmitter;
}

export type SqliValidationStatus =
  | 'confirmed'
  | 'unmatched'
  | 'out_of_scope'
  | 'fetch_failed';

export interface SqliEvidence {
  readonly responseStatus: number;
  readonly responseBodyExcerpt: string;
  readonly signalHits: readonly string[];
  readonly baselineStatus?: number;
  readonly responseTimeMs: number;
}

export interface SqliValidationResult {
  readonly status: SqliValidationStatus;
  readonly evidence?: SqliEvidence;
  readonly reason?: string;
}

// Signal patterns — first-match wins per pattern, but ALL hits are collected.
// Order is informational only; every regex runs against the truncated body.
const SIGNAL_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // JWT / token issuance — SQLi auth bypass on login endpoints.
  { name: 'jwt_access_token', regex: /"access_?[Tt]oken"\s*:\s*"[^"]+"/ },
  { name: 'jwt_token_field', regex: /"token"\s*:\s*"eyJ[A-Za-z0-9_-]+\./ },
  { name: 'jwt_eyj_marker', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\./ },
  // DB-error markers (positive signal of injection reaching the parser).
  { name: 'db_error_mysql_syntax', regex: /error\s+in\s+your\s+SQL\s+syntax/i },
  { name: 'db_error_pg_syntax', regex: /PG::SyntaxError|PostgreSQL.*ERROR/i },
  { name: 'db_error_oracle', regex: /\bORA-\d{4,5}\b/ },
  { name: 'db_error_mysql', regex: /\bMySQL\b.*\b(error|server|driver)\b/i },
  { name: 'db_error_sqlite', regex: /\bSQLite\b.*\b(error|exception)\b/i },
  { name: 'db_error_mssql', regex: /Microsoft\s+(OLE\s+DB|SQL\s+Server).*error/i },
  { name: 'db_error_generic_line', regex: /^\s*ERROR\s+at\s+line\s+\d+/m },
  // UNION-injection artifacts.
  { name: 'union_version_marker', regex: /@@version|VERSION\(\)/i },
  { name: 'union_information_schema', regex: /information_schema\.(tables|columns)/i },
];

const collectSignalHits = (body: string): string[] => {
  const hits: string[] = [];
  for (const { name, regex } of SIGNAL_PATTERNS) {
    if (regex.test(body)) {
      hits.push(name);
    }
  }
  return hits;
};

const lengthsSimilar = (a: number, b: number): boolean => {
  if (a === 0 && b === 0) return true;
  const max = Math.max(a, b);
  if (max === 0) return true;
  const delta = Math.abs(a - b) / max;
  return delta <= BASELINE_LENGTH_PARITY_RATIO;
};

const emitSqliAudit = async (
  auditEmitter: AuditEmitter,
  input: SqliValidatorInput,
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

export const validateSqliCandidate = async (
  input: SqliValidatorInput,
  deps: SqliValidatorDeps,
): Promise<SqliValidationResult> => {
  const method: SqliHttpMethod = input.method ?? 'POST';
  const contentType = input.contentType ?? 'application/json';

  // 1. Scope gate BEFORE network egress.
  const decision = await decide(
    deps.scope,
    { kind: 'http_request', url: input.affectedUrl, method },
    deps.scopeDeps,
  );

  if (!decision.allowed) {
    await emitSqliAudit(deps.auditEmitter, input, 'validator.sqli.replay_denied', 'denied', {
      reason: decision.reason,
      affectedUrl: input.affectedUrl,
    });
    return { status: 'out_of_scope', reason: decision.reason };
  }

  // 2. Positive replay.
  const requestHeaders: Record<string, string> = { 'content-type': contentType };
  const positiveReq: HttpReplayRequest = {
    url: input.affectedUrl,
    method,
    body: input.payloadBody,
    headers: requestHeaders,
  };

  const t0 = Date.now();
  let positiveResp: HttpReplayResponse;
  try {
    positiveResp = await deps.httpFetcher(positiveReq);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitSqliAudit(deps.auditEmitter, input, 'validator.sqli.fetch_failed', 'denied', {
      affectedUrl: input.affectedUrl,
      error: message,
    });
    return { status: 'fetch_failed', reason: message };
  }
  const responseTimeMs = Date.now() - t0;

  // 3. Truncate + collect signal hits.
  const positiveBody = positiveResp.body.slice(0, BODY_CAP);
  const signalHits = collectSignalHits(positiveBody);
  const positiveExcerpt = positiveBody.slice(0, BODY_EXCERPT_CAP);

  // 4. Negative-control (optional).
  let baselineStatus: number | undefined;
  let baselineHits: string[] = [];
  let baselineLength = -1;
  if (input.baselineBody !== undefined) {
    try {
      const baselineResp = await deps.httpFetcher({
        url: input.affectedUrl,
        method,
        body: input.baselineBody,
        headers: requestHeaders,
      });
      baselineStatus = baselineResp.status;
      const baselineBody = baselineResp.body.slice(0, BODY_CAP);
      baselineLength = baselineBody.length;
      baselineHits = collectSignalHits(baselineBody);
    } catch {
      // Baseline failure is non-fatal — fall through with positive-only verdict.
      baselineStatus = undefined;
    }
  }

  const evidence: SqliEvidence = {
    responseStatus: positiveResp.status,
    responseBodyExcerpt: positiveExcerpt,
    signalHits,
    responseTimeMs,
    ...(baselineStatus !== undefined ? { baselineStatus } : {}),
  };

  // 5. Verdict.
  const hasHits = signalHits.length >= 1;
  let confirmed = false;

  if (hasHits) {
    if (input.baselineBody === undefined || baselineLength < 0) {
      // No baseline performed — positive-only confirmation.
      confirmed = true;
    } else {
      // Baseline available. Two falsification checks:
      //   (a) Stub-injection ZFP: baseline hits SAME signals → endpoint always
      //       returns the marker (e.g. authed endpoint with persistent token).
      //   (b) Length-parity: baseline body length ~= positive → no real bypass.
      const sharedHits = signalHits.filter((h) => baselineHits.includes(h));
      const allHitsShared = sharedHits.length === signalHits.length;
      const lengthsParity = lengthsSimilar(positiveBody.length, baselineLength);

      if (allHitsShared) {
        confirmed = false; // ZFP — baseline mirrors positive signal.
      } else if (lengthsParity) {
        confirmed = false; // No body divergence — likely no bypass.
      } else {
        confirmed = true;
      }
    }
  }

  if (confirmed) {
    await emitSqliAudit(deps.auditEmitter, input, 'validator.sqli.confirmed', 'success', {
      affectedUrl: input.affectedUrl,
      signalHits,
      responseStatus: positiveResp.status,
      ...(baselineStatus !== undefined ? { baselineStatus } : {}),
      responseTimeMs,
    });
    return { status: 'confirmed', evidence };
  }

  await emitSqliAudit(deps.auditEmitter, input, 'validator.sqli.unmatched', 'success', {
    affectedUrl: input.affectedUrl,
    signalHits,
    responseStatus: positiveResp.status,
    ...(baselineStatus !== undefined ? { baselineStatus } : {}),
    responseTimeMs,
  });
  return { status: 'unmatched', evidence };
};
