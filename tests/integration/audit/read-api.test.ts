// Sprint 4 A11/A12/A14/A15 — GET /api/v1/audit-events read API.
//
// Asserts:
//   - tenant isolation (T1 only sees T1 rows; T2 only sees T2; neither sees __platform__).
//   - strict zod query schema (R8) — unknown keys → 400 invalid_query.
//   - cursor determinism (R2) — opaque base64, ORDER BY occurred_at DESC,
//     id DESC, monotonically decreasing.
//   - IP / userAgent redaction (R1) — own-row full, other-row null.

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

interface ApiResponse {
  rows: Array<{
    id: string;
    actor: { type: string; id: string; name: string };
    action: string;
    resourceType: string;
    resourceId: string | null;
    outcome: string;
    traceId: string;
    occurredAt: string;
    ip: string | null;
    userAgent: string | null;
    metadata: Record<string, unknown> | null;
  }>;
  nextCursor: string | null;
}

const seedAuditRow = async (
  fx: DbFixture,
  args: {
    tenantId: string;
    actorType: 'user' | 'service';
    actorId: string;
    actorName: string;
    action: string;
    occurredAtMs?: number;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<string> => {
  const traceId = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  const insertRow: Record<string, unknown> = {
    tenant_id: args.tenantId,
    actor_type: args.actorType,
    actor_id: args.actorId,
    actor_name: args.actorName,
    action: args.action,
    resource_type: 'user',
    after_state: { outcome: 'success' },
    ip: args.ip ?? null,
    user_agent: args.userAgent ?? null,
    trace_id: traceId,
  };
  if (args.occurredAtMs !== undefined) {
    insertRow.occurred_at = new Date(args.occurredAtMs);
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped insert
  const row = await (fx.db as any)
    .insertInto('audit_events')
    .values(insertRow)
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id as string;
};

describe.skipIf(!hasDatabaseUrl())('audit :: GET /api/v1/audit-events (A11/A12/A14)', () => {
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

  test('A12: T1 cookie returns only T1 rows (tenant isolation)', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: 't1-iso',
      email: 't1@x.io',
      role: 'auditor',
    });
    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: 't2-iso',
      email: 't2@x.io',
      role: 'auditor',
    });

    await seedAuditRow(fx, {
      tenantId: t1.tenantId,
      actorType: 'user',
      actorId: t1.userId,
      actorName: 't1-row',
      action: 'auth.login.password',
    });
    await seedAuditRow(fx, {
      tenantId: t2.tenantId,
      actorType: 'user',
      actorId: t2.userId,
      actorName: 't2-row',
      action: 'auth.login.password',
    });

    const res = await auth.app.request('/api/v1/audit-events', {
      headers: { cookie: t1.cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse;
    for (const r of body.rows) {
      expect(r.actor.name).not.toBe('t2-row');
    }
  });

  test('A11: __platform__ rows excluded from per-tenant feed', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: 't1-sentinel',
      email: 't1@x.io',
      role: 'auditor',
    });

    // Force the sentinel tenant into existence by triggering an unauth path
    // (login on unknown email → handler calls ensurePlatformTenantId).
    await auth.app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'never-existed@x.io',
        password: 'whatever-fails',
      }),
    });

    const platformRow = await fx.db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', '__platform__')
      .executeTakeFirstOrThrow();

    await seedAuditRow(fx, {
      tenantId: platformRow.id,
      actorType: 'service',
      actorId: 'system',
      actorName: 'platform-marker',
      action: 'auth.login.password',
    });
    await seedAuditRow(fx, {
      tenantId: t1.tenantId,
      actorType: 'user',
      actorId: t1.userId,
      actorName: 't1-marker',
      action: 'auth.login.password',
    });

    const res = await auth.app.request('/api/v1/audit-events', {
      headers: { cookie: t1.cookieHeader },
    });
    const body = (await res.json()) as ApiResponse;
    for (const r of body.rows) {
      expect(r.actor.name).not.toBe('platform-marker');
    }
  });

  test('A14 R8: unknown query keys → 400 invalid_query', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: 't1-strict',
      email: 't1@x.io',
      role: 'auditor',
    });
    for (const bad of ['?action=foo', '?tenant_id=abc', '?actor_id=xyz', '?bogus=1']) {
      const res = await auth.app.request(`/api/v1/audit-events${bad}`, {
        headers: { cookie: t1.cookieHeader },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_query');
    }
  });

  test('A14 R2: cursor is opaque base64 + monotonically decreasing', async () => {
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: 't1-cursor',
      email: 't1@x.io',
      role: 'auditor',
    });

    const base = Date.now();
    const ids: string[] = [];
    // r1 < r2 < r3 by occurred_at; we expect r3, r2, r1 in that order.
    for (let i = 0; i < 3; i++) {
      const id = await seedAuditRow(fx, {
        tenantId: t1.tenantId,
        actorType: 'user',
        actorId: t1.userId,
        actorName: `cursor-${i}`,
        action: 'auth.login.password',
        occurredAtMs: base + i * 1000,
      });
      ids.push(id);
    }

    const r1Res = await auth.app.request('/api/v1/audit-events?limit=1', {
      headers: { cookie: t1.cookieHeader },
    });
    expect(r1Res.status).toBe(200);
    const r1 = (await r1Res.json()) as ApiResponse;
    expect(r1.rows).toHaveLength(1);
    expect(r1.rows[0]?.id).toBe(ids[2] as string); // newest first
    expect(r1.nextCursor).toMatch(/^[A-Za-z0-9+/=]+$/);

    const r1Cursor = r1.nextCursor as string;
    const r2Res = await auth.app.request(
      `/api/v1/audit-events?limit=1&cursor=${encodeURIComponent(r1Cursor)}`,
      { headers: { cookie: t1.cookieHeader } },
    );
    const r2 = (await r2Res.json()) as ApiResponse;
    expect(r2.rows[0]?.id).toBe(ids[1] as string);

    const r2Cursor = r2.nextCursor as string;
    const r3Res = await auth.app.request(
      `/api/v1/audit-events?limit=1&cursor=${encodeURIComponent(r2Cursor)}`,
      { headers: { cookie: t1.cookieHeader } },
    );
    const r3 = (await r3Res.json()) as ApiResponse;
    expect(r3.rows[0]?.id).toBe(ids[0] as string);
    expect(r3.nextCursor).toBeNull();
  });

  test('A14 R1: own-row full ip/UA, other-row null', async () => {
    const t1auditor = await seedLoggedInUser(auth, {
      tenantSlug: 't1-redact',
      email: 'auditor@x.io',
      role: 'auditor',
    });
    // Second user lives in the same tenant (NOT a separate slug — direct
    // INSERT to bypass the unique-slug constraint on tenants).
    const otherUserRow = await fx.db
      .insertInto('users')
      .values({
        tenant_id: t1auditor.tenantId,
        email: 'other-user@x.io',
        password_hash: 'placeholder',
        display_name: 'other',
        status: 'active',
        role: 'security_lead',
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await seedAuditRow(fx, {
      tenantId: t1auditor.tenantId,
      actorType: 'user',
      actorId: t1auditor.userId,
      actorName: 'auditor-self',
      action: 'auth.login.password',
      ip: '10.0.0.1',
      userAgent: 'curl/8.0',
    });
    await seedAuditRow(fx, {
      tenantId: t1auditor.tenantId,
      actorType: 'user',
      actorId: otherUserRow.id,
      actorName: 'other-user',
      action: 'auth.login.password',
      ip: '10.0.0.2',
      userAgent: 'firefox',
    });

    const res = await auth.app.request('/api/v1/audit-events?limit=100', {
      headers: { cookie: t1auditor.cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiResponse;
    const own = body.rows.find((r) => r.actor.name === 'auditor-self');
    const other = body.rows.find((r) => r.actor.name === 'other-user');
    expect(own).toBeDefined();
    expect(other).toBeDefined();
    expect(own?.ip).toBe('10.0.0.1');
    expect(own?.userAgent).toBe('curl/8.0');
    expect(other?.ip).toBeNull();
    expect(other?.userAgent).toBeNull();
  });
});
