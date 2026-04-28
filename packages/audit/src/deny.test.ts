import { describe, expect, test } from 'bun:test';
import { type DenyAuditArgs, denyAudit } from './deny.ts';

interface FakeDb {
  readonly inserts: Array<Record<string, unknown>>;
}

const makeDb = () => {
  const fake: FakeDb = { inserts: [] };
  return {
    db: fake,
    mock: {
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            fake.inserts.push(row);
          },
        }),
      }),
    },
  };
};

const baseArgs: DenyAuditArgs = Object.freeze({
  tenantId: '00000000-0000-4000-8000-000000000001',
  action: 'rbac.deny',
  outcome: 'forbidden',
  actorType: 'user',
  actorId: 'u1',
  actorName: 'Alice',
  resourceType: 'project',
  resourceId: '00000000-0000-4000-8000-000000000099',
  reason: 'cross-tenant access',
  ip: '10.0.0.1',
  userAgent: 'curl/8.0',
  traceId: '0123456789abcdef0123456789abcdef',
});

describe('packages/audit :: denyAudit (A7)', () => {
  test('emits exactly one row with the deny outcome', async () => {
    const { db, mock: dbMock } = makeDb();
    // biome-ignore lint/suspicious/noExplicitAny: stub
    await denyAudit({ db: dbMock as any }, baseArgs);
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0] as {
      action: string;
      after_state: { outcome: string; reason: string };
      tenant_id: string;
    };
    expect(row.action).toBe('rbac.deny');
    expect(row.after_state.outcome).toBe('forbidden');
    expect(row.after_state.reason).toBe('cross-tenant access');
    expect(row.tenant_id).toBe(baseArgs.tenantId);
  });

  test('cross_tenant_attempt action with cross_tenant outcome', async () => {
    const { db, mock: dbMock } = makeDb();
    await denyAudit(
      // biome-ignore lint/suspicious/noExplicitAny: stub
      { db: dbMock as any },
      {
        ...baseArgs,
        action: 'tenant.cross_tenant_attempt',
        outcome: 'cross_tenant',
        reason: 'repository-level cross-tenant detected',
      },
    );
    const row = db.inserts[0] as { action: string; after_state: { outcome: string } };
    expect(row.action).toBe('tenant.cross_tenant_attempt');
    expect(row.after_state.outcome).toBe('cross_tenant');
  });

  test('metadata is merged into after_state alongside reason and outcome', async () => {
    const { db, mock: dbMock } = makeDb();
    await denyAudit(
      // biome-ignore lint/suspicious/noExplicitAny: stub
      { db: dbMock as any },
      {
        ...baseArgs,
        metadata: { attemptedResourceTenantId: '00000000-0000-4000-8000-0000000000aa' },
      },
    );
    const row = db.inserts[0] as {
      after_state: { outcome: string; reason: string; attemptedResourceTenantId: string };
    };
    expect(row.after_state.outcome).toBe('forbidden');
    expect(row.after_state.reason).toBe('cross-tenant access');
    expect(row.after_state.attemptedResourceTenantId).toBe('00000000-0000-4000-8000-0000000000aa');
  });

  test('insert throw propagates (caller decides — A8 NQ-A)', async () => {
    const failing = {
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            throw new Error('DB outage');
          },
        }),
      }),
    };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: stub
      denyAudit({ db: failing as any }, baseArgs),
    ).rejects.toThrow('DB outage');
  });
});
