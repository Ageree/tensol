import { describe, expect, test } from 'bun:test';
import { MissingTenantContextError, TenantContextMismatchError } from './errors.ts';
import { getAmbientTenantId, resolveTenantId, runInTenant } from './tenant-context.ts';

const T1 = '00000000-0000-0000-0000-00000000000a';
const T2 = '00000000-0000-0000-0000-00000000000b';

describe('runInTenant', () => {
  test('sets ambient tenant inside the callback', () => {
    expect(getAmbientTenantId()).toBeUndefined();
    runInTenant(T1, () => {
      expect(getAmbientTenantId()).toBe(T1);
    });
    expect(getAmbientTenantId()).toBeUndefined();
  });

  test('returns the callback value', () => {
    const out = runInTenant(T1, () => 'ok');
    expect(out).toBe('ok');
  });

  test('rejects empty tenantId', () => {
    expect(() => runInTenant('', () => 1)).toThrow(MissingTenantContextError);
  });

  test('does not leak across siblings', () => {
    runInTenant(T1, () => {
      expect(getAmbientTenantId()).toBe(T1);
    });
    runInTenant(T2, () => {
      expect(getAmbientTenantId()).toBe(T2);
    });
    expect(getAmbientTenantId()).toBeUndefined();
  });

  test('nested runInTenant overrides outer ambient', () => {
    runInTenant(T1, () => {
      expect(getAmbientTenantId()).toBe(T1);
      runInTenant(T2, () => {
        expect(getAmbientTenantId()).toBe(T2);
      });
      expect(getAmbientTenantId()).toBe(T1);
    });
  });
});

describe('resolveTenantId :: precedence (B17/R1)', () => {
  test('explicit only — succeeds, returns explicit', () => {
    expect(resolveTenantId({ explicit: T1 })).toBe(T1);
  });

  test('ambient only — succeeds, returns ambient', () => {
    runInTenant(T1, () => {
      expect(resolveTenantId({})).toBe(T1);
    });
  });

  test('matching explicit + ambient — succeeds', () => {
    runInTenant(T1, () => {
      expect(resolveTenantId({ explicit: T1 })).toBe(T1);
    });
  });

  test('explicit wins over ambient (explicit-precedence — but only when matching)', () => {
    runInTenant(T1, () => {
      expect(resolveTenantId({ explicit: T1 })).toBe(T1);
    });
  });

  test('mismatched explicit vs ambient — throws TenantContextMismatchError', () => {
    runInTenant(T2, () => {
      expect(() => resolveTenantId({ explicit: T1 })).toThrow(TenantContextMismatchError);
    });
  });

  test('mismatch error carries both ids', () => {
    runInTenant(T2, () => {
      try {
        resolveTenantId({ explicit: T1, resourceType: 'project', operation: 'find' });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TenantContextMismatchError);
        const err = e as TenantContextMismatchError;
        expect(err.explicit).toBe(T1);
        expect(err.ambient).toBe(T2);
        expect(err.resourceType).toBe('project');
        expect(err.operation).toBe('find');
      }
    });
  });

  test('neither explicit nor ambient — throws MissingTenantContextError', () => {
    expect(() => resolveTenantId({})).toThrow(MissingTenantContextError);
  });

  test('Missing error carries optional context', () => {
    try {
      resolveTenantId({ resourceType: 'assessment', operation: 'update' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingTenantContextError);
      const err = e as MissingTenantContextError;
      expect(err.resourceType).toBe('assessment');
      expect(err.operation).toBe('update');
    }
  });

  test('empty-string explicit falls through to ambient (treated as undefined)', () => {
    runInTenant(T1, () => {
      // Empty string is falsy; resolver picks ambient.
      expect(resolveTenantId({ explicit: '' })).toBe(T1);
    });
  });
});
