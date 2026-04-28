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

  assessment: [
    'read',
    'list',
    'create',
    'update',
    'submit',
    'approve',
    'start',
    'pause',
    'resume',
    'cancel',
    'change_status',
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
};

export const securityLeadMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'security_lead',
  SPEC,
  'security_lead: assessment lifecycle + scope/tool_policy + finding triage',
  'security_lead: action not granted by spec',
);
