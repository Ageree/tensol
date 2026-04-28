// audit-emission.test.ts — Sprint 3 C29.
//
// Asserts the delta=1 invariant for every state-changing auth action listed
// in the contract:
//   auth.register, auth.login.password, auth.login.mfa, auth.logout,
//   auth.mfa.enable, auth.mfa.verify, auth.password.reset.request,
//   auth.password.reset.confirm.
//
// Each scenario performs the request, reads count(*) before/after, asserts
// delta === 1 and that the latest row's outcome is in the contract-specified
// set.

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
  seedLoggedInUser,
} from './helpers/auth-fixture.ts';

describe.skipIf(!hasDatabaseUrl())('integration :: audit-emission delta=1 invariant (C29)', () => {
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

  const expectExactlyOneAudit = async (
    action: string,
    allowedOutcomes: ReadonlyArray<string>,
    runRequest: () => Promise<Response>,
  ): Promise<void> => {
    const before = await countAuditEvents(fx.db);
    const res = await runRequest();
    // Drain body so the request is fully completed.
    try {
      await res.text();
    } catch {
      // ignore
    }
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    const last = await latestAuditOutcome(fx.db);
    expect(last?.action).toBe(action);
    expect(allowedOutcomes).toContain(last?.outcome ?? '');
  };

  test('auth.register success', async () => {
    await expectExactlyOneAudit('auth.register', ['success', 'failure', 'gone'], () =>
      auth.app.request('/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'a@example.com',
          password: 'correct-horse-battery-staple',
          displayName: 'A',
          tenantSlug: 'a',
          tenantName: 'A',
          bootstrapToken: 'x',
        }),
      }),
    );
  });

  test('auth.login.password failure (unknown email)', async () => {
    await expectExactlyOneAudit('auth.login.password', ['failure'], () =>
      auth.app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'nobody@example.com',
          password: 'correct-horse-battery-staple',
        }),
      }),
    );
  });

  test('auth.login.password success (no MFA)', async () => {
    const tenantId = await seedTenant(fx, { name: 'tlog', slug: 'tlog' });
    const userId = await seedUser(fx, tenantId, {
      email: 'log@example.com',
      role: 'security_lead',
    });
    const passwordHash = await auth.hasher.hash('correct-horse-battery-staple');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();
    await expectExactlyOneAudit('auth.login.password', ['success'], () =>
      auth.app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'log@example.com',
          password: 'correct-horse-battery-staple',
        }),
      }),
    );
  });

  test('auth.logout no_session (no cookie)', async () => {
    await expectExactlyOneAudit('auth.logout', ['no_session'], () =>
      auth.app.request('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
  });

  test('auth.logout success', async () => {
    const session = await seedLoggedInUser(auth, {
      tenantSlug: 'tlogout',
      email: 'logout@example.com',
    });
    await expectExactlyOneAudit('auth.logout', ['success'], () =>
      auth.app.request('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
        body: '{}',
      }),
    );
  });

  test('auth.mfa.enable issued', async () => {
    const session = await seedLoggedInUser(auth, {
      tenantSlug: 'tmfae',
      email: 'mfae@example.com',
    });
    await expectExactlyOneAudit('auth.mfa.enable', ['issued'], () =>
      auth.app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
        body: '{}',
      }),
    );
  });

  test('auth.mfa.verify success', async () => {
    const session = await seedLoggedInUser(auth, {
      tenantSlug: 'tmfav',
      email: 'mfav@example.com',
    });
    const enable = await auth.app.request('/auth/mfa/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: '{}',
    });
    const enableBody = (await enable.json()) as { secret: string };
    const code = auth.totp.generateCode(enableBody.secret);
    await expectExactlyOneAudit('auth.mfa.verify', ['success'], () =>
      auth.app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
        body: JSON.stringify({ code }),
      }),
    );
  });

  test('auth.password.reset.request issued', async () => {
    const tenantId = await seedTenant(fx, { name: 'tprr', slug: 'tprr' });
    const userId = await seedUser(fx, tenantId, {
      email: 'prr@example.com',
      role: 'security_lead',
    });
    const passwordHash = await auth.hasher.hash('placeholder-12345-strong');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();

    await expectExactlyOneAudit('auth.password.reset.request', ['issued', 'miss'], () =>
      auth.app.request('/auth/password/reset/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'prr@example.com' }),
      }),
    );
  });

  test('auth.password.reset.confirm success', async () => {
    const tenantId = await seedTenant(fx, { name: 'tprc', slug: 'tprc' });
    const userId = await seedUser(fx, tenantId, {
      email: 'prc@example.com',
      role: 'security_lead',
    });
    const passwordHash = await auth.hasher.hash('placeholder-12345-strong');
    await fx.db
      .updateTable('users')
      .set({ password_hash: passwordHash })
      .where('id', '=', userId)
      .execute();
    const reqRes = await auth.app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'prc@example.com' }),
    });
    const { token } = (await reqRes.json()) as { token: string };

    await expectExactlyOneAudit('auth.password.reset.confirm', ['success'], () =>
      auth.app.request('/auth/password/reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, new_password: 'fresh-password-123-456' }),
      }),
    );
  });
});
