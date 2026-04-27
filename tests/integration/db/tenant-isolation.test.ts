// B18 / B18b — tenant isolation across query shapes.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Repositories, buildRepositories } from '@cyberstrike/db';
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

describe.skipIf(skip)('tenant isolation (B18, B18b)', () => {
  let f: DbFixture;
  let repos: Repositories;
  let t1: string;
  let t2: string;

  beforeAll(async () => {
    f = await createFixture();
    await dropAllTables(f);
    await applyAllMigrations(f);
    repos = buildRepositories(f.db);
    t1 = await seedTenant(f, { name: 'T1', slug: 't1-iso' });
    t2 = await seedTenant(f, { name: 'T2', slug: 't2-iso' });

    // Seed projects in both tenants.
    await repos.projects.insert(t1, { name: 'p1-t1', description: '', status: 'active' });
    await repos.projects.insert(t1, { name: 'p2-t1', description: '', status: 'active' });
    await repos.projects.insert(t1, { name: 'p3-t1', description: '', status: 'active' });
    await repos.projects.insert(t2, { name: 'p1-t2', description: '', status: 'active' });
    await repos.projects.insert(t2, { name: 'p2-t2', description: '', status: 'active' });
  });

  afterAll(async () => {
    if (f) {
      await dropAllTables(f);
      await f.db.destroy();
    }
  });

  test('B18 — findById of T1 row from T2 context returns null', async () => {
    const t1Project = (await repos.projects.findAll(t1))[0];
    if (!t1Project) throw new Error('seed missing');
    const result = await runInTenant(t2, () => repos.projects.findById(undefined, t1Project.id));
    expect(result).toBeNull();
  });

  test('B18b — findAll from T2 context returns ONLY T2 rows', async () => {
    const all = await runInTenant(t2, () => repos.projects.findAll(undefined));
    expect(all.length).toBe(2);
    for (const r of all) expect(r.tenant_id).toBe(t2);
  });

  test('B18b — count from T2 context returns count of T2 rows only', async () => {
    const c = await runInTenant(t2, () => repos.projects.count(undefined));
    expect(c).toBe(2);
  });

  test('B18b — count from T1 context returns 3 (the seeded T1 set)', async () => {
    const c = await runInTenant(t1, () => repos.projects.count(undefined));
    expect(c).toBe(3);
  });
});
