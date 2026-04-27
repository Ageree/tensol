import { describe, expect, test } from 'bun:test';
import {
  AppendOnlyViolationError,
  MissingTenantContextError,
  OptimisticLockError,
  TenantContextMismatchError,
} from './errors.ts';

describe('packages/db :: MissingTenantContextError', () => {
  test('is an Error subclass with named class', () => {
    const e = new MissingTenantContextError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MissingTenantContextError');
  });

  test('default message references runInTenant', () => {
    const e = new MissingTenantContextError();
    expect(e.message).toContain('tenant context required');
    expect(e.message).toContain('runInTenant');
  });

  test('accepts optional resourceType + operation', () => {
    const e = new MissingTenantContextError(undefined, {
      resourceType: 'project',
      operation: 'find',
    });
    expect(e.resourceType).toBe('project');
    expect(e.operation).toBe('find');
  });
});

describe('packages/db :: TenantContextMismatchError', () => {
  test('encodes both tenant ids in the message', () => {
    const e = new TenantContextMismatchError({ explicit: 'T1', ambient: 'T2' });
    expect(e.name).toBe('TenantContextMismatchError');
    expect(e.message).toContain('explicit=T1');
    expect(e.message).toContain('ambient=T2');
  });

  test('exposes structured fields for audit', () => {
    const e = new TenantContextMismatchError({
      explicit: 'T1',
      ambient: 'T2',
      resourceType: 'assessment',
      operation: 'update',
    });
    expect(e.explicit).toBe('T1');
    expect(e.ambient).toBe('T2');
    expect(e.resourceType).toBe('assessment');
    expect(e.operation).toBe('update');
  });
});

describe('packages/db :: OptimisticLockError', () => {
  test('encodes resource + expected version in message', () => {
    const e = new OptimisticLockError({
      resourceType: 'assessment',
      resourceId: 'a1',
      expectedVersion: 3,
    });
    expect(e.name).toBe('OptimisticLockError');
    expect(e.message).toContain('assessment a1');
    expect(e.message).toContain('expected version 3');
  });

  test('exposes structured fields', () => {
    const e = new OptimisticLockError({
      resourceType: 'target',
      resourceId: 't1',
      expectedVersion: 7,
    });
    expect(e.resourceType).toBe('target');
    expect(e.resourceId).toBe('t1');
    expect(e.expectedVersion).toBe(7);
  });
});

describe('packages/db :: AppendOnlyViolationError', () => {
  test('encodes operation + resource in message', () => {
    const e = new AppendOnlyViolationError({
      resourceType: 'audit_events',
      operation: 'update',
    });
    expect(e.name).toBe('AppendOnlyViolationError');
    expect(e.message).toContain('audit_events');
    expect(e.message).toContain('update');
    expect(e.message).toContain('not permitted');
  });
});
