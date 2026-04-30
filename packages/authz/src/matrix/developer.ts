// Sprint 3 contract C8/§4.2 + C11 — developer RBAC spec.
//
// developer represents the customer-side engineer: read access to the
// findings landed against their codebase, the ability to add evidence
// (e.g. attach a fix link), and read access to projects/targets/assessments
// for context. EXPLICITLY denied `change_scope` and `change_tool_policy`
// for ALL resources (C11 invariant — asserted in matrix.test.ts).

import type { Decision } from '../decision.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const SPEC: RoleSpec = {
  tenant: ['read'],
  user: ['read'],

  project: ['read', 'list'],
  target: ['read', 'list'],
  assessment: ['read', 'list'],

  // Critical C11 invariant: NO change_scope, NO change_tool_policy.
  scope_rule: ['read', 'list'],
  tool_policy: ['read', 'list'],

  finding: ['read', 'list', 'update', 'change_status'],
  evidence: ['read', 'list', 'create'],
  report: ['read', 'list'],
  audit_log: [],

  skill: ['read', 'list'],
  tool_catalog: ['read', 'list'],

  // Sprint 16 B19 — developer can view credentials but not create them.
  target_credential: ['read', 'list'],
};

export const developerMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'developer',
  SPEC,
  'developer: read findings, attach evidence; no scope or tool_policy mutation',
  'developer: action not granted by spec',
);
