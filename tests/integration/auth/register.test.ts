// register.test.ts — Sprint 3 C21a/b/c, C29.
//
// PG-IT: skipIf-gated on absence of DATABASE_URL. Verifies:
//   - first call succeeds → 201, audit `outcome=success`, exactly +1 audit row
//   - second call returns 410 Gone, audit `outcome=gone`
//   - missing/invalid body → 400, audit `outcome=failure`

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
} from './helpers/auth-fixture.ts';

describe.skipIf(!hasDatabaseUrl())('integration :: POST /auth/register (C21, C29)', () => {
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

  test('first call succeeds, audit emits exactly one success row', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Bootstrap Admin',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        bootstrapToken: 'irrelevant-in-local',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    const last = await latestAuditOutcome(fx.db);
    expect(last).toEqual({ action: 'auth.register', outcome: 'success' });
  });

  test('second call returns 410 Gone, audit outcome=gone', async () => {
    // Seed first registration directly.
    await auth.app.request('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'first@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'First',
        tenantSlug: 'first-tenant',
        tenantName: 'First',
        bootstrapToken: 'x',
      }),
    });

    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'second@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Second',
        tenantSlug: 'second-tenant',
        tenantName: 'Second',
        bootstrapToken: 'x',
      }),
    });
    expect(res.status).toBe(410);
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    const last = await latestAuditOutcome(fx.db);
    expect(last).toEqual({ action: 'auth.register', outcome: 'gone' });
  });

  test('invalid body returns 400 + audit outcome=failure', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-valid' }),
    });
    expect(res.status).toBe(400);
    const after = await countAuditEvents(fx.db);
    expect(after - before).toBe(1);
    const last = await latestAuditOutcome(fx.db);
    expect(last).toEqual({ action: 'auth.register', outcome: 'failure' });
  });
});
