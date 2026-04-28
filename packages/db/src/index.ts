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
  PLATFORM_SCOPED_TABLES,
  TENANT_OWNED_TABLES,
  VERSIONED_TABLES,
  type Database,
  type Json,
  type PasswordResetTokensTable,
  type PlatformSettingsTable,
} from './schema.ts';

export { createDatabase, type DbConfig } from './db.ts';

export { AppendOnlyRepository, type AppendOnlyRepoConfig } from './repos/append-only.ts';

export {
  MutableRepository,
  type CrossTenantAttempt,
  type MutableRepoConfig,
} from './repos/mutable.ts';

export { buildRepositories, type Repositories, type RepoOptions } from './repos/aggregates.ts';
export { PasswordResetTokensRepo, type RedeemedResetToken } from './repos/password-reset-tokens.ts';
export { PlatformSettingsRepo, type PlatformSettingsRow } from './repos/platform-settings.ts';
