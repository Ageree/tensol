// Per-aggregate repositories. Thin wrappers over AppendOnlyRepository /
// MutableRepository so call sites get a typed handle without restating
// table name / resource type / versioned flag.
//
// Sprint 2: 17 aggregates. Append-only set: assessment_artifacts,
// finding_evidence, audit_events, llm_audit_events.

import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';
import { AppendOnlyRepository } from './append-only.ts';
import { AuditEventsRepo } from './audit-events.ts';
import { IdempotencyKeysRepo } from './idempotency-keys.ts';
import { type CrossTenantAttempt, MutableRepository } from './mutable.ts';
import { PasswordResetTokensRepo } from './password-reset-tokens.ts';
import { PlatformSettingsRepo } from './platform-settings.ts';

export interface RepoOptions {
  readonly onCrossTenantAttempt?: ((event: CrossTenantAttempt) => void) | undefined;
}

const versioned = (resourceType: string, opts?: RepoOptions) => ({
  resourceType,
  versioned: true,
  onCrossTenantAttempt: opts?.onCrossTenantAttempt,
});

const mutable = (resourceType: string, opts?: RepoOptions) => ({
  resourceType,
  versioned: false,
  onCrossTenantAttempt: opts?.onCrossTenantAttempt,
});

export const buildRepositories = (db: Kysely<Database>, opts: RepoOptions = {}) =>
  Object.freeze({
    // platform-level (no tenant_id column on tenants itself; the repo still
    // takes tenantId for symmetry with tenant-scoped repos but resolves to
    // the global value at the API boundary).
    tenants: new MutableRepository(db, 'tenants', mutable('tenant', opts)),

    // identity
    users: new MutableRepository(db, 'users', mutable('user', opts)),
    userSessions: new MutableRepository(db, 'user_sessions', mutable('user_session', opts)),
    mfaSecrets: new MutableRepository(db, 'mfa_secrets', mutable('mfa_secret', opts)),
    passwordResetTokens: new PasswordResetTokensRepo(db),
    platformSettings: new PlatformSettingsRepo(db),

    // domain core
    projects: new MutableRepository(db, 'projects', mutable('project', opts)),
    targets: new MutableRepository(db, 'targets', versioned('target', opts)),
    assessments: new MutableRepository(db, 'assessments', versioned('assessment', opts)),
    assessmentScopeRules: new MutableRepository(
      db,
      'assessment_scope_rules',
      versioned('assessment_scope_rule', opts),
    ),

    // Sprint 5 / migration 016 — assessment ↔ target join (mutable in the
    // limited sense that rows can be inserted or set-replaced atomically;
    // no per-row update — only delete-then-insert during PATCH).
    assessmentTargets: new MutableRepository(db, 'assessment_targets', {
      resourceType: 'assessment_target',
      versioned: false,
      onCrossTenantAttempt: opts.onCrossTenantAttempt,
    }),

    // append-only
    assessmentArtifacts: new AppendOnlyRepository(db, 'assessment_artifacts', {
      resourceType: 'assessment_artifact',
    }),
    /** Sprint 5 / migration 016 / R5 path B — append-only forensic record of approvals. */
    assessmentApprovals: new AppendOnlyRepository(db, 'assessment_approvals', {
      resourceType: 'assessment_approval',
    }),
    /** Sprint 5 / migration 016 / OQ-3 — append-only ownership-proof history. */
    targetOwnershipClaims: new AppendOnlyRepository(db, 'target_ownership_claims', {
      resourceType: 'target_ownership_claim',
    }),
    findingEvidence: new AppendOnlyRepository(db, 'finding_evidence', {
      resourceType: 'finding_evidence',
    }),
    auditEvents: new AppendOnlyRepository(db, 'audit_events', {
      resourceType: 'audit_event',
    }),
    /** Sprint 4 A11/A12 — tenant-aware read API (sentinel-filtered). */
    auditEventsForTenant: new AuditEventsRepo(db),
    /** Sprint 5 / R2 — idempotency cache (2xx-only insert + lookup). */
    idempotencyKeys: new IdempotencyKeysRepo(db),
    llmAuditEvents: new AppendOnlyRepository(db, 'llm_audit_events', {
      resourceType: 'llm_audit_event',
    }),

    // queue + decepticon + observations
    jobs: new MutableRepository(db, 'jobs', mutable('job', opts)),
    decepticonSessions: new MutableRepository(
      db,
      'decepticon_sessions',
      mutable('decepticon_session', opts),
    ),
    observationsBrowser: new MutableRepository(
      db,
      'observations_browser',
      mutable('observation_browser', opts),
    ),

    // findings pipeline
    candidateFindings: new MutableRepository(
      db,
      'candidate_findings',
      mutable('candidate_finding', opts),
    ),
    findings: new MutableRepository(db, 'findings', mutable('finding', opts)),

    // reports
    reports: new MutableRepository(db, 'reports', mutable('report', opts)),
  });

export type Repositories = ReturnType<typeof buildRepositories>;
