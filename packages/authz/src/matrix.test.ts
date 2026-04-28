import { describe, expect, test } from 'bun:test';
import { ACTIONS, type Action } from './actions.ts';
import { buildKey } from './decision.ts';
import { RBAC_MATRIX } from './matrix.ts';
import { RESOURCES, type Resource } from './resources.ts';
import { ROLES, type Role } from './roles.ts';

describe('packages/authz :: RBAC_MATRIX shape (C8)', () => {
  test('cardinality is exactly 7 × 13 × 14 = 1274 entries', () => {
    expect(RBAC_MATRIX.size).toBe(1274);
    expect(ROLES.length * RESOURCES.length * ACTIONS.length).toBe(1274);
  });

  test('every (role, resource, action) cell is present', () => {
    for (const role of ROLES) {
      for (const resource of RESOURCES) {
        for (const action of ACTIONS) {
          const key = buildKey(role, resource, action);
          const decision = RBAC_MATRIX.get(key);
          expect(decision).toBeDefined();
          expect(decision?.matchedRuleKey).toBe(key);
        }
      }
    }
  });

  test('every Decision is Object.isFrozen', () => {
    for (const decision of RBAC_MATRIX.values()) {
      expect(Object.isFrozen(decision)).toBe(true);
    }
  });

  test('Decision shape is {allowed, reason, matchedRuleKey} only', () => {
    const sample = RBAC_MATRIX.get(buildKey('platform_admin', 'tenant', 'read'));
    expect(sample).toBeDefined();
    if (!sample) return;
    expect(typeof sample.allowed).toBe('boolean');
    expect(typeof sample.reason).toBe('string');
    expect(sample.reason.length).toBeGreaterThan(0);
    expect(typeof sample.matchedRuleKey).toBe('string');
    expect(Object.keys(sample).sort()).toEqual(['allowed', 'matchedRuleKey', 'reason']);
  });
});

describe('packages/authz :: C10 auditor read-only invariant', () => {
  test('auditor: read+list allowed on every resource', () => {
    for (const resource of RESOURCES) {
      const readKey = buildKey('auditor', resource, 'read');
      const listKey = buildKey('auditor', resource, 'list');
      expect(RBAC_MATRIX.get(readKey)?.allowed).toBe(true);
      expect(RBAC_MATRIX.get(listKey)?.allowed).toBe(true);
    }
  });

  test('auditor: every non-read/list action denied across every resource', () => {
    const nonReadActions = ACTIONS.filter((a): a is Action => a !== 'read' && a !== 'list');
    for (const resource of RESOURCES) {
      for (const action of nonReadActions) {
        const key = buildKey('auditor', resource, action);
        const decision = RBAC_MATRIX.get(key);
        expect(decision?.allowed).toBe(false);
      }
    }
  });
});

describe('packages/authz :: C11 developer scope-policy invariant', () => {
  test('developer: change_scope denied on every resource', () => {
    for (const resource of RESOURCES) {
      const key = buildKey('developer', resource, 'change_scope');
      expect(RBAC_MATRIX.get(key)?.allowed).toBe(false);
    }
  });

  test('developer: change_tool_policy denied on every resource', () => {
    for (const resource of RESOURCES) {
      const key = buildKey('developer', resource, 'change_tool_policy');
      expect(RBAC_MATRIX.get(key)?.allowed).toBe(false);
    }
  });
});

describe('packages/authz :: C12 matrix is purely role-based (no tenancy in keys)', () => {
  test('every key matches `${role}:${resource}:${action}` shape', () => {
    const keyPattern = /^[a-z_]+:[a-z_]+:[a-z_]+$/;
    for (const key of RBAC_MATRIX.keys()) {
      expect(key).toMatch(keyPattern);
      // Exactly two colons — the format MUST NOT contain tenant IDs.
      const parts = key.split(':');
      expect(parts).toHaveLength(3);
      const [role, resource, action] = parts;
      expect((ROLES as ReadonlyArray<string>).includes(role ?? '')).toBe(true);
      expect((RESOURCES as ReadonlyArray<string>).includes(resource ?? '')).toBe(true);
      expect((ACTIONS as ReadonlyArray<string>).includes(action ?? '')).toBe(true);
    }
  });
});

describe('packages/authz :: representative role checks', () => {
  test('platform_admin: full mutation on tenant + user + skill + tool_catalog', () => {
    const platformResources: ReadonlyArray<Resource> = ['tenant', 'user', 'skill', 'tool_catalog'];
    const fullSet: ReadonlyArray<Action> = ['read', 'list', 'create', 'update', 'delete'];
    for (const r of platformResources) {
      for (const a of fullSet) {
        expect(RBAC_MATRIX.get(buildKey('platform_admin', r, a))?.allowed).toBe(true);
      }
    }
  });

  test('platform_admin: cannot mutate tenant-scoped business resources directly', () => {
    expect(RBAC_MATRIX.get(buildKey('platform_admin', 'project', 'create'))?.allowed).toBe(false);
    expect(RBAC_MATRIX.get(buildKey('platform_admin', 'assessment', 'approve'))?.allowed).toBe(
      false,
    );
  });

  test('tenant_admin: full user CRUD within tenant', () => {
    for (const a of ['create', 'update', 'delete'] as const) {
      expect(RBAC_MATRIX.get(buildKey('tenant_admin', 'user', a))?.allowed).toBe(true);
    }
  });

  test('tenant_admin: cannot create tenants (platform-scope)', () => {
    expect(RBAC_MATRIX.get(buildKey('tenant_admin', 'tenant', 'create'))?.allowed).toBe(false);
    expect(RBAC_MATRIX.get(buildKey('tenant_admin', 'tenant', 'delete'))?.allowed).toBe(false);
  });

  test('security_lead: full assessment lifecycle', () => {
    const lifecycle: ReadonlyArray<Action> = [
      'submit',
      'approve',
      'start',
      'pause',
      'resume',
      'cancel',
    ];
    for (const a of lifecycle) {
      expect(RBAC_MATRIX.get(buildKey('security_lead', 'assessment', a))?.allowed).toBe(true);
    }
  });

  test('security_lead: change_scope + change_tool_policy allowed (own role concerns)', () => {
    const scopeKey = buildKey('security_lead', 'scope_rule', 'change_scope');
    const toolKey = buildKey('security_lead', 'tool_policy', 'change_tool_policy');
    expect(RBAC_MATRIX.get(scopeKey)?.allowed).toBe(true);
    expect(RBAC_MATRIX.get(toolKey)?.allowed).toBe(true);
  });

  test('operator: cannot approve assessments (security_lead approval gate)', () => {
    expect(RBAC_MATRIX.get(buildKey('operator', 'assessment', 'approve'))?.allowed).toBe(false);
  });

  test('operator: can submit assessments + draft', () => {
    expect(RBAC_MATRIX.get(buildKey('operator', 'assessment', 'submit'))?.allowed).toBe(true);
    expect(RBAC_MATRIX.get(buildKey('operator', 'assessment', 'create'))?.allowed).toBe(true);
  });

  test('viewer: no mutation anywhere', () => {
    const mutations: ReadonlyArray<Action> = [
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
    for (const resource of RESOURCES) {
      for (const a of mutations) {
        expect(RBAC_MATRIX.get(buildKey('viewer', resource, a))?.allowed).toBe(false);
      }
    }
  });

  test('viewer: read|list on user-facing business resources', () => {
    const userFacing: ReadonlyArray<Resource> = [
      'project',
      'target',
      'assessment',
      'finding',
      'evidence',
      'report',
    ];
    for (const r of userFacing) {
      expect(RBAC_MATRIX.get(buildKey('viewer', r, 'read'))?.allowed).toBe(true);
      expect(RBAC_MATRIX.get(buildKey('viewer', r, 'list'))?.allowed).toBe(true);
    }
  });

  test('viewer: no access to platform tables (skill, tool_catalog) or audit_log', () => {
    for (const r of ['skill', 'tool_catalog', 'audit_log'] as const) {
      expect(RBAC_MATRIX.get(buildKey('viewer', r, 'read'))?.allowed).toBe(false);
      expect(RBAC_MATRIX.get(buildKey('viewer', r, 'list'))?.allowed).toBe(false);
    }
  });
});

describe('packages/authz :: A15b — audit_log restricted to auditor + tenant_admin only', () => {
  // Sprint 4 contract A15b: only `auditor` and `tenant_admin` may read|list
  // `audit_log`; every other role is denied. Cardinality stays at 1274 — this
  // is a decision flip, not a cell add/remove.
  test('auditor + tenant_admin: read|list on audit_log allowed', () => {
    for (const role of ['auditor', 'tenant_admin'] as const) {
      expect(RBAC_MATRIX.get(buildKey(role, 'audit_log', 'read'))?.allowed).toBe(true);
      expect(RBAC_MATRIX.get(buildKey(role, 'audit_log', 'list'))?.allowed).toBe(true);
    }
  });

  test('platform_admin / security_lead / operator / developer / viewer: every audit_log action denied', () => {
    const restrictedRoles = [
      'platform_admin',
      'security_lead',
      'operator',
      'developer',
      'viewer',
    ] as const;
    for (const role of restrictedRoles) {
      for (const action of ACTIONS) {
        const decision = RBAC_MATRIX.get(buildKey(role, 'audit_log', action));
        expect(decision?.allowed).toBe(false);
      }
    }
  });
});

describe('packages/authz :: matrix entries are typed as Role × Resource × Action', () => {
  test('every key uses a known Role, Resource, Action triple', () => {
    const validRoles: ReadonlySet<string> = new Set<Role>(ROLES);
    const validResources: ReadonlySet<string> = new Set<Resource>(RESOURCES);
    const validActions: ReadonlySet<string> = new Set<Action>(ACTIONS);

    for (const key of RBAC_MATRIX.keys()) {
      const [role, resource, action] = key.split(':');
      expect(validRoles.has(role ?? '')).toBe(true);
      expect(validResources.has(resource ?? '')).toBe(true);
      expect(validActions.has(action ?? '')).toBe(true);
    }
  });
});
