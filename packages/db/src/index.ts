// Public surface of @cyberstrike/db.
//
// Sprint 2 baseline: error types, tenant context plumbing, repository bases.
// Schema types, kysely Database interface, and per-aggregate repositories
// land in subsequent commits as migrations are authored.

export const name = 'packages/db' as const;

export {
  AppendOnlyViolationError,
  MissingTenantContextError,
  OptimisticLockError,
  TenantContextMismatchError,
} from './errors.ts';

export {
  getAmbientTenantId,
  resolveTenantId,
  runInTenant,
  type ResolveTenantArgs,
  type TenantStore,
} from './tenant-context.ts';
