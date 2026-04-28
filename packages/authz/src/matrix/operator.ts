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

  assessment: ['read', 'list', 'create', 'update', 'submit', 'pause', 'resume'],
  scope_rule: ['read', 'list'],
  tool_policy: ['read', 'list'],

  finding: ['read', 'list', 'create', 'update', 'change_status'],
  evidence: ['read', 'list', 'create'],
  report: ['read', 'list', 'create'],
  audit_log: ['read', 'list'],

  skill: ['read', 'list'],
  tool_catalog: ['read', 'list'],
};

export const operatorMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'operator',
  SPEC,
  'operator: assessment authoring + finding triage; no scope or tool_policy mutation',
  'operator: action not granted by spec',
);
