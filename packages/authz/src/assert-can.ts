// Sprint 3 contract C9/C12 — pure RBAC enforcement.
//
// `assertCan` looks up (actor.role, resource, action) in the static matrix
// and returns the Decision. It is a PURE function — no I/O, no side effects,
// no tenancy logic (C12: tenancy is middleware's job, not the matrix's).
//
// Sprint 4 will wire `audit-hook` middleware to call this and emit denials
// to `audit_events`. For now, the function is the deterministic source of
// truth for "can this role take this action on this resource type?".

import type { Action } from './actions.ts';
import type { Actor } from './actor.ts';
import { type Decision, buildKey } from './decision.ts';
import { RBAC_MATRIX } from './matrix.ts';
import type { Resource } from './resources.ts';

export const assertCan = (actor: Actor, action: Action, resource: Resource): Decision => {
  const key = buildKey(actor.role, resource, action);
  const decision = RBAC_MATRIX.get(key);
  if (decision) return decision;

  // Defence-in-depth: matrix.test.ts asserts cardinality 1274, so this
  // branch is unreachable in production. We deny-with-context anyway so a
  // future code-review-induced regression fails closed.
  return Object.freeze({
    allowed: false,
    reason: 'matrix lookup miss (defence-in-depth deny)',
    matchedRuleKey: key,
  });
};
