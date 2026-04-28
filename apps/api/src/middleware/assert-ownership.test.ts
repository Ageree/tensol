import { describe, expect, test } from 'bun:test';
import { RbacDenyError } from '@cyberstrike/authz';
import { assertOwnership } from './assert-ownership.ts';

describe('apps/api :: assertOwnership (C18 R6)', () => {
  test('returns void on tenant match', () => {
    expect(() =>
      assertOwnership('00000000-0000-0000-0000-0000000000aa', {
        resourceType: 'project',
        resourceId: '00000000-0000-0000-0000-000000000001',
        resourceTenantId: '00000000-0000-0000-0000-0000000000aa',
      }),
    ).not.toThrow();
  });

  test('throws structured RbacDenyError on cross-tenant', () => {
    try {
      assertOwnership('00000000-0000-0000-0000-0000000000aa', {
        resourceType: 'project',
        resourceId: '00000000-0000-0000-0000-000000000001',
        resourceTenantId: '00000000-0000-0000-0000-0000000000bb',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RbacDenyError);
      const err = e as RbacDenyError;
      expect(err.actorTenantId).toBe('00000000-0000-0000-0000-0000000000aa');
      expect(err.attemptedResourceType).toBe('project');
      expect(err.attemptedResourceId).toBe('00000000-0000-0000-0000-000000000001');
      expect(err.reason).toBe('cross-tenant access');
    }
  });

  test('error.message does not leak resource UUIDs', () => {
    try {
      assertOwnership('aaa', {
        resourceType: 'finding',
        resourceId: '00000000-0000-0000-0000-000000000abc',
        resourceTenantId: 'bbb',
      });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('00000000-0000-0000-0000-000000000abc');
      expect(msg).not.toContain('aaa');
      expect(msg).not.toContain('bbb');
    }
  });
});
