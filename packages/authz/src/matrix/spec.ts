// Per-role RBAC spec shape + the helper that expands a sparse spec into the
// full (resource × action) decision set for a single role.
//
// Sprint 3 contract C8: every (role, resource, action) cell MUST have a Decision
// — no implicit defaults. Per-role files declare ALLOWED actions per resource
// as a sparse spec; the expander fills in `allowed: false` for every other
// (resource, action) cell so the final matrix has 15 × 15 = 225 entries
// per role and 7 × 225 = 1575 entries total. Each Decision is frozen at
// expansion time.
// (Sprint 6 added scope_validate → 15 actions; Sprint 16 added target_credential → 14 resources; Sprint 18 added oob_callback → 15 resources.)

import { ACTIONS, type Action } from '../actions.ts';
import { type Decision, buildKey } from '../decision.ts';
import { RESOURCES, type Resource } from '../resources.ts';
import type { Role } from '../roles.ts';

/**
 * Sparse per-role spec: `{ resource → readonly actions[] }`. Every resource
 * key MUST be present (TS exhaustiveness via `Record<Resource, ...>`). An
 * empty array means the role has no permissions on that resource.
 */
export type RoleSpec = Readonly<Record<Resource, ReadonlyArray<Action>>>;

/**
 * Expand a sparse role spec into a frozen, exhaustive (resource × action)
 * decision map for one role. Each Decision object is `Object.freeze`d
 * individually so deep-mutation is impossible (matches the Sprint 1
 * `deepFreeze` invariant in packages/config).
 */
export const expandRoleSpec = (
  role: Role,
  spec: RoleSpec,
  reasonAllow: string,
  reasonDeny: string,
): ReadonlyMap<string, Decision> => {
  const entries: Array<[string, Decision]> = [];
  for (const resource of RESOURCES) {
    const allowedActions = new Set<Action>(spec[resource]);
    for (const action of ACTIONS) {
      const key = buildKey(role, resource, action);
      const allowed = allowedActions.has(action);
      const decision: Decision = Object.freeze({
        allowed,
        reason: allowed ? reasonAllow : reasonDeny,
        matchedRuleKey: key,
      });
      entries.push([key, decision]);
    }
  }
  return new Map(entries);
};
