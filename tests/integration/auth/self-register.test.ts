// self-register.test.ts — S24 SaaS foundation.
//
// PG-IT: skipIf-gated on absence of DATABASE_URL. Verifies:
//   - happy path → 201 + Set-Cookie + tenant+user rows created
//   - duplicate email → 409
//   - invalid body → 400
//   - audit emission on all code paths
//   - tenant isolation (new tenant's data not visible to other tenants)
//   - platform_settings untouched after registration

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
  TEST_COOKIE_NAME,
  buildAuthApp,
  countAuditEvents,
  hasDatabaseUrl,
  latestAuditOutcome,
  resetAuthState,
} from './helpers/auth-fixture.ts';

const ENDPOINT = '/auth/self-register';

const validBody = (suffix = '') => ({
  email: `test${suffix}@example.com`,
  password: 'correct-horse-battery-staple',
  displayName: `Test User${suffix}`,
});

describe.skipIf(!hasDatabaseUrl())('integration :: POST /auth/self-register (S24)', () => {
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

  test('happy path: creates tenant + user + session, returns 201 + cookie', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.userId).toBe('string');
    expect(typeof body.tenantId).toBe('string');

    // Cookie set.
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(TEST_COOKIE_NAME);
    expect(setCookie).toContain('HttpOnly');

    // Tenant row created.
    const tenant = await fx.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', body.tenantId)
      .executeTakeFirst();
    expect(tenant).toBeTruthy();
    expect(tenant?.status).toBe('active');

    // User row created with correct role + email_verified flag.
    const user = await fx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', body.userId)
      .executeTakeFirst();
    expect(user).toBeTruthy();
    expect(user?.role).toBe('tenant_admin');
    expect(user?.email).toBe('test@example.com');
    expect(user?.email_verified).toBe(true);
    expect(user?.tenant_id).toBe(body.tenantId);

    // Exactly one new audit event.
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);

    const latest = await latestAuditOutcome(fx.db);
    expect(latest?.action).toBe('auth.self_register');
    expect(latest?.outcome).toBe('success');

    // Audit tenantId = new tenant's id.
    const auditRow = await fx.db
      .selectFrom('audit_events')
      .select(['tenant_id'])
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    expect(auditRow?.tenant_id).toBe(body.tenantId);
  });

  test('platform_settings untouched after self-register', async () => {
    await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody('-ps')),
    });
    const settings = await fx.db
      .selectFrom('platform_settings')
      .select('bootstrap_consumed_at')
      .executeTakeFirst();
    expect(settings?.bootstrap_consumed_at).toBeNull();
  });

  test('duplicate email → 409, audit emits failure', async () => {
    await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody('-dup')),
    });
    const before = await countAuditEvents(fx.db);

    const res = await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody('-dup')), // same email
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('email_already_registered');

    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    const latest = await latestAuditOutcome(fx.db);
    expect(latest?.action).toBe('auth.self_register');
    expect(latest?.outcome).toBe('failure');
  });

  test('invalid body → 400, audit emits failure', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-valid', password: 'short', displayName: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');

    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    const latest = await latestAuditOutcome(fx.db);
    expect(latest?.action).toBe('auth.self_register');
    expect(latest?.outcome).toBe('failure');
  });

  test('tenant isolation: new tenant data not visible to other tenant', async () => {
    // Seed an existing tenant.
    const otherTenantId = await seedTenant(fx, { name: 'other', slug: 'other-tenant' });
    const _otherUserId = await seedUser(fx, otherTenantId, { email: 'other@example.com' });

    // Register new tenant.
    const res = await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody('-iso')),
    });
    expect(res.status).toBe(201);
    const { tenantId: newTenantId } = await res.json();

    // New tenant's user should not appear in other tenant's user list.
    const usersInOtherTenant = await fx.db
      .selectFrom('users')
      .selectAll()
      .where('tenant_id', '=', otherTenantId)
      .execute();
    const emails = usersInOtherTenant.map((u) => u.email);
    expect(emails).not.toContain('test-iso@example.com');

    // Other tenant's user should not appear in new tenant's user list.
    const usersInNewTenant = await fx.db
      .selectFrom('users')
      .selectAll()
      .where('tenant_id', '=', newTenantId)
      .execute();
    const newEmails = usersInNewTenant.map((u) => u.email);
    expect(newEmails).not.toContain('other@example.com');
  });

  test('register→login→me flow: session cookie works for /auth/me', async () => {
    const res = await auth.app.request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody('-flow')),
    });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookieMatch = setCookie.match(new RegExp(`${TEST_COOKIE_NAME}=([^;]+)`));
    expect(cookieMatch).toBeTruthy();
    const cookieHeader = `${TEST_COOKIE_NAME}=${cookieMatch?.[1]}`;

    const meRes = await auth.app.request('/auth/me', {
      headers: { cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.actor?.email).toBe('test-flow@example.com');
    expect(me.actor?.role).toBe('tenant_admin');
    expect(me.tenant).toBeTruthy();
  });
});
