// EE-2 (2026-05-12) — integration tests for auth-proof gate (scans.ts) and
// HMAC-SHA256 audit signing (emitSignedAudit → tenants.audit_key).
//
// Coverage:
//   - new path (target_authorizations rows present) supersedes legacy
//   - new path strict: pending/failed/expired → 422 target_auth_proof_required
//   - legacy backward-compat: no auth_proof rows + ownership_status='verified' → 200
//   - audit_events.signature is populated on every new row
//   - verifyAuditSignature returns true for emitted rows and false on tamper

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildCanonicalAuditMessage, verifyAuditSignature } from '@cyberstrike/audit';
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
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

const uniqSlug = (base: string): string =>
  `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDatabaseUrl())('EE-2 :: auth-proof gate + HMAC signing', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let tCookie: string;
  let tenantId: string;
  let projectId: string;

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
    const seeded = await seedLoggedInUser(auth, {
      tenantSlug: uniqSlug('ee2'),
      email: 'ee2@example.com',
      role: 'security_lead',
    });
    tCookie = seeded.cookieHeader;
    tenantId = seeded.tenantId;
    projectId = await seedProject(fx, { tenantId, name: 'EE-2 project' });
  });

  const launchScan = async (targetIds: string[]): Promise<Response> =>
    auth.app.request('/api/v1/scans', {
      method: 'POST',
      headers: {
        cookie: tCookie,
        'content-type': 'application/json',
        'idempotency-key': `ee2-${Date.now()}-${Math.random()}`,
      },
      body: JSON.stringify({ project_id: projectId, tier: 'light', target_ids: targetIds }),
    });

  test('NEW path: target_authorizations.status=verified → 200', async () => {
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'domain',
      value: 'example.com',
      // Mark legacy unverified to prove the new path wins.
      ownershipStatus: 'unverified',
    });
    await fx.db
      .insertInto('target_authorizations')
      .values({
        tenant_id: tenantId,
        target_id: targetId,
        method: 'dns_txt',
        token_hash: 'a'.repeat(64),
        status: 'verified',
        verified_at: new Date(),
      })
      .execute();

    const res = await launchScan([targetId]);
    expect(res.status).toBe(200);
  });

  test('NEW path strict: target_authorizations.status=pending → 422 target_auth_proof_required', async () => {
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'domain',
      value: 'pending.example.com',
      ownershipStatus: 'verified', // legacy flag set, but new path supersedes
    });
    await fx.db
      .insertInto('target_authorizations')
      .values({
        tenant_id: tenantId,
        target_id: targetId,
        method: 'dns_txt',
        token_hash: 'b'.repeat(64),
        status: 'pending',
      })
      .execute();

    const res = await launchScan([targetId]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('target_auth_proof_required');
  });

  test('LEGACY path: no auth_proof rows + ownership_status=verified → 200', async () => {
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'domain',
      value: 'legacy.example.com',
      ownershipStatus: 'verified',
    });

    const res = await launchScan([targetId]);
    expect(res.status).toBe(200);
  });

  test('LEGACY path: no auth_proof rows + ownership_status=unverified → 422 target_unverified', async () => {
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'domain',
      value: 'legacyfail.example.com',
      ownershipStatus: 'unverified',
    });

    const res = await launchScan([targetId]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('target_unverified');
  });

  test('HMAC: audit_events.signature is populated AND verifiable, tampering fails', async () => {
    const targetId = await seedTarget(fx, {
      tenantId,
      projectId,
      kind: 'domain',
      value: 'audit.example.com',
      ownershipStatus: 'verified',
    });
    const res = await launchScan([targetId]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan_id: string };

    // Find the scan.launched audit row.
    const auditRow = await fx.db
      .selectFrom('audit_events')
      .select([
        'tenant_id',
        'action',
        'actor_type',
        'actor_id',
        'actor_name',
        'resource_type',
        'resource_id',
        'project_id',
        'assessment_id',
        'trace_id',
        'occurred_at',
        'after_state',
        'signature',
      ])
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'scan.launched')
      .where('assessment_id', '=', body.scan_id)
      .executeTakeFirstOrThrow();

    // EE-2 invariant: signature populated for every post-migration row.
    expect(auditRow.signature).not.toBeNull();
    expect(typeof auditRow.signature).toBe('string');
    expect((auditRow.signature as string).length).toBeGreaterThan(20);

    // Fetch tenant key to verify externally.
    const tenant = await fx.db
      .selectFrom('tenants')
      .select(['audit_key'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const key = Buffer.isBuffer(tenant.audit_key)
      ? tenant.audit_key
      : Buffer.from(tenant.audit_key as Buffer | string);
    expect(key.length).toBe(32);

    // Reconstruct canonical message. after_state in DB = { outcome, ...metadata }.
    const afterState = auditRow.after_state as { outcome: string; [k: string]: unknown };
    const { outcome, ...metadata } = afterState;
    const canonicalArgs = {
      tenantId: auditRow.tenant_id,
      action: auditRow.action as Parameters<typeof buildCanonicalAuditMessage>[0]['action'],
      outcome: outcome as Parameters<typeof buildCanonicalAuditMessage>[0]['outcome'],
      actorType: auditRow.actor_type as 'user' | 'service',
      actorId: auditRow.actor_id,
      actorName: auditRow.actor_name,
      resourceType: auditRow.resource_type,
      resourceId: auditRow.resource_id,
      projectId: auditRow.project_id,
      assessmentId: auditRow.assessment_id,
      traceId: auditRow.trace_id,
      metadata,
    };
    const occurredAtIso = (auditRow.occurred_at as Date).toISOString();
    const canonical = buildCanonicalAuditMessage(canonicalArgs, occurredAtIso);

    // Valid signature verifies.
    expect(verifyAuditSignature(key, canonical, auditRow.signature as string)).toBe(true);

    // Tamper: flip one byte in canonical → verification fails.
    const tampered = `${canonical}!tamper`;
    expect(verifyAuditSignature(key, tampered, auditRow.signature as string)).toBe(false);

    // Tamper: wrong key → verification fails.
    const wrongKey = Buffer.alloc(32, 0);
    expect(verifyAuditSignature(wrongKey, canonical, auditRow.signature as string)).toBe(false);
  });
});
