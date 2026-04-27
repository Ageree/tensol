// Per-aggregate repositories. Thin wrappers over AppendOnlyRepository /
// MutableRepository so call sites get a typed handle without restating
// table name / resource type / versioned flag.
//
// Sprint 2: 17 aggregates. Append-only set: assessment_artifacts,
// finding_evidence, audit_events, llm_audit_events.

import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';
import { AppendOnlyRepository } from './append-only.ts';
import { type CrossTenantAttempt, MutableRepository } from './mutable.ts';

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

    // domain core
    projects: new MutableRepository(db, 'projects', mutable('project', opts)),
    targets: new MutableRepository(db, 'targets', versioned('target', opts)),
    assessments: new MutableRepository(db, 'assessments', versioned('assessment', opts)),
    assessmentScopeRules: new MutableRepository(
      db,
      'assessment_scope_rules',
      versioned('assessment_scope_rule', opts),
    ),

    // append-only
    assessmentArtifacts: new AppendOnlyRepository(db, 'assessment_artifacts', {
      resourceType: 'assessment_artifact',
    }),
    findingEvidence: new AppendOnlyRepository(db, 'finding_evidence', {
      resourceType: 'finding_evidence',
    }),
    auditEvents: new AppendOnlyRepository(db, 'audit_events', {
      resourceType: 'audit_event',
    }),
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
