// Sprint 3 contract C8/§4.2 — security_lead RBAC spec.
//
// security_lead approves and operates assessments — the core "running a pentest"
// role. Owns scope and tool_policy edits for assessments. Reviews findings
// and approves/triages. No user management, no platform catalog mutations.

import type { Decision } from '../decision.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const SPEC: RoleSpec = {
  tenant: ['read'],
  user: ['read', 'list'],

  project: ['read', 'list', 'create', 'update'],
  target: ['read', 'list', 'create', 'update'],

  // Sprint 5 A-RBAC-1: `approve` granted ONLY to tenant_admin.
  // Sprint 5 contract: security_lead retains the rest of the lifecycle
  // (submit/start/pause/resume/cancel) and the change_status sentinel.
  assessment: [
    'read',
    'list',
    'create',
    'update',
    'submit',
    'start',
    'pause',
    'resume',
    'cancel',
    'change_status',
    // Sprint 6 A-SE-RBAC-1.
    'scope_validate',
  ],
  scope_rule: ['read', 'list', 'create', 'update', 'delete', 'change_scope'],
  tool_policy: ['read', 'list', 'change_tool_policy'],

  finding: ['read', 'list', 'create', 'update', 'change_status', 'approve'],
  evidence: ['read', 'list', 'create'],
  report: ['read', 'list', 'create', 'update'],
  // Sprint 4 A15b — audit_log access restricted to auditor + tenant_admin only.
  audit_log: [],

  skill: ['read', 'list'],
  tool_catalog: ['read', 'list'],

  // Sprint 16 B19 — security_lead can create and view credentials for assessments they run.
  target_credential: ['read', 'list', 'create'],
};

export const securityLeadMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'security_lead',
  SPEC,
  'security_lead: assessment lifecycle + scope/tool_policy + finding triage',
  'security_lead: action not granted by spec',
);
