// Sprint 4 A6 — thin re-export shim. The body moved to packages/audit's
// writer.ts; existing Sprint 3 call sites in apps/api/src/routes/shared.ts
// continue to work without signature change.
//
// AuditAction / AuditOutcome unions are now sourced from
// `@cyberstrike/contracts` and include the Sprint 4 deny-pipeline entries
// (`rbac.deny`, `tenant.cross_tenant_attempt`, `audit.append_only_violation`,
// `denied`, `forbidden`, `cross_tenant`).

export {
  type AuditAction,
  type AuditDeps,
  type AuditOutcome,
  type EmitAuditArgs,
  emitAudit,
} from '@cyberstrike/audit';
