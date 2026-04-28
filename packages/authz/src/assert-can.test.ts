import { describe, expect, test } from 'bun:test';
import type { Action } from './actions.ts';
import type { UserActor } from './actor.ts';
import { assertCan } from './assert-can.ts';
import { buildKey } from './decision.ts';
import type { Resource } from './resources.ts';
import type { Role } from './roles.ts';

const makeActor = (role: Role): UserActor => ({
  type: 'user',
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test@example.com',
  displayName: 'Test User',
  role,
  tenantId: '00000000-0000-0000-0000-0000000000aa',
});

describe('packages/authz :: assertCan (C9 — pure role-based)', () => {
  test('returns Decision with required fields populated', () => {
    const decision = assertCan(makeActor('auditor'), 'read', 'finding');
    expect(decision.allowed).toBe(true);
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.matchedRuleKey).toBe(buildKey('auditor', 'finding', 'read'));
  });

  test('Decision is frozen (no mutation)', () => {
    const decision = assertCan(makeActor('viewer'), 'read', 'project');
    expect(Object.isFrozen(decision)).toBe(true);
  });

  test('deterministic — repeated calls return identical decisions', () => {
    const a = assertCan(makeActor('developer'), 'read', 'finding');
    const b = assertCan(makeActor('developer'), 'read', 'finding');
    expect(a).toBe(b);
  });

  test('C12: assertCan does not receive tenantId; behaviour identical regardless of actor.tenantId', () => {
    const t1: UserActor = { ...makeActor('operator'), tenantId: 'tenant-A' };
    const t2: UserActor = { ...makeActor('operator'), tenantId: 'tenant-B' };
    const a = assertCan(t1, 'submit', 'assessment');
    const b = assertCan(t2, 'submit', 'assessment');
    expect(a.allowed).toBe(b.allowed);
    expect(a.matchedRuleKey).toBe(b.matchedRuleKey);
  });
});

describe('packages/authz :: assertCan deterministic-output matrix (C9 — 50+ cases)', () => {
  // 50 representative (role, resource, action) cases; expected outcome
  // is computed by re-implementing the spec semantics in the test as a
  // cross-check (test doubles the truth-source).
  const cases: ReadonlyArray<{
    role: Role;
    action: Action;
    resource: Resource;
    expected: boolean;
  }> = [
    // platform_admin
    { role: 'platform_admin', action: 'create', resource: 'tenant', expected: true },
    { role: 'platform_admin', action: 'delete', resource: 'tenant', expected: true },
    { role: 'platform_admin', action: 'create', resource: 'user', expected: true },
    { role: 'platform_admin', action: 'create', resource: 'skill', expected: true },
    { role: 'platform_admin', action: 'create', resource: 'tool_catalog', expected: true },
    { role: 'platform_admin', action: 'read', resource: 'project', expected: true },
    { role: 'platform_admin', action: 'create', resource: 'project', expected: false },
    { role: 'platform_admin', action: 'approve', resource: 'assessment', expected: false },
    // tenant_admin
    { role: 'tenant_admin', action: 'create', resource: 'user', expected: true },
    { role: 'tenant_admin', action: 'delete', resource: 'user', expected: true },
    { role: 'tenant_admin', action: 'create', resource: 'tenant', expected: false },
    { role: 'tenant_admin', action: 'create', resource: 'project', expected: true },
    { role: 'tenant_admin', action: 'change_tool_policy', resource: 'tool_policy', expected: true },
    { role: 'tenant_admin', action: 'change_scope', resource: 'scope_rule', expected: true },
    { role: 'tenant_admin', action: 'create', resource: 'skill', expected: false },
    // security_lead — Sprint 5 A-RBAC-1: approve flipped to tenant_admin only.
    { role: 'security_lead', action: 'submit', resource: 'assessment', expected: true },
    { role: 'security_lead', action: 'approve', resource: 'assessment', expected: false },
    { role: 'security_lead', action: 'start', resource: 'assessment', expected: true },
    { role: 'security_lead', action: 'pause', resource: 'assessment', expected: true },
    { role: 'security_lead', action: 'resume', resource: 'assessment', expected: true },
    { role: 'security_lead', action: 'cancel', resource: 'assessment', expected: true },
    { role: 'security_lead', action: 'change_scope', resource: 'scope_rule', expected: true },
    {
      role: 'security_lead',
      action: 'change_tool_policy',
      resource: 'tool_policy',
      expected: true,
    },
    { role: 'security_lead', action: 'create', resource: 'user', expected: false },
    { role: 'security_lead', action: 'delete', resource: 'tenant', expected: false },
    // operator — Sprint 5 A-RBAC-1: r,l,start,pause,resume,cancel only.
    { role: 'operator', action: 'create', resource: 'assessment', expected: false },
    { role: 'operator', action: 'submit', resource: 'assessment', expected: false },
    { role: 'operator', action: 'approve', resource: 'assessment', expected: false },
    { role: 'operator', action: 'start', resource: 'assessment', expected: true },
    { role: 'operator', action: 'cancel', resource: 'assessment', expected: true },
    // tenant_admin — Sprint 5 A-RBAC-1: full assessment lifecycle including approve.
    { role: 'tenant_admin', action: 'submit', resource: 'assessment', expected: true },
    { role: 'tenant_admin', action: 'approve', resource: 'assessment', expected: true },
    { role: 'tenant_admin', action: 'start', resource: 'assessment', expected: true },
    { role: 'tenant_admin', action: 'cancel', resource: 'assessment', expected: true },
    { role: 'operator', action: 'change_scope', resource: 'scope_rule', expected: false },
    { role: 'operator', action: 'change_tool_policy', resource: 'tool_policy', expected: false },
    { role: 'operator', action: 'create', resource: 'finding', expected: true },
    { role: 'operator', action: 'create', resource: 'evidence', expected: true },
    // developer
    { role: 'developer', action: 'read', resource: 'finding', expected: true },
    { role: 'developer', action: 'update', resource: 'finding', expected: true },
    { role: 'developer', action: 'create', resource: 'evidence', expected: true },
    { role: 'developer', action: 'change_scope', resource: 'scope_rule', expected: false },
    { role: 'developer', action: 'change_tool_policy', resource: 'tool_policy', expected: false },
    { role: 'developer', action: 'change_scope', resource: 'project', expected: false },
    { role: 'developer', action: 'change_tool_policy', resource: 'finding', expected: false },
    { role: 'developer', action: 'delete', resource: 'finding', expected: false },
    { role: 'developer', action: 'create', resource: 'project', expected: false },
    // auditor
    { role: 'auditor', action: 'read', resource: 'audit_log', expected: true },
    { role: 'auditor', action: 'list', resource: 'audit_log', expected: true },
    { role: 'auditor', action: 'read', resource: 'tenant', expected: true },
    { role: 'auditor', action: 'create', resource: 'finding', expected: false },
    { role: 'auditor', action: 'update', resource: 'evidence', expected: false },
    { role: 'auditor', action: 'delete', resource: 'audit_log', expected: false },
    // viewer
    { role: 'viewer', action: 'read', resource: 'project', expected: true },
    { role: 'viewer', action: 'list', resource: 'finding', expected: true },
    { role: 'viewer', action: 'create', resource: 'finding', expected: false },
    { role: 'viewer', action: 'read', resource: 'audit_log', expected: false },
    { role: 'viewer', action: 'read', resource: 'tool_catalog', expected: false },
  ];

  test(`covers ${cases.length} representative (role, action, resource) inputs`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
  });

  for (const c of cases) {
    test(`${c.role} ${c.action} ${c.resource} → ${c.expected ? 'allow' : 'deny'}`, () => {
      const decision = assertCan(makeActor(c.role), c.action, c.resource);
      expect(decision.allowed).toBe(c.expected);
      expect(decision.matchedRuleKey).toBe(buildKey(c.role, c.resource, c.action));
    });
  }
});
