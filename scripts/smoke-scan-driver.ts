// First-smoke scan driver (2026-05-12).
// Seeds tenant/user/project/target directly in DB (skipping HTTP auth flow
// which is well-tested elsewhere), then drives the scan via POST /scans
// against running Tensol API. Uses the same SessionRepo pattern as
// tests/integration/auth/helpers/auth-fixture.ts:seedLoggedInUser.

import { createBcryptHasher } from '@cyberstrike/authz';
import { createDatabase } from '@cyberstrike/db';
import { sql } from 'kysely';
import { SessionRepo } from '../apps/api/src/session-repo.ts';

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://cs:cs@localhost:5433/cyberstrike';
const API = process.env['TENSOL_API'] ?? 'http://localhost:8081';
const TIER = (process.env['SMOKE_TIER'] ?? 'light') as 'light' | 'medium' | 'aggressive';
const TARGET_VALUE = process.env['SMOKE_TARGET'] ?? 'example.com';
const TARGET_KIND = (process.env['SMOKE_TARGET_KIND'] ?? 'domain') as 'domain' | 'url' | 'ip';

const newUuid = (): string => crypto.randomUUID();
const log = (label: string, value: unknown): void => {
  console.warn(`[${label}] ${typeof value === 'object' ? JSON.stringify(value) : value}`);
};

const main = async (): Promise<void> => {
  const db = createDatabase({ url: DB_URL });
  const hasher = createBcryptHasher({ cost: 4 });
  const sessionRepo = new SessionRepo(db, { hasher });

  const tenantSlug = `smoke-${Date.now()}`;
  const email = `smoke-${Date.now()}@tensol.local`;
  const password = 'correct-horse-battery-staple';

  // 1. Tenant.
  const tenantId = newUuid();
  await db
    .insertInto('tenants')
    .values({ id: tenantId, name: tenantSlug, slug: tenantSlug, status: 'active' })
    .execute();
  log('tenant', tenantId);

  // 2. User (security_lead role, password hashed).
  const passwordHash = await hasher.hash(password);
  const userId = newUuid();
  await db
    .insertInto('users')
    .values({
      id: userId,
      tenant_id: tenantId,
      email,
      display_name: email,
      status: 'active',
      role: 'security_lead',
      password_hash: passwordHash,
    })
    .execute();
  log('user', userId);

  // 3. Session via SessionRepo (mirrors seedLoggedInUser).
  const plaintext = '0123456789abcdef'.repeat(4);
  await sessionRepo.issue({
    tenantId,
    userId,
    plaintext,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const cookieValue = SessionRepo.formatCookieValue(userId, plaintext);
  const cookieHeader = `cs_session=${cookieValue}`;
  log('cookie', cookieHeader.slice(0, 40) + '...');

  // 4. Project.
  const projectId = newUuid();
  await db
    .insertInto('projects')
    .values({
      id: projectId,
      tenant_id: tenantId,
      name: 'First smoke scan',
      status: 'active',
    })
    .execute();
  log('project', projectId);

  // 5. Target with ownership_status='verified' (bypass auth-proof for smoke).
  const targetId = newUuid();
  await db
    .insertInto('targets')
    .values({
      id: targetId,
      tenant_id: tenantId,
      project_id: projectId,
      kind: TARGET_KIND,
      value: TARGET_VALUE,
      ownership_status: 'verified',
    })
    .execute();
  log('target', `${targetId} (${TARGET_KIND}:${TARGET_VALUE})`);

  // 6. Sanity: hit /auth/me to confirm session cookie is accepted.
  const meRes = await fetch(`${API}/auth/me`, { headers: { cookie: cookieHeader } });
  log('me-status', meRes.status);
  log('me-body', await meRes.text());

  // 7. POST /api/v1/scans.
  const idemKey = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scanRes = await fetch(`${API}/api/v1/scans`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
      'idempotency-key': idemKey,
    },
    body: JSON.stringify({ project_id: projectId, tier: TIER, target_ids: [targetId] }),
  });
  const scanBody = await scanRes.json();
  log('scan-status', scanRes.status);
  log('scan-body', scanBody);

  if (scanRes.status !== 200) {
    await db.destroy();
    process.exit(1);
  }
  const scanId = (scanBody as { scan_id: string }).scan_id;

  // Emit a small marker on stdout for downstream scripts to grab the scan_id.
  console.log(JSON.stringify({ scanId, tenantId, projectId, targetId, cookieHeader }));

  await db.destroy();
};

await main();
