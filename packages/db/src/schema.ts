// Kysely Database type — every table that lives in Postgres for Sprint 2.
//
// Conventions:
// - All UUIDs typed as string.
// - All TIMESTAMPTZ typed as Date.
// - JSONB columns use a generic `Json` shape; specific schemas live in
//   packages/contracts and are zod-validated at the repository boundary.
// - Append-only tables have NO `updatedAt` column (Sprint 2 contract B11/B13).
// - Mutable aggregates (assessments, targets, scope rules) have a `version`
//   column for optimistic locking (Sprint 2 contract B20).
// - Object-storage references use the (objectStorageKey, sha256, sizeBytes)
//   triple — no inline blobs (Sprint 2 contract B23).

import type { ColumnType, Generated } from 'kysely';

export type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

// Helper: a column where the DB sets a default on insert (e.g. now() / gen_random_uuid()).
type DbDefault<T> = ColumnType<T, T | undefined, T>;

// =============== platform tables ===============

interface TenantsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: string; // CHECK ('active'|'suspended'|'archived')
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== identity ===============

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  status: string; // CHECK ('active'|'disabled'|'pending')
  role: string; // platform_admin|tenant_admin|security_lead|operator|developer|auditor|viewer
  mfa_enrolled: DbDefault<boolean>;
  // S24 mig 023: mock email-verified flag (always true until SMTP phase).
  email_verified: DbDefault<boolean>;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

export interface UserSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

interface MfaSecretsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  secret_encrypted: string;
  algo: string;
  digits: number;
  period_seconds: number;
  enrolled_at: Date | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== auth (password reset) ===============

export interface PasswordResetTokensTable {
  // PRIMARY KEY: sha256(plaintext) hex (CHAR(64)). The plaintext NEVER reaches DB.
  token_hash: string;
  user_id: string;
  tenant_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== platform settings (singleton) ===============

export interface PlatformSettingsTable {
  // CHAR(1) singleton lock — only ever value 'x'. Platform-scoped (NO tenant_id).
  lock: DbDefault<string>;
  bootstrap_consumed_at: Date | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== domain core ===============

export interface ProjectsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string;
  status: string; // CHECK ('active'|'archived')
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

export interface TargetsTable {
  id: Generated<string>;
  tenant_id: string;
  project_id: string;
  kind: string; // CHECK ('url'|'domain'|'ip'|'cidr'|'cloud_account'|'k8s_namespace'|'repo')
  value: string;
  ownership_status: string; // CHECK ('unverified'|'pending'|'verified')
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
  version: DbDefault<number>;
}

export interface AssessmentsTable {
  id: Generated<string>;
  tenant_id: string;
  project_id: string;
  state: string; // draft|submitted|approved|running|paused|cancelled|completed|failed
  created_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  testing_window_start: Date | null;
  testing_window_end: Date | null;
  high_impact_categories: Json; // string[]
  metadata: Json;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
  version: DbDefault<number>;
}

export interface AssessmentScopeRulesTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  rule_kind: string;
  effect: string; // 'allow'|'deny'
  payload: Json;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
  version: DbDefault<number>;
}

// =============== assessment ↔ target join (Sprint 5 / migration 016) ===============

export interface AssessmentTargetsTable {
  // composite PK on (assessment_id, target_id); both NOT NULL.
  assessment_id: string;
  target_id: string;
  tenant_id: string; // denormalised for tenant-scoped filtering.
  created_at: DbDefault<Date>;
}

// =============== idempotency cache (Sprint 5 / migration 016) ===============

// Mutable in the limited sense that rows expire after 24h, but the body of
// a cached row is never edited — only inserted (winning the unique-on-(tenant,key)
// race) or read. Sprint 5 R2: ONLY 2xx responses persist.
export interface IdempotencyKeysTable {
  // composite PK on (tenant_id, key); both NOT NULL.
  key: string;
  tenant_id: string;
  actor_id: string;
  route_method: string;
  route_path: string;
  request_hash: string;
  response_status: number;
  response_body: Json;
  created_at: DbDefault<Date>;
}

// =============== append-only artifacts (NO updated_at) ===============

interface AssessmentArtifactsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  kind: string;
  object_storage_key: string;
  sha256: string;
  size_bytes: string; // BIGINT — Kysely returns string for numerics
  metadata: Json;
  created_at: DbDefault<Date>;
}

// =============== queue / coordinator ===============

interface JobsTable {
  id: Generated<string>;
  tenant_id: string;
  project_id: string | null;
  assessment_id: string | null;
  kind: string;
  status: string; // pending|running|succeeded|failed_transient|failed_terminal
  attempt: DbDefault<number>;
  max_attempts: number;
  idempotency_key: string;
  not_before: Date | null;
  trace_id: string;
  payload: Json;
  last_error: string | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== decepticon (sprint 8 minimal) ===============

interface DecepticonSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  status: string; // started|planning|recon|exploit|reporting|completed|failed
  opplan_object_key: string;
  opplan_sha256: string;
  opplan_size_bytes: string;
  /** Sprint 13 — LangGraph thread_id from RealDecepticonAdapter. NULL for fake sessions. */
  langgraph_thread_id: string | null;
  started_at: DbDefault<Date>;
  completed_at: Date | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== observations (sprint 9 minimal — browser only) ===============

export interface ObservationsBrowserTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  url: string;
  http_status: number | null;
  screenshot_object_key: string;
  screenshot_sha256: string;
  screenshot_size_bytes: string;
  har_object_key: string;
  har_sha256: string;
  har_size_bytes: string;
  trace_object_key: string;
  trace_sha256: string;
  trace_size_bytes: string;
  console_messages: Json;
  // Sprint 16 SPA route discovery columns (migration 019).
  source_url: string | null;
  depth: number;
  discovery_method: string;
  observed_at: DbDefault<Date>;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== findings (sprints 10-11) ===============

export interface CandidateFindingsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  type: string; // xss_reflected, etc.
  severity: string;
  affected_url: string;
  source: string; // decepticon|http-worker|...
  payload: Json;
  observed_at: DbDefault<Date>;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

export interface FindingsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  created_from_candidate_id: string;
  type: string;
  severity: string;
  confidence: string; // 'low'|'medium'|'high'
  status: string; // open|triaged|accepted_risk|false_positive|fixed|retested|closed
  affected_url: string;
  reproduction: Json;
  validator_log: Json;
  validated_at: Date;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// target_ownership_claims is APPEND-ONLY (Sprint 5 / migration 016)
export interface TargetOwnershipClaimsTable {
  id: Generated<string>;
  tenant_id: string;
  target_id: string;
  method: string; // CHECK ('dns_txt'|'http_meta'|'manual_attestation')
  evidence: string;
  submitted_by_user_id: string;
  submitted_at: DbDefault<Date>;
  created_at: DbDefault<Date>;
}

// assessment_approvals is APPEND-ONLY (Sprint 5 / migration 016 / R5 path B)
export interface AssessmentApprovalsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  approved_by: string;
  approved_at: DbDefault<Date>;
  target_count: number;
  high_impact_categories: Json;
  created_at: DbDefault<Date>;
}

// finding_evidence is APPEND-ONLY (no updated_at)
export interface FindingEvidenceTable {
  id: Generated<string>;
  tenant_id: string;
  finding_id: string;
  kind: string; // screenshot|har|trace|json
  object_storage_key: string;
  sha256: string;
  size_bytes: string;
  metadata: Json;
  created_at: DbDefault<Date>;
}

// =============== audit (append-only) ===============

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  project_id: string | null;
  assessment_id: string | null;
  actor_type: string; // user|service
  actor_id: string;
  actor_name: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: Json | null;
  after_state: Json | null;
  ip: string | null;
  user_agent: string | null;
  trace_id: string;
  occurred_at: DbDefault<Date>;
  created_at: DbDefault<Date>;
}

interface LlmAuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string | null;
  model_id: string;
  request_hash: string;
  response_hash: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd_micros: string | null;
  trace_id: string;
  occurred_at: DbDefault<Date>;
  created_at: DbDefault<Date>;
}

// =============== reports (sprint 14 — one snapshot row per build) ===============

interface ReportsTable {
  id: Generated<string>;
  tenant_id: string;
  assessment_id: string;
  idempotency_key: string;
  status: string; // queued|building|ready|failed
  // HTML artifact (null until status=ready)
  object_key_html: string | null;
  sha256_html: string | null;
  size_bytes_html: string | null; // BIGINT — Kysely returns string
  // JSON artifact (null until status=ready)
  object_key_json: string | null;
  sha256_json: string | null;
  size_bytes_json: string | null;
  // ZIP artifact (null until status=ready)
  object_key_zip: string | null;
  sha256_zip: string | null;
  size_bytes_zip: string | null;
  failure_reason: string | null;
  created_at: DbDefault<Date>;
  completed_at: Date | null;
}

export interface TargetCredentialsTable {
  id: Generated<string>;
  tenant_id: string;
  target_id: string;
  recipe_id: string;
  // Sprint 23 mig 022: replaced encrypted_blob/iv/auth_tag bytea columns.
  recipe_text: string;
  created_by: string;
  // Sprint 17 mig 020: cosmetic display name, set once at INSERT.
  name: string;
  created_at: DbDefault<Date>;
}

// Sprint 17 mig 020 — mutable usage tracking (sibling to append-only target_credentials).
// =============== OOB callbacks (Sprint 18) ===============

interface OobCallbacksTable {
  id: Generated<string>;
  tenant_id: string | null;
  candidate_id: string | null;
  token: string | null;
  kind: string; // CHECK ('http' | 'dns')
  method: string | null;
  path: string | null;
  qname: string | null;
  qtype: string | null;
  headers: Json | null;
  body: string | null;
  source_ip: string | null;
  created_at: DbDefault<Date>;
}

interface TargetCredentialUsageTable {
  id: Generated<string>;
  credential_id: string;
  tenant_id: string;
  last_used_at: Date;
  use_count: number;
}

// =============== S24 SaaS billing stubs (mig 023) ===============

export interface SubscriptionsTable {
  id: Generated<string>;
  tenant_id: string;
  tier: string; // CHECK ('light'|'medium'|'aggressive')
  status: string; // CHECK ('trial'|'active'|'cancelled')
  trial_ends_at: Date | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

export interface InvoicesTable {
  id: Generated<string>;
  tenant_id: string;
  amount_kopecks: number; // bigint — overflow-safe for RUB amounts
  status: string; // CHECK ('mock'|'pending'|'paid'|'failed')
  metadata: Json;
  created_at: DbDefault<Date>;
}

// =============== S25 domain verification (mig 024) ===============

export interface DomainVerificationsTable {
  id: Generated<string>;
  tenant_id: string;
  target_id: string;
  domain: string;
  token: string; // 'cs-verify=<hex32>'
  status: string; // CHECK ('pending'|'verified'|'expired')
  verified_at: Date | null;
  expires_at: Date;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}

// =============== S25 api_tokens (mig 025) ===============

export interface ApiTokensTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  name: string;
  token_hash: string; // sha256(plaintext) — NEVER store plaintext
  last_used_at: Date | null;
  expires_at: Date | null;
  created_at: DbDefault<Date>;
}

// =============== aggregate Database type ===============

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  user_sessions: UserSessionsTable;
  mfa_secrets: MfaSecretsTable;
  password_reset_tokens: PasswordResetTokensTable;
  platform_settings: PlatformSettingsTable;
  projects: ProjectsTable;
  targets: TargetsTable;
  assessments: AssessmentsTable;
  assessment_scope_rules: AssessmentScopeRulesTable;
  assessment_targets: AssessmentTargetsTable;
  assessment_artifacts: AssessmentArtifactsTable;
  assessment_approvals: AssessmentApprovalsTable;
  target_ownership_claims: TargetOwnershipClaimsTable;
  idempotency_keys: IdempotencyKeysTable;
  jobs: JobsTable;
  decepticon_sessions: DecepticonSessionsTable;
  observations_browser: ObservationsBrowserTable;
  candidate_findings: CandidateFindingsTable;
  findings: FindingsTable;
  finding_evidence: FindingEvidenceTable;
  audit_events: AuditEventsTable;
  llm_audit_events: LlmAuditEventsTable;
  reports: ReportsTable;
  target_credentials: TargetCredentialsTable;
  target_credential_usage: TargetCredentialUsageTable;
  oob_callbacks: OobCallbacksTable;
  subscriptions: SubscriptionsTable;
  invoices: InvoicesTable;
  domain_verifications: DomainVerificationsTable;
  api_tokens: ApiTokensTable;
}

// Used by tests (B3) to assert every table key is present.
export const ALL_TABLE_NAMES: ReadonlyArray<keyof Database> = [
  'tenants',
  'users',
  'user_sessions',
  'mfa_secrets',
  'password_reset_tokens',
  'platform_settings',
  'projects',
  'targets',
  'assessments',
  'assessment_scope_rules',
  'assessment_targets',
  'assessment_artifacts',
  'assessment_approvals',
  'target_ownership_claims',
  'idempotency_keys',
  'jobs',
  'decepticon_sessions',
  'observations_browser',
  'candidate_findings',
  'findings',
  'finding_evidence',
  'audit_events',
  'llm_audit_events',
  'reports',
  'target_credentials',
  'target_credential_usage',
  'oob_callbacks',
  'subscriptions',
  'invoices',
  'domain_verifications',
  'api_tokens',
] as const;

export const APPEND_ONLY_TABLES: ReadonlyArray<keyof Database> = [
  'assessment_artifacts',
  'assessment_approvals',
  'target_ownership_claims',
  'finding_evidence',
  'audit_events',
  'llm_audit_events',
  'reports',
  'target_credentials',
  'oob_callbacks',
] as const;

/** Platform-scoped tables (no tenant_id column). */
export const PLATFORM_SCOPED_TABLES: ReadonlyArray<keyof Database> = [
  'tenants',
  'platform_settings',
] as const;

export const TENANT_OWNED_TABLES: ReadonlyArray<keyof Database> = ALL_TABLE_NAMES.filter(
  (t) => !PLATFORM_SCOPED_TABLES.includes(t),
);

export const VERSIONED_TABLES: ReadonlyArray<keyof Database> = [
  'assessments',
  'targets',
  'assessment_scope_rules',
] as const;
