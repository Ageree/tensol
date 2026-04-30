// Sprint 3 contract C8/§4.2 — viewer RBAC spec.
//
// viewer is the most-restricted role: read|list on user-facing business
// resources (project / target / assessment / finding / evidence / report).
// No platform-table access, no audit_log access, no mutation anywhere.

import type { Decision } from '../decision.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const SPEC: RoleSpec = {
  tenant: ['read'],
  user: [],

  project: ['read', 'list'],
  target: ['read', 'list'],
  assessment: ['read', 'list'],

  scope_rule: ['read', 'list'],
  tool_policy: [],

  finding: ['read', 'list'],
  evidence: ['read', 'list'],
  report: ['read', 'list'],
  audit_log: [],

  skill: [],
  tool_catalog: [],

  // Sprint 16 B19 — viewer has no access to credentials.
  target_credential: [],

  // Sprint 18 — viewer has no access to OOB callback logs.
  oob_callback: [],
};

export const viewerMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'viewer',
  SPEC,
  'viewer: read|list on user-facing business resources',
  'viewer: action not granted by spec',
);
