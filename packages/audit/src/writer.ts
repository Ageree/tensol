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

interface InternalDeps extends AuditDeps {
  readonly telemetry?: TelemetryEmit | undefined;
  /** Test seam — overrides the SENTRY_DSN env check. */
  readonly sentryEnabled?: boolean | undefined;
}

const sentryEnabledByEnv = (): boolean => {
  // Destructuring sidesteps `noPropertyAccessFromIndexSignature` (TS strict)
  // and `useLiteralKeys` (biome) — both of which fire on
  // `process.env['SENTRY_DSN']` vs `process.env.SENTRY_DSN`.
  const { SENTRY_DSN } = process.env;
  return typeof SENTRY_DSN === 'string' && SENTRY_DSN.length > 0;
};

export const emitAudit = async (deps: InternalDeps, args: EmitAuditArgs): Promise<void> => {
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
