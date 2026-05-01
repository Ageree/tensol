import { describe, expect, test } from 'bun:test';
import { ACTIONS } from './actions.ts';
import { buildKey } from './decision.ts';
import { RBAC_MATRIX } from './matrix.ts';
import { RESOURCES } from './resources.ts';
import { ROLES } from './roles.ts';

describe('packages/authz :: RBAC_MATRIX shape (S23 all-allow)', () => {
  test('cardinality is exactly 7 × 15 × 15 = 1575 entries', () => {
    expect(RBAC_MATRIX.size).toBe(1575);
    expect(ROLES.length * RESOURCES.length * ACTIONS.length).toBe(1575);
  });

  test('every cell has allowed=true (all-allow admin policy)', () => {
    let allows = 0;
    for (const d of RBAC_MATRIX.values()) if (d.allowed) allows++;
    expect(allows).toBe(1575);
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
    const sample = RBAC_MATRIX.get(buildKey('security_lead', 'assessment', 'start'));
    expect(sample).toBeDefined();
    if (!sample) return;
    expect(typeof sample.allowed).toBe('boolean');
    expect(typeof sample.reason).toBe('string');
    expect(sample.reason.length).toBeGreaterThan(0);
    expect(typeof sample.matchedRuleKey).toBe('string');
    expect(Object.keys(sample).sort()).toEqual(['allowed', 'matchedRuleKey', 'reason']);
  });
});

describe('packages/authz :: C12 matrix is purely role-based (no tenancy in keys)', () => {
  test('every key matches `${role}:${resource}:${action}` shape', () => {
    const keyPattern = /^[a-z_]+:[a-z_]+:[a-z_]+$/;
    for (const key of RBAC_MATRIX.keys()) {
      expect(key).toMatch(keyPattern);
      const parts = key.split(':');
      expect(parts).toHaveLength(3);
      const [role, resource, action] = parts;
      expect((ROLES as ReadonlyArray<string>).includes(role ?? '')).toBe(true);
      expect((RESOURCES as ReadonlyArray<string>).includes(resource ?? '')).toBe(true);
      expect((ACTIONS as ReadonlyArray<string>).includes(action ?? '')).toBe(true);
    }
  });
});

describe('packages/authz :: matrix entries are typed as Role × Resource × Action', () => {
  test('every key uses a known Role, Resource, Action triple', () => {
    const validRoles: ReadonlySet<string> = new Set(ROLES);
    const validResources: ReadonlySet<string> = new Set(RESOURCES);
    const validActions: ReadonlySet<string> = new Set(ACTIONS);

    for (const key of RBAC_MATRIX.keys()) {
      const [role, resource, action] = key.split(':');
      expect(validRoles.has(role ?? '')).toBe(true);
      expect(validResources.has(resource ?? '')).toBe(true);
      expect(validActions.has(action ?? '')).toBe(true);
    }
  });
});
