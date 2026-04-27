// B19b — onCrossTenantAttempt hook fires with full payload on cross-tenant
// find AND cross-tenant update. Sprint 4 wires this to denyAudit.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CrossTenantAttempt, type Repositories, buildRepositories } from '@cyberstrike/db';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  hasDatabaseUrl,
  runInTenant,
  seedTenant,
} from './helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

describe.skipIf(skip)('cross-tenant hook (B19b)', () => {
  let f: DbFixture;
  let attempts: CrossTenantAttempt[];
  let repos: Repositories;
  let t1: string;
  let t2: string;
  let p1Id: string;

  beforeAll(async () => {
    f = await createFixture();
    await dropAllTables(f);
    await applyAllMigrations(f);
    attempts = [];
    repos = buildRepositories(f.db, {
      onCrossTenantAttempt: (e) => attempts.push(e),
    });
    t1 = await seedTenant(f, { name: 'T1', slug: 't1-hook' });
    t2 = await seedTenant(f, { name: 'T2', slug: 't2-hook' });
    const row = await repos.projects.insert(t1, {
      name: 'p1',
      description: '',
      status: 'active',
    });
    p1Id = row.id;
  });

  afterAll(async () => {
    if (f) {
      await dropAllTables(f);
      await f.db.destroy();
    }
  });

  test('hook fires on cross-tenant findById with full payload', async () => {
    attempts.length = 0;
    const result = await runInTenant(t2, () => repos.projects.findById(undefined, p1Id));
    expect(result).toBeNull();
    expect(attempts.length).toBe(1);
    const e = attempts[0];
    if (!e) throw new Error('hook not invoked');
    expect(e.actorTenantId).toBe(t2);
    expect(e.rowTenantId).toBe(t1);
    expect(e.resourceType).toBe('project');
    expect(e.resourceId).toBe(p1Id);
    expect(e.operation).toBe('find');
    expect(e.occurredAt).toBeInstanceOf(Date);
  });

  test('hook fires on cross-tenant update; updates 0 rows', async () => {
    attempts.length = 0;
    const result = await runInTenant(t2, () =>
      repos.projects.update(undefined, p1Id, { name: 'pwned' }),
    );
    expect(result.updated).toBe(0);
    expect(attempts.length).toBe(1);
    const e = attempts[0];
    if (!e) throw new Error('hook not invoked');
    expect(e.operation).toBe('update');
    expect(e.actorTenantId).toBe(t2);
    expect(e.rowTenantId).toBe(t1);
  });
});
