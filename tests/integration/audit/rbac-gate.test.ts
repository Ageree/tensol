// Sprint 4 A15 / A15b — RBAC gate on GET /api/v1/audit-events.
//
// Per A15:
//   - auditor + tenant_admin → 200 (covered by read-api.test.ts).
//   - operator / developer / security_lead / viewer → 403 + rbac.deny audit row.
//   - platform_admin → 403 (Q-4 / NQ-D defers cross-tenant view to Phase 9).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
} from '../db/helpers/db-fixture.ts';

const denyingRoles = [
  'operator',
  'developer',
  'security_lead',
  'viewer',
  'platform_admin',
] as const;
const allowingRoles = ['auditor', 'tenant_admin'] as const;

describe.skipIf(!hasDatabaseUrl())(
  'audit :: RBAC gate on GET /api/v1/audit-events (A15/A15b)',
  () => {
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

    for (const role of allowingRoles) {
      test(`A15b: ${role} → 200`, async () => {
        const session = await seedLoggedInUser(auth, {
          tenantSlug: `t-${role}-allow`,
          email: `${role}@x.io`,
          role,
        });
        const res = await auth.app.request('/api/v1/audit-events', {
          headers: { cookie: session.cookieHeader },
        });
        expect(res.status).toBe(200);
      });
    }

    for (const role of denyingRoles) {
      test(`A15b: ${role} → 403 + 1 rbac.deny audit row`, async () => {
        const session = await seedLoggedInUser(auth, {
          tenantSlug: `t-${role}-deny`,
          email: `${role}@x.io`,
          role,
        });
        const before = await fx.db
          .selectFrom('audit_events')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('action', '=', 'rbac.deny')
          .where('tenant_id', '=', session.tenantId)
          .executeTakeFirstOrThrow();

        const res = await auth.app.request('/api/v1/audit-events', {
          headers: { cookie: session.cookieHeader },
        });
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('{"error":"forbidden"}');

        const after = await fx.db
          .selectFrom('audit_events')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('action', '=', 'rbac.deny')
          .where('tenant_id', '=', session.tenantId)
          .executeTakeFirstOrThrow();
        expect(Number(after.count) - Number(before.count)).toBe(1);

        const row = await fx.db
          .selectFrom('audit_events')
          .selectAll()
          .where('action', '=', 'rbac.deny')
          .where('tenant_id', '=', session.tenantId)
          .orderBy('occurred_at', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow();
        const after_state = row.after_state as { outcome: string };
        expect(after_state.outcome).toBe('forbidden');
        expect(row.resource_type).toBe('audit_log');
      });
    }
  },
);
