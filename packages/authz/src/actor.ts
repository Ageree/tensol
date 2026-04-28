// Sprint 3 contract — Actor type used by middleware to attach the
// authenticated principal to every request context (Hono c.set('actor', ...)).
//
// IMPORTANT (C12): tenant identity is on the Actor for tenancy middleware
// to read; assertCan does NOT receive tenantId — RBAC is purely role-driven.

import type { Role } from './roles.ts';

export interface UserActor {
  readonly type: 'user';
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly tenantId: string;
}

export interface ServiceActor {
  readonly type: 'service';
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly tenantId: string;
}

export type Actor = UserActor | ServiceActor;
