// rbac-matrix-e2e.test.ts — Sprint 3 C8-C12.
//
// E2E spot-checks of the static RBAC matrix: representative cells across each
// of the 7 roles and a handful of high-impact (resource, action) pairs. The
// 1274-cell exhaustive matrix is unit-tested in packages/authz; this file
// asserts the same decisions survive across the workspace boundary by
// importing the public API.

import { describe, expect, test } from 'bun:test';
import { type Action, type Resource, type Role, assertCan } from '@cyberstrike/authz';

const actorFor = (role: Role) => ({
  type: 'user' as const,
  id: 'u1',
  email: 'u@x',
  displayName: 'u',
  role,
  tenantId: 't1',
});

interface Cell {
  readonly role: Role;
  readonly action: Action;
  readonly resource: Resource;
  readonly allowed: boolean;
}

// Representative subset — one cell per role focused on the highest-impact
// action for that role's typical workload.
const CELLS: ReadonlyArray<Cell> = [
  { role: 'platform_admin', action: 'create', resource: 'tenant', allowed: true },
  { role: 'tenant_admin', action: 'create', resource: 'tenant', allowed: false },
  { role: 'tenant_admin', action: 'change_tool_policy', resource: 'tool_policy', allowed: true },
  // Sprint 5 A-RBAC-1: approve flipped to tenant_admin only.
  { role: 'security_lead', action: 'approve', resource: 'assessment', allowed: false },
  { role: 'tenant_admin', action: 'approve', resource: 'assessment', allowed: true },
  // Sprint 5 A-RBAC-1: operator no longer creates/submits — runs lifecycle.
  { role: 'operator', action: 'submit', resource: 'assessment', allowed: false },
  { role: 'operator', action: 'start', resource: 'assessment', allowed: true },
  { role: 'operator', action: 'change_scope', resource: 'scope_rule', allowed: false },
  { role: 'developer', action: 'change_scope', resource: 'scope_rule', allowed: false },
  { role: 'developer', action: 'change_tool_policy', resource: 'tool_policy', allowed: false },
  { role: 'auditor', action: 'read', resource: 'audit_log', allowed: true },
  { role: 'auditor', action: 'create', resource: 'project', allowed: false },
  { role: 'viewer', action: 'read', resource: 'finding', allowed: true },
  { role: 'viewer', action: 'update', resource: 'finding', allowed: false },
];

describe('integration :: RBAC matrix e2e (C8-C12)', () => {
  for (const cell of CELLS) {
    test(`${cell.role} ${cell.action} ${cell.resource} → ${cell.allowed ? 'allow' : 'deny'}`, () => {
      const decision = assertCan(actorFor(cell.role), cell.action, cell.resource);
      expect(decision.allowed).toBe(cell.allowed);
    });
  }

  test('auditor read-only invariant (C10): only read|list ever allowed', () => {
    const ALL_ACTIONS: Action[] = [
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
      'change_scope',
      'change_tool_policy',
    ];
    const ALL_RESOURCES: Resource[] = [
      'tenant',
      'user',
      'project',
      'target',
      'assessment',
      'scope_rule',
      'tool_policy',
      'finding',
      'evidence',
      'report',
      'audit_log',
      'skill',
      'tool_catalog',
    ];
    for (const r of ALL_RESOURCES) {
      for (const a of ALL_ACTIONS) {
        const decision = assertCan(actorFor('auditor'), a, r);
        if (decision.allowed) {
          expect(['read', 'list']).toContain(a);
        }
      }
    }
  });

  test('developer scope/tool-policy invariant (C11): always denied', () => {
    const ALL_RESOURCES: Resource[] = [
      'tenant',
      'user',
      'project',
      'target',
      'assessment',
      'scope_rule',
      'tool_policy',
      'finding',
      'evidence',
      'report',
      'audit_log',
      'skill',
      'tool_catalog',
    ];
    for (const r of ALL_RESOURCES) {
      expect(assertCan(actorFor('developer'), 'change_scope', r).allowed).toBe(false);
      expect(assertCan(actorFor('developer'), 'change_tool_policy', r).allowed).toBe(false);
    }
  });
});
