// Sprint 4 A7/A8/A9 — deny-audit helper.
//
// Single entry point used by:
//   1. Hono onError handler when catching RbacDenyError → action='rbac.deny',
//      outcome='forbidden' (A8). Tenant attribution: actor's tenant (R3).
//   2. buildRepositories() onCrossTenantAttempt closure → action=
//      'tenant.cross_tenant_attempt', outcome='cross_tenant' (A9).
//   3. Future scope-engine deny + tool-policy deny in Sprint 5/6.
//
// The helper itself is dumb: it just calls emitAudit with the denied
// outcome (constrained at compile-time to the 3 deny outcomes). Callers
// supply the action + tenant attribution.

import type { AuditAction, AuditOutcome } from '@cyberstrike/contracts';
import { type AuditDeps, type EmitAuditArgs, emitAudit } from './writer.ts';

export type DenyAction = Extract<
  AuditAction,
  'rbac.deny' | 'tenant.cross_tenant_attempt' | 'audit.append_only_violation'
>;

export type DenyOutcome = Extract<AuditOutcome, 'denied' | 'forbidden' | 'cross_tenant'>;

export interface DenyAuditArgs {
  readonly tenantId: string;
  readonly action: DenyAction;
  readonly outcome: DenyOutcome;
  readonly actorType: 'user' | 'service';
  readonly actorId: string;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly reason: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly traceId: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Emit a single deny audit row. Throws if the underlying insert throws —
 * callers (Hono onError handler) MUST surface the throw as an internal
 * error, never as the original 403, per A8 NQ-A.
 */
export const denyAudit = async (deps: AuditDeps, args: DenyAuditArgs): Promise<void> => {
  const merged: EmitAuditArgs = {
    tenantId: args.tenantId,
    action: args.action,
    outcome: args.outcome,
    actorType: args.actorType,
    actorId: args.actorId,
    actorName: args.actorName,
    resourceType: args.resourceType,
    resourceId: args.resourceId ?? null,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
    traceId: args.traceId,
    metadata: { reason: args.reason, ...(args.metadata ?? {}) },
  };
  await emitAudit(deps, merged);
};
