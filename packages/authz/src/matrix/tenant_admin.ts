// Sprint 3 contract C8/§4.2 — tenant_admin RBAC spec.
//
// tenant_admin runs the tenant: manages users WITHIN the tenant, configures
// the tool_policy for the tenant, and oversees projects/targets. Cannot
// touch the platform skill catalog or platform tool_catalog (those are
// platform_admin only). Cannot create tenants (platform-scope).

import type { Decision } from '../decision.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const SPEC: RoleSpec = {
  tenant: ['read'],
  user: ['read', 'list', 'create', 'update', 'delete'],

  project: ['read', 'list', 'create', 'update', 'delete'],
  target: ['read', 'list', 'create', 'update', 'delete'],

  assessment: [
    'read',
    'list',
    'create',
    'update',
    'delete',
    'submit',
    'approve',
    'start',
    'pause',
    'resume',
    'cancel',
    'change_status',
    // Sprint 6 A-SE-RBAC-1.
    'scope_validate',
  ],
  scope_rule: ['read', 'list', 'create', 'update', 'delete', 'change_scope'],
  tool_policy: ['read', 'list', 'create', 'update', 'delete', 'change_tool_policy'],

  finding: ['read', 'list', 'change_status'],
  evidence: ['read', 'list'],
  report: ['read', 'list', 'create'],
  audit_log: ['read', 'list'],

  // Platform catalogs — read-only for tenant admins (browsing).
  skill: ['read', 'list'],
  tool_catalog: ['read', 'list'],

  // Sprint 16 B19 — tenant_admin manages credential lifecycle within their tenant.
  target_credential: ['read', 'list', 'create', 'delete'],
};

export const tenantAdminMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'tenant_admin',
  SPEC,
  'tenant_admin: full control within tenant',
  'tenant_admin: action not granted by spec',
);
