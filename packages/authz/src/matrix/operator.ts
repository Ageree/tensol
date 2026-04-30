// Sprint 3 contract C8/§4.2 — operator RBAC spec.
//
// operator drafts assessments, submits for approval (approval gate is
// security_lead's), works findings/evidence. Read-only on scope rules and
// tool_policy — they cannot widen scope or change tool policy.

import type { Decision } from '../decision.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const SPEC: RoleSpec = {
  tenant: ['read'],
  user: ['read', 'list'],

  project: ['read', 'list', 'create', 'update'],
  target: ['read', 'list', 'create', 'update'],

  // Sprint 5 A-RBAC-1: operator runs assessments day-to-day — start/pause/resume/cancel.
  // No create/update/submit (security_lead/tenant_admin author and submit).
  // No approve (tenant_admin only).
  // Sprint 6 A-SE-RBAC-1: operator can run pre-flight scope validation.
  assessment: ['read', 'list', 'start', 'pause', 'resume', 'cancel', 'scope_validate'],
  scope_rule: ['read', 'list'],
  tool_policy: ['read', 'list'],

  finding: ['read', 'list', 'create', 'update', 'change_status'],
  evidence: ['read', 'list', 'create'],
  report: ['read', 'list', 'create'],
  // Sprint 4 A15b — audit_log access restricted to auditor + tenant_admin only.
  audit_log: [],

  skill: ['read', 'list'],
  tool_catalog: ['read', 'list'],

  // Sprint 16 B19 — operator can create and view credentials for targets they work.
  target_credential: ['read', 'list', 'create'],

  // Sprint 18 — operator has no access to OOB callback logs.
  oob_callback: [],
};

export const operatorMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'operator',
  SPEC,
  'operator: assessment authoring + finding triage; no scope or tool_policy mutation',
  'operator: action not granted by spec',
);
