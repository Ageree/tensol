// Sprint 3 contract C29 — audit-event emission helper.
//
// Every state-changing auth route emits EXACTLY ONE row to `audit_events` per
// request via `emitAudit(deps, args)`. Outcomes are captured as a typed enum
// per action, validated at the call site. The route layer composes these
// arguments and calls emitAudit synchronously after the DB transition.
//
// The helper is intentionally a free function — wiring it as middleware would
// hide the explicit "1 row per attempt" semantics that C29 asserts.

import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';

export type AuditAction =
  | 'auth.register'
  | 'auth.login.password'
  | 'auth.login.mfa'
  | 'auth.logout'
  | 'auth.mfa.enable'
  | 'auth.mfa.verify'
  | 'auth.password.reset.request'
  | 'auth.password.reset.confirm';

export type AuditOutcome =
  | 'success'
  | 'failure'
  | 'mfa_required'
  | 'gone'
  | 'no_session'
  | 'issued'
  | 'miss'
  | 'replay';

export interface EmitAuditArgs {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly actorType: 'user' | 'service';
  readonly actorId: string;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly traceId: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface AuditDeps {
  readonly db: Kysely<Database>;
}

export const emitAudit = async (deps: AuditDeps, args: EmitAuditArgs): Promise<void> => {
  await deps.db
    .insertInto('audit_events')
    .values({
      tenant_id: args.tenantId,
      project_id: null,
      assessment_id: null,
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
};
