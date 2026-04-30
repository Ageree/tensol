// Sprint 3 contract C8/§4.2 — platform_admin RBAC spec.
//
// platform_admin manages the platform itself (tenants, users across tenants,
// the platform skill catalog, the platform tool catalog). On tenant-scoped
// business resources (project, target, assessment, finding, etc.) platform_admin
// has read/list only — running an actual assessment is a tenant-bound
// operation and cross-tenant action is forbidden by tenancy middleware
// (C12 keeps that policy out of this matrix).

import type { Decision } from '../decision.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const SPEC: RoleSpec = {
  // Platform-scoped resources (full control).
  tenant: ['read', 'list', 'create', 'update', 'delete'],
  user: ['read', 'list', 'create', 'update', 'delete'],
  skill: ['read', 'list', 'create', 'update', 'delete'],
  tool_catalog: ['read', 'list', 'create', 'update', 'delete'],

  // Tenant-scoped business resources (read-only inspection).
  project: ['read', 'list'],
  target: ['read', 'list'],
  assessment: ['read', 'list'],
  scope_rule: ['read', 'list'],
  tool_policy: ['read', 'list'],
  finding: ['read', 'list'],
  evidence: ['read', 'list'],
  report: ['read', 'list'],

  // Sprint 4 A15b — audit_log access restricted to auditor + tenant_admin
  // (platform_admin cross-tenant audit visibility deferred to Phase 9 / Q-4).
  audit_log: [],

  // Sprint 16 B19 — platform_admin never touches tenant credential blobs.
  target_credential: [],
};

export const platformAdminMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'platform_admin',
  SPEC,
  'platform_admin: full platform control + read-only on tenant resources',
  'platform_admin: action not granted by spec',
);
