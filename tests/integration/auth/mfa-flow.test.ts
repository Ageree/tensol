// mfa-flow.test.ts — Sprint 3 C25, C29.
//
// Covers /auth/mfa/enable → /auth/mfa/verify, including replay rejection in
// the same TOTP step window.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
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

describe.skipIf(!hasDatabaseUrl())('integration :: MFA enable + verify (C25, C29)', () => {
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

  test('enable issues a secret + audit row', async () => {
    const session = await seedLoggedInUser(auth, {
      tenantSlug: 'tnp-mfa',
      email: 'mfa-user@example.com',
    });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/auth/mfa/enable', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookieHeader,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string };
    expect(body.secret.length).toBeGreaterThan(0);

    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.mfa.enable',
      outcome: 'issued',
    });
  });

  test('verify accepts the first valid code, sets enrolled_at', async () => {
    const session = await seedLoggedInUser(auth, {
      tenantSlug: 'tnp-mfa-2',
      email: 'mfa2@example.com',
    });
    const enable = await auth.app.request('/auth/mfa/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: JSON.stringify({}),
    });
    const enableBody = (await enable.json()) as { secret: string };
    const code = auth.totp.generateCode(enableBody.secret);

    const before = await countAuditEvents(fx.db);
    const verify = await auth.app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ ok: true });
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.mfa.verify',
      outcome: 'success',
    });

    const mfa = await fx.db
      .selectFrom('mfa_secrets')
      .selectAll()
      .where('user_id', '=', session.userId)
      .executeTakeFirstOrThrow();
    expect(mfa.enrolled_at).not.toBeNull();
  });

  test('verify rejects after enrollment (no pending secret left)', async () => {
    const session = await seedLoggedInUser(auth, {
      tenantSlug: 'tnp-mfa-3',
      email: 'mfa3@example.com',
    });
    const enable = await auth.app.request('/auth/mfa/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: JSON.stringify({}),
    });
    const enableBody = (await enable.json()) as { secret: string };
    const code = auth.totp.generateCode(enableBody.secret);

    const first = await auth.app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);

    // Second verify with the same code — no pending secret remains, route 400s.
    // The replay LRU is an internal-protection layer covered by totp.test.ts;
    // here we assert the route does not silently re-accept the same code.
    const replay = await auth.app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookieHeader },
      body: JSON.stringify({ code }),
    });
    expect([400, 401]).toContain(replay.status);
  });
});
