// Public surface of @cyberstrike/db.
//
// Sprint 2: error types, tenant context plumbing, repository bases, schema
// types, Database factory. Per-aggregate repositories and migration runner
// scripts land alongside their migrations.

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

export {
  ALL_TABLE_NAMES,
  APPEND_ONLY_TABLES,
  TENANT_OWNED_TABLES,
  VERSIONED_TABLES,
  type Database,
  type Json,
} from './schema.ts';

export { createDatabase, type DbConfig } from './db.ts';

export { AppendOnlyRepository, type AppendOnlyRepoConfig } from './repos/append-only.ts';

export {
  MutableRepository,
  type CrossTenantAttempt,
  type MutableRepoConfig,
} from './repos/mutable.ts';
