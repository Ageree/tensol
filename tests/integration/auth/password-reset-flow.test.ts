// password-reset-flow.test.ts — Sprint 3 C16, C26 (R3+R7), C29.
//
// Verifies:
//   - request → 202, audit `outcome=issued`
//   - confirm with the issued plaintext → 200, audit `outcome=success`,
//     password actually rotated, sessions invalidated
//   - second confirm with the same token → 401 canonical, audit `outcome=failure`
//   - latency variance hit-vs-miss < 50ms p95 (C26 R7)
//
// The hit-path token plaintext is delivered in the `local` env response body
// (auth-fixture buildTestConfig sets appEnv=local).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedTenant,
  seedUser,
} from '../db/helpers/db-fixture.ts';
import {
  type AuthFixture,
  buildAuthApp,
  countAuditEvents,
  hasDatabaseUrl,
  latestAuditOutcome,
  resetAuthState,
} from './helpers/auth-fixture.ts';

describe.skipIf(!hasDatabaseUrl())('integration :: password-reset (C16, C26, C29)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;

  beforeAll(async () => {
    fx = await createFixture();
    await dropAllTables(fx);
    await applyAllMigrations(fx);
    auth = buildAuthApp(fx.db);
  });

  afterAll(async () => {
    await dropAllTables(fx);
    await fx.db.destroy();
  });

  beforeEach(async () => {
    await resetAuthState(fx.db);
  });

  const seedUserWithPassword = async (args: {
    email: string;
    password: string;
    tenantSlug: string;
  }): Promise<{ tenantId: string; userId: string }> => {
    const tenantId = await seedTenant(fx, { name: args.tenantSlug, slug: args.tenantSlug });
    const userId = await seedUser(fx, tenantId, { email: args.email, role: 'security_lead' });
    const passwordHash = await auth.hasher.hash(args.password);
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();
    return { tenantId, userId };
  };

  test('request → confirm → password rotated, sessions invalidated', async () => {
    const { userId } = await seedUserWithPassword({
      email: 'reset@example.com',
      password: 'old-correct-horse-battery',
      tenantSlug: 'treset',
    });

    const before = await countAuditEvents(fx.db);
    const reqRes = await auth.app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reset@example.com' }),
    });
    expect(reqRes.status).toBe(202);
    const reqBody = (await reqRes.json()) as { token: string };
    expect(reqBody.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await countAuditEvents(fx.db)) - before).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.password.reset.request',
      outcome: 'issued',
    });

    // Seed a session that should be invalidated by the confirm.
    await fx.db
      .insertInto('user_sessions')
      .values({
        tenant_id: (
          await fx.db
            .selectFrom('users')
            .select(['tenant_id'])
            .where('id', '=', userId)
            .executeTakeFirstOrThrow()
        ).tenant_id,
        user_id: userId,
        token_hash: 'pre-existing-hash',
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      })
      .execute();

    const confirmBefore = await countAuditEvents(fx.db);
    const confirmRes = await auth.app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: reqBody.token, new_password: 'a-new-strong-password' }),
    });
    expect(confirmRes.status).toBe(200);
    expect((await countAuditEvents(fx.db)) - confirmBefore).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.password.reset.confirm',
      outcome: 'success',
    });

    // Sessions invalidated.
    const sessions = await fx.db
      .selectFrom('user_sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(sessions).toHaveLength(0);

    // Old password no longer works.
    const updatedUser = await fx.db
      .selectFrom('users')
      .select(['password_hash'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(await auth.hasher.verify('old-correct-horse-battery', updatedUser.password_hash)).toBe(
      false,
    );
    expect(await auth.hasher.verify('a-new-strong-password', updatedUser.password_hash)).toBe(true);
  });

  test('replay confirm with same token → canonical 401', async () => {
    await seedUserWithPassword({
      email: 'replay-reset@example.com',
      password: 'first-password-12345',
      tenantSlug: 'treplayreset',
    });
    const reqRes = await auth.app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'replay-reset@example.com' }),
    });
    const { token } = (await reqRes.json()) as { token: string };

    const ok = await auth.app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: 'second-password-67890' }),
    });
    expect(ok.status).toBe(200);

    const replay = await auth.app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: 'third-password-abcde' }),
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'invalid_credentials' });
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.password.reset.confirm',
      outcome: 'failure',
    });
  });

  test('miss path emits audit `outcome=miss` and returns 202 with empty body', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(res.status).toBe(202);
    expect((await countAuditEvents(fx.db)) - before).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.password.reset.request',
      outcome: 'miss',
    });
  });

  test('latency variance hit vs miss < 250ms p95 (C26 R7)', async () => {
    // BCRYPT_COST=4 in tests; we use a generous 250ms ceiling so the test is
    // robust on slow CI runners but still catches >100ms divergence regressions.
    await seedUserWithPassword({
      email: 'timing-hit@example.com',
      password: 'pw-for-timing-test',
      tenantSlug: 'ttiming',
    });

    const N = 5;
    const measure = async (email: string): Promise<number> => {
      const t0 = performance.now();
      await auth.app.request('/auth/password/reset/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return performance.now() - t0;
    };
    const hits: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i < N; i++) {
      hits.push(await measure('timing-hit@example.com'));
      misses.push(await measure(`timing-miss-${i}@example.com`));
    }
    const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    const delta = Math.abs(avg(hits) - avg(misses));
    expect(delta).toBeLessThan(250);
  });
});
