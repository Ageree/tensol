// Sprint 4 A6 + A22 — single audit writer.
//
// Replaces the body of apps/api/src/middleware/audit.ts:emitAudit. The
// existing call sites in apps/api/src/routes/shared.ts continue to call
// `emitAudit(deps, args)` with the same arg shape (the shim re-exports
// from this package — A6).
//
// A22 — telemetry call:
//   - Wrapped in try/catch.
//   - Throws are caught + console.warn'd with `{event: 'telemetry_failure', traceId}`.
//   - NEVER blocks, retries, or rethrows.
//   - SENTRY_DSN unset → telemetry call skipped.
//   - SENTRY_DSN set + mocked SDK throws → audit row still written.
//
// EE-2 (2026-05-12) — HMAC-SHA256 audit signing.
//   - Optional `signer` in deps; when provided, every emitted row carries a
//     base64url-encoded HMAC over the canonical message.
//   - signer:null path keeps unit-test mocks (writer.test.ts) compatible.
//   - Production wires signer via apps/api/src/routes/shared.ts using the
//     per-tenant audit_key from tenants table (mig 027).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuditAction, AuditOutcome, ServiceActorId } from '@cyberstrike/contracts';
import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';

export type { AuditAction, AuditOutcome } from '@cyberstrike/contracts';

export interface EmitAuditArgs {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly actorType: 'user' | 'service';
  readonly actorId: string;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly projectId?: string | null;
  readonly assessmentId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly traceId: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface AuditDeps {
  readonly db: Kysely<Database>;
}

/**
 * Optional Sentry-style telemetry hook. Real Sentry SDK wiring lands in
 * Sprint 8; meanwhile callers may inject any function with this shape and
 * we'll guard it with try/catch (A22).
 */
export type TelemetryEmit = (args: {
  action: AuditAction;
  outcome: AuditOutcome;
  traceId: string;
  tenantId: string;
}) => void | Promise<void>;

/**
 * EE-2 — pluggable audit signer. Production wires a real HMAC-SHA256 signer
 * over per-tenant audit_key. Unit tests omit signer; signature column stays
 * null (acceptable for unit-level — production paths MUST inject signer).
 */
export interface AuditSigner {
  /** Returns base64url HMAC-SHA256 over canonicalMessage, or null to skip. */
  readonly sign: (tenantId: string, canonicalMessage: string) => Promise<string | null>;
}

interface InternalDeps extends AuditDeps {
  readonly telemetry?: TelemetryEmit | undefined;
  /** Test seam — overrides the SENTRY_DSN env check. */
  readonly sentryEnabled?: boolean | undefined;
  /** EE-2 — optional HMAC signer. Null → signature column stays null. */
  readonly signer?: AuditSigner | undefined;
}

const canonicaliseMetadata = (m: Record<string, unknown> | undefined): string => {
  if (!m || Object.keys(m).length === 0) return '{}';
  const sortedKeys = Object.keys(m).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = m[k];
  return JSON.stringify(sorted);
};

/**
 * EE-2 — canonical audit message for HMAC. Pipe-delimited to keep zero
 * ambiguity (no field contains an unescaped `|` because UUIDs, ISO dates,
 * and known enum values exclude it; metadata is JSON-serialised so internal
 * pipes are escaped). Include only fields an adversary could meaningfully
 * tamper with to forge evidence.
 */
export const buildCanonicalAuditMessage = (
  args: EmitAuditArgs,
  occurredAtIso: string,
): string =>
  [
    args.tenantId,
    args.action,
    args.outcome,
    args.actorType,
    args.actorId,
    args.actorName,
    args.resourceType,
    args.resourceId ?? '',
    args.projectId ?? '',
    args.assessmentId ?? '',
    args.traceId,
    occurredAtIso,
    canonicaliseMetadata(args.metadata),
  ].join('|');

/** EE-2 — HMAC-SHA256 in base64url. */
export const hmacSign = (key: Buffer, msg: string): string =>
  createHmac('sha256', key).update(msg, 'utf8').digest('base64url');

/** EE-2 — constant-time signature verification. */
export const verifyAuditSignature = (key: Buffer, canonical: string, sig: string): boolean => {
  const computed = hmacSign(key, canonical);
  const a = Buffer.from(computed);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const sentryEnabledByEnv = (): boolean => {
  // Destructuring sidesteps `noPropertyAccessFromIndexSignature` (TS strict)
  // and `useLiteralKeys` (biome) — both of which fire on
  // `process.env['SENTRY_DSN']` vs `process.env.SENTRY_DSN`.
  const { SENTRY_DSN } = process.env;
  return typeof SENTRY_DSN === 'string' && SENTRY_DSN.length > 0;
};

export const emitAudit = async (deps: InternalDeps, args: EmitAuditArgs): Promise<void> => {
  // EE-2 — compute occurredAt up front so canonical message and DB row agree.
  // Without explicit occurred_at the DB sets now() and signature would race.
  const occurredAtIso = new Date().toISOString();
  let signature: string | null = null;
  if (deps.signer) {
    const canonical = buildCanonicalAuditMessage(args, occurredAtIso);
    try {
      signature = await deps.signer.sign(args.tenantId, canonical);
    } catch (err) {
      // Auditability invariant (A8 NQ-A): never silently drop a row when
      // signing fails — log loudly, write the row unsigned (signature stays
      // null) so the chain isn't broken; an operator can re-sign later.
      console.warn(
        JSON.stringify({
          event: 'audit_signing_failure',
          traceId: args.traceId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  await deps.db
    .insertInto('audit_events')
    .values({
      tenant_id: args.tenantId,
      project_id: args.projectId ?? null,
      assessment_id: args.assessmentId ?? null,
      actor_type: args.actorType,
      actor_id: args.actorId,
      actor_name: args.actorName,
      action: args.action,
      resource_type: args.resourceType,
      resource_id: args.resourceId ?? null,
      before_state: null,
      after_state: { outcome: args.outcome, ...(args.metadata ?? {}) },
      ip: args.ip ?? null,
      user_agent: args.userAgent ?? null,
      trace_id: args.traceId,
      occurred_at: new Date(occurredAtIso),
      signature,
    })
    .execute();

  // A22 — telemetry breadcrumb. Only fires when explicitly enabled (test seam)
  // OR when `SENTRY_DSN` is set. Wrapped in try/catch so a throw never
  // propagates, retries, or blocks the audit row.
  const enabled = deps.sentryEnabled ?? sentryEnabledByEnv();
  if (enabled && deps.telemetry) {
    try {
      await deps.telemetry({
        action: args.action,
        outcome: args.outcome,
        traceId: args.traceId,
        tenantId: args.tenantId,
      });
    } catch {
      console.warn(JSON.stringify({ event: 'telemetry_failure', traceId: args.traceId }));
    }
  }
};

export type { ServiceActorId };
