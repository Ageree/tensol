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
  type UserSessionsTable,
  type UsersTable,
} from './schema.ts';

export { createDatabase, type DbConfig } from './db.ts';

export { AppendOnlyRepository, type AppendOnlyRepoConfig } from './repos/append-only.ts';

export {
  MutableRepository,
  type CrossTenantAttempt,
  type MutableRepoConfig,
} from './repos/mutable.ts';

export { buildRepositories, type Repositories, type RepoOptions } from './repos/aggregates.ts';
export {
  AuditEventsRepo,
  PLATFORM_TENANT_SLUG,
  type AuditEventCursor,
  type AuditEventsPage,
  decodeCursor,
  encodeCursor,
} from './repos/audit-events.ts';
export { PasswordResetTokensRepo, type RedeemedResetToken } from './repos/password-reset-tokens.ts';
export { PlatformSettingsRepo, type PlatformSettingsRow } from './repos/platform-settings.ts';
export {
  IdempotencyKeysRepo,
  type IdempotencyInsertArgs,
  type IdempotencyLookupArgs,
  type IdempotencyRow,
} from './repos/idempotency-keys.ts';
export {
  insertObservationBrowser,
  listObservationsBrowserByAssessment,
  type ConsoleMessageInput,
  type InsertObservationBrowserInput,
  type InsertObservationBrowserResult,
  type ListObservationsByAssessmentInput,
} from './repos/observations-browser.ts';
export {
  FINDING_STATUSES,
  ValidationStatusInvariantError,
  findFindingByCandidateId,
  getFinding,
  insertConfirmedFinding,
  listFindingsByAssessment,
  updateFindingStatus,
  type FindFindingByCandidateInput,
  type FindingRow,
  type FindingStatus,
  type FindingValidationStatus,
  type GetFindingInput,
  type InsertConfirmedFindingInput,
  type InsertConfirmedFindingResult,
  type ListFindingsByAssessmentInput,
  type UpdateFindingStatusInput,
  type ValidatedByLike,
} from './repos/findings.ts';
export {
  getFindingEvidence,
  insertFindingEvidence,
  listFindingEvidence,
  type FindingEvidenceRow,
  type GetFindingEvidenceInput,
  type InsertFindingEvidenceInput,
  type InsertFindingEvidenceResult,
  type ListFindingEvidenceInput,
} from './repos/finding-evidence.ts';
export {
  findReportById,
  findReportByIdCrossTenant,
  findReportByIdempotencyKey,
  insertReport,
  markReportBuilding,
  markReportFailed,
  markReportReady,
  type FindReportByIdInput,
  type FindReportByIdCrossTenantInput,
  type FindReportByIdempotencyKeyInput,
  type InsertReportInput,
  type MarkReportBuildingInput,
  type MarkReportFailedInput,
  type MarkReportReadyInput,
  type ReportRow,
} from './repos/reports.ts';

export {
  getTargetCredential,
  insertTargetCredential,
  listTargetCredentials,
  type InsertTargetCredentialInput,
  type TargetCredentialRow,
} from './repos/target-credentials.ts';

export type {
  AssessmentApprovalsTable,
  AssessmentTargetsTable,
  AssessmentsTable,
  AssessmentScopeRulesTable,
  AuditEventsTable,
  CandidateFindingsTable,
  FindingEvidenceTable,
  FindingsTable,
  IdempotencyKeysTable,
  ObservationsBrowserTable,
  ProjectsTable,
  TargetCredentialsTable,
  TargetOwnershipClaimsTable,
  TargetsTable,
} from './schema.ts';
