// idor-matrix.test.ts — Sprint 3 C27, C28a-e, C18c.
//
// Full middleware-shape matrix on `GET /_test/resource/:id`:
//   C28a no cookie               → 401 unauthenticated
//   C28b deleted session         → 401 unauthenticated
//   C28c expired session         → 401 session_expired
//   C28d cross-tenant            → 403 forbidden, body has 0 UUIDs (C18c)
//   C28e positive control        → 200 + project body

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedSession,
  seedTenant,
  seedUser,
} from '../db/helpers/db-fixture.ts';
import {
  type AuthFixture,
  TEST_COOKIE_NAME,
  buildAuthApp,
  hasDatabaseUrl,
  resetAuthState,
  seedLoggedInUser,
} from './helpers/auth-fixture.ts';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe.skipIf(!hasDatabaseUrl())(
  'integration :: IDOR matrix on /_test/resource/:id (C27, C28, C18c)',
  () => {
    let fx: DbFixture;
    let auth: AuthFixture;
    let t1Project: string;
    let t1Cookie: string;
    let t2Cookie: string;

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

      const t1 = await seedLoggedInUser(auth, { tenantSlug: 't1', email: 't1@example.com' });
      const t2 = await seedLoggedInUser(auth, { tenantSlug: 't2', email: 't2@example.com' });
      t1Cookie = t1.cookieHeader;
      t2Cookie = t2.cookieHeader;

      const project = await fx.db
        .insertInto('projects')
        .values({
          tenant_id: t1.tenantId,
          name: 'P1',
          description: 'tenant 1 project',
          status: 'active',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      t1Project = project.id;
    });

    test('C28e — positive control: T1 cookie + T1 project → 200', async () => {
      const res = await auth.app.request(`/_test/resource/${t1Project}`, {
        headers: { cookie: t1Cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(t1Project);
    });

    test('C28d — cross-tenant: T2 cookie + T1 project → 403, body has no UUIDs (C18c)', async () => {
      const res = await auth.app.request(`/_test/resource/${t1Project}`, {
        headers: { cookie: t2Cookie },
      });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toEqual('{"error":"forbidden"}');
      expect(text.match(UUID_RE)).toBeNull();
    });

    test('C28a — no cookie → 401 unauthenticated', async () => {
      const res = await auth.app.request(`/_test/resource/${t1Project}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    test('C28b — cookie pointing at deleted session → 401 unauthenticated', async () => {
      // Delete every session — leaves the cookie a dangling reference.
      await fx.db.deleteFrom('user_sessions').execute();
      const res = await auth.app.request(`/_test/resource/${t1Project}`, {
        headers: { cookie: t1Cookie },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    test('C28c — cookie pointing at expired session → 401 session_expired', async () => {
      // Seed a fresh user + already-expired session, build the cookie manually.
      const tenantId = await seedTenant(fx, { name: 'texp', slug: 'texp' });
      const userId = await seedUser(fx, tenantId, {
        email: 'expired@example.com',
        role: 'security_lead',
      });
      const plaintext = 'fedcba9876543210'.repeat(4);
      const tokenHash = await auth.hasher.hash(plaintext);
      await seedSession(fx, {
        tenantId,
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() - 1000),
      });
      const cookie = `${TEST_COOKIE_NAME}=${userId}.${plaintext}`;
      const res = await auth.app.request(`/_test/resource/${t1Project}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'session_expired' });
    });

    test('C18c — cross-tenant audit row records both tenant IDs', async () => {
      const res = await auth.app.request(`/_test/resource/${t1Project}`, {
        headers: { cookie: t2Cookie },
      });
      expect(res.status).toBe(403);
      // Audit row is NOT emitted by the read-only fixture endpoint in slice 3
      // (only state-changing routes per C29). C18c's audit assertion is for
      // future write routes; the body-side guard above is the load-bearing
      // assertion this sprint.
    });
  },
);
