// Sprint 17 — Credentials API integration tests (A-17-Credentials*).
//
// Coverage:
//   A-17-CredentialsList          — list 200 + auth.credential.read.viewed audited
//   A-17-CredentialsNoBlob        — 5x not.toHaveProperty (B6 mandatory gate)
//   A-17-CredentialsList403       — viewer role → 403
//   A-17-CredentialsListCrossTenant — T2 cookie on T1 target → 403 or 404

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encryptCredential, parseKek } from '@cyberstrike/browser-auth';
import { insertTargetCredential } from '@cyberstrike/db';
import {
  type AuthFixture,
  buildAuthApp,
  countAuditEvents,
  hasDatabaseUrl,
  latestAuditOutcome,
  resetAuthState,
  seedExtraLoggedInUser,
  seedLoggedInUser,
} from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

const TEST_KEK = parseKek('f'.repeat(64));

describe.skipIf(skip)('integration :: credentials API (A-17-Credentials*)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1TenantId: string;
  let t1UserId: string;
  let t1Cookie: string;
  let t1TargetId: string;
  let t2Cookie: string;

  const uniqSlug = (base: string) =>
    `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t1'),
      email: 't1@example.com',
      role: 'security_lead',
    });
    t1TenantId = t1.tenantId;
    t1UserId = t1.userId;
    t1Cookie = t1.cookieHeader;

    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('t2'),
      email: 't2@example.com',
      role: 'security_lead',
    });
    t2Cookie = t2.cookieHeader;

    const projectId = await seedProject(fx, { tenantId: t1TenantId, name: 'Cred-Project' });
    t1TargetId = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      value: 'https://target.example.com',
    });
  });

  test('A-17-CredentialsList — insert credential → GET → 200 + audit emitted', async () => {
    const blob = encryptCredential(JSON.stringify({ username: 'u', password: 'p' }), TEST_KEK);
    await insertTargetCredential({
      db: fx.db,
      tenantId: t1TenantId,
      targetId: t1TargetId,
      recipeId: '00000000-0000-4000-8000-000000000002',
      encryptedBlob: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      createdBy: t1UserId,
      name: 'test-cred',
    });

    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/targets/${t1TargetId}/credentials`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: unknown[]; total: number };
    expect(body.credentials).toHaveLength(1);
    expect(body.total).toBe(1);

    const after = await countAuditEvents(fx.db);
    expect(after).toBeGreaterThan(before);
    const latest = await latestAuditOutcome(fx.db);
    expect(latest?.action).toBe('auth.credential.read.viewed');
    expect(latest?.outcome).toBe('success');
  });

  test('A-17-CredentialsNoBlob — response must not contain encrypted fields', async () => {
    const blob = encryptCredential(JSON.stringify({ username: 'u', password: 'p' }), TEST_KEK);
    await insertTargetCredential({
      db: fx.db,
      tenantId: t1TenantId,
      targetId: t1TargetId,
      recipeId: '00000000-0000-4000-8000-000000000002',
      encryptedBlob: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      createdBy: t1UserId,
      name: 'blob-check',
    });

    const res = await auth.app.request(`/api/v1/targets/${t1TargetId}/credentials`, {
      headers: { Cookie: t1Cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown>[] };
    const cred = body.credentials[0];
    expect(cred).not.toHaveProperty('encrypted_blob');
    expect(cred).not.toHaveProperty('encryptedBlob');
    expect(cred).not.toHaveProperty('iv');
    expect(cred).not.toHaveProperty('auth_tag');
    expect(cred).not.toHaveProperty('authTag');
  });

  test('A-17-CredentialsList403 — viewer role → 403', async () => {
    const viewer = await seedExtraLoggedInUser(auth, {
      tenantId: t1TenantId,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const res = await auth.app.request(`/api/v1/targets/${t1TargetId}/credentials`, {
      headers: { Cookie: viewer.cookieHeader },
    });
    expect(res.status).toBe(403);
  });

  test('A-17-CredentialsListCrossTenant — T2 cookie on T1 target → 403 or 404', async () => {
    const res = await auth.app.request(`/api/v1/targets/${t1TargetId}/credentials`, {
      headers: { Cookie: t2Cookie },
    });
    expect([403, 404]).toContain(res.status);
  });
});
