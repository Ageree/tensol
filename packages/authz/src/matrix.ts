// Sprint 3 contract C8/C9 — composes the 7 per-role decision maps into a
// single frozen `RBAC_MATRIX` indexed by `${role}:${resource}:${action}`.
//
// Cardinality (asserted in matrix.test.ts):
//   7 roles × 13 resources × 14 actions = 1274 entries.
//
// Every Decision object is `Object.isFrozen` — verified per-role in spec.ts
// and re-verified in the matrix-shape test.
//
// `RBAC_MATRIX` is built once at module load and exposed as a `ReadonlyMap`.
// The internal Map is referenced by `assertCan` for O(1) lookup.

import type { Action } from './actions.ts';
import { type Decision, type RoleResourceActionKey, buildKey } from './decision.ts';
import { auditorMatrix } from './matrix/auditor.ts';
import { developerMatrix } from './matrix/developer.ts';
import { operatorMatrix } from './matrix/operator.ts';
import { platformAdminMatrix } from './matrix/platform_admin.ts';
import { securityLeadMatrix } from './matrix/security_lead.ts';
import { tenantAdminMatrix } from './matrix/tenant_admin.ts';
import { viewerMatrix } from './matrix/viewer.ts';
import type { Resource } from './resources.ts';
import type { Role } from './roles.ts';

const ROLE_MAPS: ReadonlyArray<ReadonlyMap<string, Decision>> = [
  platformAdminMatrix,
  tenantAdminMatrix,
  securityLeadMatrix,
  operatorMatrix,
  developerMatrix,
  auditorMatrix,
  viewerMatrix,
];

const composed = new Map<string, Decision>();
for (const roleMap of ROLE_MAPS) {
  for (const [key, decision] of roleMap) {
    composed.set(key, decision);
  }
}

export const RBAC_MATRIX: ReadonlyMap<RoleResourceActionKey, Decision> = composed as ReadonlyMap<
  RoleResourceActionKey,
  Decision
>;

/**
 * Look up the static decision for (role, resource, action). Returns
 * `undefined` ONLY if the matrix is malformed (cardinality < 1274), which
 * matrix.test.ts rules out. The runtime callers (assertCan) treat
 * `undefined` as deny-with-context for defence-in-depth.
 */
export const lookupDecision = (
  role: Role,
  resource: Resource,
  action: Action,
): Decision | undefined => RBAC_MATRIX.get(buildKey(role, resource, action));
