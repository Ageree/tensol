// B21 — Optimistic lock: two concurrent updates from version=1; first wins,
// second throws OptimisticLockError.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OptimisticLockError, type Repositories, buildRepositories } from '@cyberstrike/db';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  hasDatabaseUrl,
  seedTenant,
  seedUser,
} from './helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

describe.skipIf(skip)('optimistic locking (B21)', () => {
  let f: DbFixture;
  let repos: Repositories;
  let tenantId: string;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    f = await createFixture();
    await dropAllTables(f);
    await applyAllMigrations(f);
    repos = buildRepositories(f.db);
    tenantId = await seedTenant(f, { name: 'T', slug: 't-lock' });
    // Sprint 2 evaluator F2: assessments.created_by FK requires a real users row.
    userId = await seedUser(f, tenantId, { email: 'lock@example.com' });
    const project = await repos.projects.insert(tenantId, {
      name: 'p',
      description: '',
      status: 'active',
    });
    projectId = project.id;
  });

  afterAll(async () => {
    if (f) {
      await dropAllTables(f);
      await f.db.destroy();
    }
  });

  test('versioned update: first update succeeds, second with stale version throws', async () => {
    const assessment = await repos.assessments.insert(tenantId, {
      project_id: projectId,
      created_by: userId,
      state: 'draft',
      high_impact_categories: [],
      metadata: {},
    });

    const first = await repos.assessments.update(
      tenantId,
      assessment.id,
      { state: 'submitted' },
      1,
    );
    expect(first.updated).toBe(1);

    await expect(
      repos.assessments.update(tenantId, assessment.id, { state: 'approved' }, 1),
    ).rejects.toBeInstanceOf(OptimisticLockError);
  });
});
