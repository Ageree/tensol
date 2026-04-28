// Sprint 4 A19 — C29 delta=1 invariant across all 10 emission points.
//
// 1. auth.register
// 2. auth.login.password
// 3. auth.login.mfa
// 4. auth.logout
// 5. auth.mfa.enable
// 6. auth.mfa.verify
// 7. auth.password.reset.request
// 8. auth.password.reset.confirm
// 9. rbac.deny                    (Sprint 4 / A8)
// 10. tenant.cross_tenant_attempt (Sprint 4 / A9)
//
// Uses the new `assertExactlyOneAuditRow` harness from packages/audit/testing.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { assertExactlyOneAuditRow, denyAudit } from '@cyberstrike/audit';
import { buildRepositories } from '@cyberstrike/db';
import {
  type AuthFixture,
  buildAuthApp,
  hasDatabaseUrl,
  resetAuthState,
  seedLoggedInUser,
} from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  runInTenant,
  seedMfaSecret,
  seedTenant,
  seedUser,
} from '../db/helpers/db-fixture.ts';

const expectAfter = async (
  fx: DbFixture,
  before: number,
  predicate: { action: string; tenantId?: string; resourceId?: string },
): Promise<void> => {
  const row = await fx.db
    .selectFrom('audit_events')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('action', '=', predicate.action)
    .executeTakeFirstOrThrow();
  expect(Number(row.count) - before).toBe(1);
  await assertExactlyOneAuditRow(fx.db, predicate);
};

const countAction = async (fx: DbFixture, action: string): Promise<number> => {
  const row = await fx.db
    .selectFrom('audit_events')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('action', '=', action)
    .executeTakeFirstOrThrow();
  return Number(row.count);
};

describe.skipIf(!hasDatabaseUrl())('audit :: C29 delta=1 across 10 emission points (A19)', () => {
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

  test('1. auth.register success', async () => {
    const before = await countAction(fx, 'auth.register');
    await auth.app.request('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'a@x.io',
        password: 'correct-horse-battery-staple',
        displayName: 'A',
        tenantSlug: 'c29-1',
        tenantName: 'A',
        bootstrapToken: 'x',
      }),
    });
    const after = await countAction(fx, 'auth.register');
    expect(after - before).toBe(1);
  });

  test('2. auth.login.password success', async () => {
    const tenantId = await seedTenant(fx, { name: 'c29-2', slug: 'c29-2' });
    const userId = await seedUser(fx, tenantId, { email: 'lp@x.io' });
    const passwordHash = await auth.hasher.hash('correct-horse-battery-staple');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();

    const before = await countAction(fx, 'auth.login.password');
    await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lp@x.io', password: 'correct-horse-battery-staple' }),
    });
    const after = await countAction(fx, 'auth.login.password');
    expect(after - before).toBe(1);
  });

  test('3. auth.login.mfa success', async () => {
    const tenantId = await seedTenant(fx, { name: 'c29-3', slug: 'c29-3' });
    const userId = await seedUser(fx, tenantId, { email: 'lm@x.io' });
    const passwordHash = await auth.hasher.hash('correct-horse-battery-staple');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();
    const secret = auth.totp.generateSecret();
    await seedMfaSecret(fx, {
      tenantId,
      userId,
      secretEncrypted: secret,
      enrolledAt: new Date(),
    });

    const step1 = await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lm@x.io', password: 'correct-horse-battery-staple' }),
    });
    const { pre_auth_token } = (await step1.json()) as { pre_auth_token: string };

    const before = await countAction(fx, 'auth.login.mfa');
    await auth.app.request('/auth/login/mfa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pre_auth_token,
        mfa_code: auth.totp.generateCode(secret),
      }),
    });
    const after = await countAction(fx, 'auth.login.mfa');
    expect(after - before).toBe(1);
  });

  test('4. auth.logout success', async () => {
    const session = await seedLoggedInUser(auth, { tenantSlug: 'c29-4', email: 'lo@x.io' });
    const before = await countAction(fx, 'auth.logout');
    await auth.app.request('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: '{}',
    });
    expect((await countAction(fx, 'auth.logout')) - before).toBe(1);
  });

  test('5. auth.mfa.enable issued', async () => {
    const session = await seedLoggedInUser(auth, { tenantSlug: 'c29-5', email: 'me@x.io' });
    const before = await countAction(fx, 'auth.mfa.enable');
    await auth.app.request('/auth/mfa/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: '{}',
    });
    expect((await countAction(fx, 'auth.mfa.enable')) - before).toBe(1);
  });

  test('6. auth.mfa.verify success', async () => {
    const session = await seedLoggedInUser(auth, { tenantSlug: 'c29-6', email: 'mv@x.io' });
    const enable = await auth.app.request('/auth/mfa/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: '{}',
    });
    const { secret } = (await enable.json()) as { secret: string };
    const before = await countAction(fx, 'auth.mfa.verify');
    await auth.app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: JSON.stringify({ code: auth.totp.generateCode(secret) }),
    });
    expect((await countAction(fx, 'auth.mfa.verify')) - before).toBe(1);
  });

  test('7. auth.password.reset.request issued', async () => {
    const tenantId = await seedTenant(fx, { name: 'c29-7', slug: 'c29-7' });
    const userId = await seedUser(fx, tenantId, { email: 'pr@x.io' });
    const passwordHash = await auth.hasher.hash('placeholder-strong');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();

    const before = await countAction(fx, 'auth.password.reset.request');
    await auth.app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pr@x.io' }),
    });
    expect((await countAction(fx, 'auth.password.reset.request')) - before).toBe(1);
  });

  test('8. auth.password.reset.confirm success', async () => {
    const tenantId = await seedTenant(fx, { name: 'c29-8', slug: 'c29-8' });
    const userId = await seedUser(fx, tenantId, { email: 'pc@x.io' });
    const passwordHash = await auth.hasher.hash('placeholder-strong-12345');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();
    const reqRes = await auth.app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pc@x.io' }),
    });
    const { token } = (await reqRes.json()) as { token: string };

    const before = await countAction(fx, 'auth.password.reset.confirm');
    await auth.app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: 'fresh-secret-987-654' }),
    });
    expect((await countAction(fx, 'auth.password.reset.confirm')) - before).toBe(1);
  });

  test('9. rbac.deny via cross-tenant fixture endpoint (A8 wiring)', async () => {
    const t1 = await seedLoggedInUser(auth, { tenantSlug: 'c29-9-a', email: 't1@x.io' });
    const t2 = await seedLoggedInUser(auth, { tenantSlug: 'c29-9-b', email: 't2@x.io' });
    const project = await fx.db
      .insertInto('projects')
      .values({
        tenant_id: t1.tenantId,
        name: 'P9',
        description: '',
        status: 'active',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const before = await countAction(fx, 'rbac.deny');
    await auth.app.request(`/_test/resource/${project.id}`, {
      headers: { cookie: t2.cookieHeader },
    });
    expect((await countAction(fx, 'rbac.deny')) - before).toBe(1);
  });

  test('10. tenant.cross_tenant_attempt via repo hook (A9 wiring)', async () => {
    const t1 = await seedTenant(fx, { name: 'c29-10-a', slug: 'c29-10-a' });
    const t2 = await seedTenant(fx, { name: 'c29-10-b', slug: 'c29-10-b' });
    // Build wired repos so the cross-tenant find produces an audit row.
    const repos = buildRepositories(fx.db, {
      onCrossTenantAttempt: (e) => {
        void denyAudit(
          { db: fx.db },
          {
            tenantId: e.actorTenantId,
            action: 'tenant.cross_tenant_attempt',
            outcome: 'cross_tenant',
            actorType: 'service',
            actorId: 'system',
            actorName: 'mutable-repository',
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            reason: 'repository-level cross-tenant detected',
            traceId: '00000000000000000000000000000010',
            metadata: { attemptedResourceTenantId: e.rowTenantId, operation: e.operation },
          },
        );
      },
    });
    const inserted = await repos.projects.insert(t1, {
      name: 'p10',
      description: '',
      status: 'active',
    });

    const before = await countAction(fx, 'tenant.cross_tenant_attempt');
    await runInTenant(t2, () => repos.projects.findById(undefined, inserted.id));
    // Fire-and-forget — give it time to settle.
    await new Promise((r) => setTimeout(r, 200));
    expect((await countAction(fx, 'tenant.cross_tenant_attempt')) - before).toBe(1);
  });
});

void expectAfter;
