// login-flow.test.ts — Sprint 3 C22, C26 (R7), C29.
//
// Covers password-only and password+MFA two-step flows, canonical 401 on
// every failure mode (no oracle), pre-auth-token single-use redemption.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedMfaSecret,
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

describe.skipIf(!hasDatabaseUrl())('integration :: login two-step flow (C22, C29)', () => {
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

  const seedPasswordUser = async (args: {
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

  test('password-only path issues a session cookie', async () => {
    await seedPasswordUser({
      email: 'no-mfa@example.com',
      password: 'correct-horse-battery-staple',
      tenantSlug: 'tnp',
    });

    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'no-mfa@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('cs_session=');

    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.login.password',
      outcome: 'success',
    });
  });

  test('password+MFA path: step-1 returns pre-auth token (401), step-2 issues cookie', async () => {
    const { userId, tenantId } = await seedPasswordUser({
      email: 'mfa@example.com',
      password: 'correct-horse-battery-staple',
      tenantSlug: 'tmfa',
    });
    const secret = auth.totp.generateSecret();
    await seedMfaSecret(fx, {
      tenantId,
      userId,
      secretEncrypted: secret,
      enrolledAt: new Date(),
    });

    const auditBefore = await countAuditEvents(fx.db);
    const step1 = await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'mfa@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });
    expect(step1.status).toBe(401);
    const step1Body = (await step1.json()) as { pre_auth_token: string; expires_in: number };
    expect(step1Body.pre_auth_token).toMatch(/^[0-9a-f]{64}$/);
    expect(step1Body.expires_in).toBe(60);
    const auditAfter1 = await countAuditEvents(fx.db);
    expect(auditAfter1 - auditBefore).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.login.password',
      outcome: 'mfa_required',
    });

    const code = auth.totp.generateCode(secret);
    const step2 = await auth.app.request('/auth/login/mfa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pre_auth_token: step1Body.pre_auth_token,
        mfa_code: code,
      }),
    });
    expect(step2.status).toBe(200);
    expect(step2.headers.get('set-cookie')).toContain('cs_session=');
    const auditAfter2 = await countAuditEvents(fx.db);
    expect(auditAfter2 - auditAfter1).toBe(1);
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.login.mfa',
      outcome: 'success',
    });
  });

  test('canonical 401 on bad password (no oracle)', async () => {
    await seedPasswordUser({
      email: 'a@example.com',
      password: 'correct-horse-battery-staple',
      tenantSlug: 't1',
    });
    const res = await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'invalid_credentials' });
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.login.password',
      outcome: 'failure',
    });
  });

  test('canonical 401 on unknown email (same shape as bad password)', async () => {
    const res = await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'nobody@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(await latestAuditOutcome(fx.db)).toEqual({
      action: 'auth.login.password',
      outcome: 'failure',
    });
  });

  test('pre-auth token is single-use', async () => {
    const { userId, tenantId } = await seedPasswordUser({
      email: 'replay@example.com',
      password: 'correct-horse-battery-staple',
      tenantSlug: 'treplay',
    });
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
      body: JSON.stringify({
        email: 'replay@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });
    const step1Body = (await step1.json()) as { pre_auth_token: string };

    const code = auth.totp.generateCode(secret);
    const ok = await auth.app.request('/auth/login/mfa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pre_auth_token: step1Body.pre_auth_token, mfa_code: code }),
    });
    expect(ok.status).toBe(200);

    // Replay the same pre-auth token → canonical 401.
    const replay = await auth.app.request('/auth/login/mfa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pre_auth_token: step1Body.pre_auth_token, mfa_code: code }),
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'invalid_credentials' });
  });
});
