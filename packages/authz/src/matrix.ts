// S23 cleanup: single all-allow admin matrix replaces 7 per-role files.
// Cardinality: 7 roles × 15 resources × 15 actions = 1575 entries.
// All cells allowed=true; role names preserved for DB/fixture compat.

import type { Action } from './actions.ts';
import { type Decision, type RoleResourceActionKey, buildKey } from './decision.ts';
import { adminMatrix } from './matrix/admin.ts';
import type { Resource } from './resources.ts';
import type { Role } from './roles.ts';

export const RBAC_MATRIX: ReadonlyMap<RoleResourceActionKey, Decision> =
  adminMatrix as ReadonlyMap<RoleResourceActionKey, Decision>;

export const lookupDecision = (
  role: Role,
  resource: Resource,
  action: Action,
): Decision | undefined => RBAC_MATRIX.get(buildKey(role, resource, action));
