// Sprint 3 contract C9 — Decision shape returned by assertCan and stored in
// the static RBAC matrix. Pure data; no I/O references, no actor identity,
// no tenant context (tenancy belongs to middleware — C12 invariant).

import type { Action } from './actions.ts';
import type { Resource } from './resources.ts';
import type { Role } from './roles.ts';

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly matchedRuleKey: string;
}

/**
 * Composite key used to look up a Decision in the static RBAC matrix.
 * Format: `${role}:${resource}:${action}`.
 *
 * Exposed as a string (not a branded type) because Map<string, Decision>
 * is the canonical contract shape (§10 risk #4) and downstream callers
 * build keys with `${role}:${resource}:${action}` template literals.
 */
export type RoleResourceActionKey = `${Role}:${Resource}:${Action}`;

export const buildKey = (role: Role, resource: Resource, action: Action): RoleResourceActionKey =>
  `${role}:${resource}:${action}` as const;
