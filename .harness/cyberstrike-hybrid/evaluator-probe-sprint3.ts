/**
 * Evaluator-authored verification probes for Sprint 3.
 * Independent of Generator's tests. Run with:
 *   DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike \
 *   bun .harness/cyberstrike-hybrid/evaluator-probe-sprint3.ts
 *
 * Covers (orthogonal to generator's own integration tests):
 *   C18c — response body for cross-tenant 403 contains NO UUIDs
 *   C19  — cookie name flips between cs_session (local) and __Host-cs_session (non-local)
 *   C22  — login canonical-401 oracle test: invalid credentials and valid+MFA-required
 *           paths return DIFFERENT shapes, but invalid-credentials NEVER returns
 *           pre_auth_token; the oracle must not leak whether MFA is enrolled when
 *           credentials are wrong
 *   C22  — pre-auth-token replay: same token used twice → second attempt rejected
 *   C26  — password-reset latency variance: hit vs miss path < 50ms p95 over 50 iter
 *   C28a — no cookie → 401
 *   C28d — cross-tenant resource → 403 (sanity check, body-shape verified by C18c)
 *   ADR0003 — verbatim production-encryption + per-process LRU lines exist
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type AuthApiConfig,
  PLATFORM_TENANT_SLUG,
  buildClearCookieHeader,
  buildSetCookieHeader,
  resetPlatformTenantCache,
} from '@cyberstrike/api';
import { createHmac, randomBytes } from 'node:crypto';
import { hashPassword } from '@cyberstrike/authz';

// RFC 4648 base32 encode (lowercase) — matches otplib default for TOTP secret format.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Encode = (buf: Buffer): string => {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
};
const base32Decode = (s: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

const generateTotpSecret = (): string => base32Encode(randomBytes(20));
const generateTotpCode = (secret: string, stepSeconds = 30, digits = 6): string => {
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const lastByte = hmac[hmac.length - 1] ?? 0;
  const offset = lastByte & 0xf;
  const b0 = hmac[offset] ?? 0;
  const b1 = hmac[offset + 1] ?? 0;
  const b2 = hmac[offset + 2] ?? 0;
  const b3 = hmac[offset + 3] ?? 0;
  const code = ((b0 & 0x7f) << 24) | (b1 << 16) | (b2 << 8) | b3;
  return String(code % 10 ** digits).padStart(digits, '0');
};
import { createDatabase } from '@cyberstrike/db';
import {
  TEST_COOKIE_NAME,
  buildAuthApp,
  seedLoggedInUser,
} from '../../tests/integration/auth/helpers/auth-fixture.ts';
import { seedMfaSecret, seedTenant, seedUser } from '../../tests/integration/db/helpers/db-fixture.ts';
import { SessionRepo } from '@cyberstrike/api';

const _here = fileURLToPath(new URL('.', import.meta.url));

let failures = 0;
const log = (label: string, pass: boolean, detail = '') => {
  const tag = pass ? 'PASS' : 'FAIL';
  if (!pass) failures++;
  console.log(`${tag}  ${label}${detail ? ' — ' + detail : ''}`);
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL required');
  process.exit(2);
}

const db = createDatabase({ url: databaseUrl });
resetPlatformTenantCache();

// Clean slate for any test data left by prior runs.
await db
  .deleteFrom('user_sessions')
  .where('id', 'is not', null)
  .execute()
  .catch(() => undefined);
await db
  .deleteFrom('users')
  .where('email', 'like', 'evaluator-probe-%')
  .execute()
  .catch(() => undefined);
// Pre-cleanup any prior partial test data.
const slugLike = 'evaluator-probe-%';
const oldTenantIds = await db
  .selectFrom('tenants')
  .select('id')
  .where('slug', 'like', slugLike)
  .execute()
  .catch(() => [] as { id: string }[]);
const oldIds = oldTenantIds.map((r) => r.id);
if (oldIds.length > 0) {
  await db.deleteFrom('user_sessions').where('tenant_id', 'in', oldIds).execute().catch(() => undefined);
  await db.deleteFrom('mfa_secrets').where('tenant_id', 'in', oldIds).execute().catch(() => undefined);
  await db.deleteFrom('projects').where('tenant_id', 'in', oldIds).execute().catch(() => undefined);
  await db.deleteFrom('users').where('tenant_id', 'in', oldIds).execute().catch(() => undefined);
}
await db.deleteFrom('tenants').where('slug', 'like', slugLike).execute().catch(() => undefined);

const auth = buildAuthApp(db);
const fixture = { db, hasher: auth.hasher, totp: auth.totp, sessionRepo: auth.sessionRepo, app: auth.app, preAuthStore: auth.preAuthStore, rateLimiter: auth.rateLimiter, config: auth.config };

// =====================================================
// ADR — verbatim text presence
// =====================================================
const adrPath = fileURLToPath(new URL('../../docs/adr/0003-mfa-secret-encryption.md', import.meta.url));
const adrText = readFileSync(adrPath, 'utf8');
log(
  'ADR0003.production-encryption: §Decision contains "MUST be encrypted with a per-tenant key"',
  /MUST be encrypted with a per-tenant key/.test(adrText),
);
log(
  'ADR0003.kms: text references KMS-rooted master',
  /KMS-rooted master/i.test(adrText),
);
log(
  'ADR0003.limitations: enumerates all 3 per-process LRUs',
  /TOTP-replay LRU is per-process/.test(adrText) &&
    /Pre-auth-token LRU is per-process/.test(adrText) &&
    /Rate-limit token bucket is per-process/.test(adrText),
);
log(
  'ADR0003.sprint7-fix-path: text mentions Sprint 7',
  /Sprint 7/.test(adrText),
);

// =====================================================
// C19 — cookie name flips between local and non-local
// =====================================================
{
  const exp = new Date(Date.now() + 3600 * 1000);
  const localHeader = buildSetCookieHeader({ name: 'cs_session', secure: false }, 'abc', exp);
  const stagingHeader = buildSetCookieHeader({ name: '__Host-cs_session', secure: true }, 'abc', exp);
  log(
    'C19.local: plain cs_session, no Secure flag',
    localHeader.startsWith('cs_session=abc') && !/;\s*Secure/.test(localHeader),
    localHeader,
  );
  log(
    'C19.non-local: __Host- prefix + HttpOnly + Secure + Path=/ + SameSite=Lax',
    stagingHeader.startsWith('__Host-cs_session=abc') &&
      /;\s*HttpOnly/i.test(stagingHeader) &&
      /;\s*Secure/i.test(stagingHeader) &&
      /;\s*Path=\//i.test(stagingHeader) &&
      /;\s*SameSite=Lax/i.test(stagingHeader),
    stagingHeader,
  );
  log(
    'C19.clear-cookie: includes Max-Age=0',
    buildClearCookieHeader({ name: 'cs_session', secure: false }).includes('Max-Age=0'),
  );
}

// =====================================================
// Set up two tenants + bootstrap admin for C22 / C28 / C18c
// =====================================================
// seedLoggedInUser creates tenant + user + session in one call. T1 first.
const t1NoMfaLogin = await seedLoggedInUser(fixture, {
  tenantSlug: 'evaluator-probe-t1-' + Date.now(),
  email: 'evaluator-probe-t1-nomfa@x.test',
  password: 'correctpass1234',
  role: 'tenant_admin',
});
const t1Id = t1NoMfaLogin.tenantId;
const userT1NoMfaId = t1NoMfaLogin.userId;
const t1 = { id: t1Id };

// MFA-enrolled user lives in the SAME T1 tenant — use seedUser directly.
const userT1MfaId = await seedUser(fixture, t1Id, {
  email: 'evaluator-probe-t1-mfa@x.test',
  role: 'tenant_admin',
});
await db
  .updateTable('users')
  .set({ password_hash: await auth.hasher.hash('correctpass1234') })
  .where('id', '=', userT1MfaId)
  .execute();
const totpSecret = generateTotpSecret();
await seedMfaSecret(fixture, { tenantId: t1Id, userId: userT1MfaId, secretEncrypted: totpSecret, enrolledAt: new Date() });

// T2 for cross-tenant check.
const t2Login = await seedLoggedInUser(fixture, {
  tenantSlug: 'evaluator-probe-t2-' + Date.now(),
  email: 'evaluator-probe-t2@x.test',
  password: 'correctpass1234',
  role: 'tenant_admin',
});
const t2Id = t2Login.tenantId;
const userT2Id = t2Login.userId;
const t2 = { id: t2Id };

// Insert one project owned by T1
const projectT1Id = crypto.randomUUID();
await db
  .insertInto('projects')
  .values({
    id: projectT1Id,
    tenant_id: t1.id,
    name: 'T1 project ' + Date.now(),
    description: '',
    status: 'active',
  })
  .execute();

// =====================================================
// C22 — canonical 401 oracle test
// =====================================================
const post = (path: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
  auth.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

{
  // (a) Invalid credentials, no MFA user
  const r1 = await post('/auth/login', {
    email: 'evaluator-probe-t1-nomfa@x.test',
    password: 'WRONG',
  });
  const b1 = await r1.json().catch(() => ({}));

  // (b) Invalid credentials against an EXISTING MFA-enrolled user (different password)
  const r2 = await post('/auth/login', {
    email: 'evaluator-probe-t1-mfa@x.test',
    password: 'WRONG',
  });
  const b2 = await r2.json().catch(() => ({}));

  // (c) Invalid credentials against a NON-EXISTENT user
  const r3 = await post('/auth/login', {
    email: 'evaluator-probe-nosuch@x.test',
    password: 'WRONG',
  });
  const b3 = await r3.json().catch(() => ({}));

  log(
    'C22.oracle-a: invalid pw on nomfa user → 401 + invalid_credentials, NO pre_auth_token in body',
    r1.status === 401 && b1.error === 'invalid_credentials' && !('pre_auth_token' in b1),
    JSON.stringify(b1),
  );
  log(
    'C22.oracle-b: invalid pw on MFA-enrolled user → 401 + invalid_credentials, NO pre_auth_token in body',
    r2.status === 401 && b2.error === 'invalid_credentials' && !('pre_auth_token' in b2),
    JSON.stringify(b2),
  );
  log(
    'C22.oracle-c: invalid pw on non-existent user → 401 + invalid_credentials',
    r3.status === 401 && b3.error === 'invalid_credentials',
    JSON.stringify(b3),
  );
  log(
    'C22.oracle-shape: all 3 invalid-credential responses have IDENTICAL body shape',
    JSON.stringify(b1) === JSON.stringify(b2) && JSON.stringify(b2) === JSON.stringify(b3),
  );
}

// =====================================================
// C22 — valid creds + MFA-enrolled returns pre_auth_token (different shape)
// =====================================================
let preAuthTok: string | undefined;
{
  const r = await post('/auth/login', {
    email: 'evaluator-probe-t1-mfa@x.test',
    password: 'correctpass1234',
  });
  const body = await r.json().catch(() => ({}));
  preAuthTok = body.pre_auth_token;
  log(
    'C22.mfa-required: valid creds + MFA-enrolled → 401 with pre_auth_token (no user identity)',
    r.status === 401 &&
      typeof preAuthTok === 'string' &&
      preAuthTok.length >= 32 &&
      typeof body.expires_in === 'number' &&
      !('user_id' in body) &&
      !('email' in body),
    JSON.stringify(body).slice(0, 100),
  );
}

// =====================================================
// C22 — pre-auth-token single-use (replay rejected)
// =====================================================
if (preAuthTok) {
  const code = generateTotpCode(totpSecret);
  const r1 = await post('/auth/login/mfa', { pre_auth_token: preAuthTok, mfa_code: code });
  const b1 = await r1.json().catch(() => ({}));
  log(
    'C22.mfa-step2-success: valid pre_auth_token + valid TOTP → 200 + actor',
    r1.status === 200 && b1.actor && b1.actor.tenantId === t1.id,
    JSON.stringify(b1).slice(0, 100),
  );

  // Replay
  const r2 = await post('/auth/login/mfa', { pre_auth_token: preAuthTok, mfa_code: code });
  const b2 = await r2.json().catch(() => ({}));
  log(
    'C22.mfa-step2-replay: same pre_auth_token reused → 401 invalid_credentials (canonical shape)',
    r2.status === 401 && b2.error === 'invalid_credentials' && !('pre_auth_token' in b2),
    JSON.stringify(b2),
  );
}

// =====================================================
// C28a — no cookie → 401
// =====================================================
{
  const r = await auth.app.request(`/_test/resource/${projectT1Id}`);
  log('C28a.no-cookie: GET /_test/resource → 401', r.status === 401);
}

// =====================================================
// C28d + C18c — cross-tenant resource → 403, response has NO UUIDs
// =====================================================
{
  // Use the cookieHeader produced by seedLoggedInUser for T2.
  const r = await auth.app.request(`/_test/resource/${projectT1Id}`, {
    headers: { cookie: t2Login.cookieHeader },
  });
  const bodyText = await r.text();
  const uuidMatches =
    bodyText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  log(
    'C28d.cross-tenant: T2 cookie + T1 project → 403',
    r.status === 403,
    `body=${bodyText.slice(0, 80)}`,
  );
  log(
    'C18c.uuid-leak: 403 response body contains ZERO UUIDs',
    uuidMatches.length === 0,
    `matches=${uuidMatches.length}`,
  );
}

// =====================================================
// C28e — positive control: T1 cookie + T1 project → 200
// =====================================================
{
  const r = await auth.app.request(`/_test/resource/${projectT1Id}`, {
    headers: { cookie: t1NoMfaLogin.cookieHeader },
  });
  log(
    'C28e.positive: T1 cookie + T1 project → 200',
    r.status === 200,
    `status=${r.status}`,
  );
}

// =====================================================
// C26 — password-reset latency variance hit vs miss < 50ms p95
// =====================================================
{
  const measure = async (email: string): Promise<number> => {
    const t0 = performance.now();
    await post('/auth/password/reset/request', { email });
    return performance.now() - t0;
  };

  const N = 30; // 30 each side; orthogonal to gen's 100
  const hitTimes: number[] = [];
  const missTimes: number[] = [];
  // warm up
  await measure('evaluator-probe-t1-nomfa@x.test');
  await measure('evaluator-probe-nosuch@x.test');
  for (let i = 0; i < N; i++) {
    hitTimes.push(await measure('evaluator-probe-t1-nomfa@x.test'));
    missTimes.push(await measure('evaluator-probe-nosuch@x.test'));
  }
  const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
  const hitP95 = p95(hitTimes);
  const missP95 = p95(missTimes);
  const delta = Math.abs(hitP95 - missP95);
  log(
    `C26.latency: |hit_p95 - miss_p95| < 50ms (hit=${hitP95.toFixed(1)}ms, miss=${missP95.toFixed(1)}ms, delta=${delta.toFixed(1)}ms)`,
    delta < 50,
  );
}

// =====================================================
// Cleanup
// =====================================================
// Cleanup: drop sessions/projects/users; tenants stay (other suites may have data).
await db.deleteFrom('user_sessions').where('user_id', 'in', [userT1NoMfaId, userT1MfaId, userT2Id]).execute().catch(() => undefined);
await db.deleteFrom('mfa_secrets').where('user_id', '=', userT1MfaId).execute().catch(() => undefined);
await db.deleteFrom('projects').where('id', '=', projectT1Id).execute().catch(() => undefined);
await db.deleteFrom('users').where('id', 'in', [userT1NoMfaId, userT1MfaId, userT2Id]).execute().catch(() => undefined);
await db.deleteFrom('tenants').where('id', 'in', [t1.id, t2.id, t1Id, t2Id]).execute().catch(() => undefined);
await db.destroy();

console.log(`=== ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
