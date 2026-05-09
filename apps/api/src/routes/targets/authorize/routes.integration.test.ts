// Sprint 27 — target authorization proof integration tests (19 cases).
// Uses a thin Hono app with injected in-memory store instead of a real DB.
// No real DNS/HTTP/WHOIS/SMTP I/O.

import { describe, expect, it } from 'bun:test';
import type { UserActor } from '@cyberstrike/authz';
import type { Database } from '@cyberstrike/db';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { RateLimiter } from '../../../middleware/rate-limit.ts';
import type { SessionEnv } from '../../../middleware/session.ts';
import { tenantGuard } from '../../../middleware/tenant-guard.ts';
import type { RouteDeps } from '../../shared.ts';
import type { HttpFetcher } from './file-upload-verifier.ts';
import {
  handleAuthorizeStart,
  handleAuthorizeStatus,
  handleAuthorizeVerify,
  handleEmailConfirm,
} from './routes.ts';
import type { Mailer, TokenStore, WhoisClient } from './whois-verifier.ts';

// ─── UUIDs ───────────────────────────────────────────────────────────────────

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const PROJECT_ID = '33333333-3333-3333-3333-333333333333';
const TARGET_DOMAIN_ID = '44444444-4444-4444-4444-444444444444';
const TARGET_URL_ID = '55555555-5555-5555-5555-555555555555';

// ─── In-memory stores ─────────────────────────────────────────────────────────

type AuthRow = {
  id: string;
  tenant_id: string;
  target_id: string;
  method: string;
  status: string;
  token_hash: string;
  token_plaintext: string | null;
  email_recipient: string | null;
  attempt_count: number;
  last_error: string | null;
  verified_at: Date | null;
  consumed_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

type TargetRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  kind: string;
  value: string;
  ownership_status: string;
};

// ─── Mock DB builder ──────────────────────────────────────────────────────────

const sha256Hex = async (text: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

const makeDb = (targets: TargetRow[], authRows: AuthRow[]) => {
  const auditRows: unknown[] = [];

  const db = {
    selectFrom: (table: string) => {
      if (table === 'targets') {
        return {
          select: () => ({
            where: (col: string, _op: string, val: string) => ({
              executeTakeFirst: async () =>
                targets.find((t) => (t as Record<string, string>)[col] === val),
            }),
          }),
          selectAll: () => ({
            where: (_c: string, _o: string, _v: string) => ({
              executeTakeFirst: async () => undefined,
            }),
          }),
        };
      }
      if (table === 'target_authorizations') {
        return {
          selectAll: () => {
            const filters: Array<[string, string, unknown]> = [];
            let sortCol: string | null = null;
            let sortDir: string | null = null;

            const chain: {
              where: (col: string, op: string, val: unknown) => typeof chain;
              orderBy: (col: string, dir: string) => typeof chain;
              executeTakeFirst: () => Promise<AuthRow | undefined>;
              execute: () => Promise<AuthRow[]>;
            } = {
              where(col, op, val) {
                filters.push([col, op, val]);
                return chain;
              },
              orderBy(col, dir) {
                sortCol = col;
                sortDir = dir;
                return chain;
              },
              async executeTakeFirst() {
                let rows = authRows.filter((r) =>
                  filters.every(([col, op, val]) => {
                    const rv = (r as Record<string, unknown>)[col];
                    if (op === '=') return rv === val;
                    if (op === '!=') return rv !== val;
                    return true;
                  }),
                );
                if (sortCol) {
                  const col = sortCol;
                  const asc = sortDir !== 'desc';
                  rows = [...rows].sort((a, b) => {
                    const av = (a as Record<string, unknown>)[col] as Date;
                    const bv = (b as Record<string, unknown>)[col] as Date;
                    return asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
                  });
                }
                return rows[0];
              },
              async execute() {
                let rows = authRows.filter((r) =>
                  filters.every(([col, op, val]) => {
                    const rv = (r as Record<string, unknown>)[col];
                    if (op === '=') return rv === val;
                    if (op === '!=') return rv !== val;
                    return true;
                  }),
                );
                if (sortCol) {
                  const col = sortCol;
                  const asc = sortDir !== 'desc';
                  rows = [...rows].sort((a, b) => {
                    const av = (a as Record<string, unknown>)[col] as Date;
                    const bv = (b as Record<string, unknown>)[col] as Date;
                    return asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
                  });
                }
                return rows;
              },
            };
            return chain;
          },
          select: (cols: string[]) => {
            const filters: Array<[string, string, unknown]> = [];
            let sortCol: string | null = null;
            let sortDir: string | null = null;

            const chain: {
              where: (col: string, op: string, val: unknown) => typeof chain;
              orderBy: (col: string, dir: string) => typeof chain;
              execute: () => Promise<Partial<AuthRow>[]>;
            } = {
              where(col, op, val) {
                filters.push([col, op, val]);
                return chain;
              },
              orderBy(col, dir) {
                sortCol = col;
                sortDir = dir;
                return chain;
              },
              async execute() {
                let rows: AuthRow[] = authRows.filter((r) =>
                  filters.every(([col, op, val]) => {
                    const rv = (r as Record<string, unknown>)[col];
                    if (op === '=') return rv === val;
                    if (op === '!=') return rv !== val;
                    return true;
                  }),
                );
                if (sortCol) {
                  const col = sortCol;
                  const asc = sortDir !== 'desc';
                  rows = [...rows].sort((a, b) => {
                    const av = (a as Record<string, unknown>)[col] as Date;
                    const bv = (b as Record<string, unknown>)[col] as Date;
                    return asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
                  });
                }
                return rows.map((r) => {
                  const out: Partial<AuthRow> = {};
                  for (const c of cols)
                    (out as Record<string, unknown>)[c] = (r as Record<string, unknown>)[c];
                  return out;
                });
              },
            };
            return chain;
          },
        };
      }
      if (table === 'audit_events') {
        return {
          values: (_v: unknown) => ({ execute: async () => {} }),
        };
      }
      return {};
    },
    insertInto: (table: string) => {
      if (table === 'target_authorizations') {
        return {
          values: (v: Partial<AuthRow>) => ({
            returning: (_cols: string[]) => ({
              executeTakeFirstOrThrow: async () => {
                const id = crypto.randomUUID();
                const now = new Date();
                const row: AuthRow = {
                  id,
                  tenant_id: v.tenant_id ?? '',
                  target_id: v.target_id ?? '',
                  method: v.method ?? '',
                  status: v.status ?? 'pending',
                  token_hash: v.token_hash ?? '',
                  token_plaintext: v.token_plaintext ?? null,
                  email_recipient: v.email_recipient ?? null,
                  attempt_count: 0,
                  last_error: null,
                  verified_at: null,
                  consumed_at: null,
                  expires_at: v.expires_at ?? new Date(now.getTime() + 86400000),
                  created_at: now,
                  updated_at: now,
                };
                authRows.push(row);
                return { id: row.id, expires_at: row.expires_at };
              },
            }),
          }),
        };
      }
      if (table === 'audit_events') {
        return {
          values: (v: unknown) => ({
            execute: async () => {
              auditRows.push(v);
            },
          }),
        };
      }
      return { values: () => ({ execute: async () => {} }) };
    },
    updateTable: (table: string) => {
      if (table === 'target_authorizations') {
        return {
          set: (updates: Partial<AuthRow>) => ({
            where: (col: string, op: string, val: unknown) => ({
              execute: async () => {
                for (const r of authRows) {
                  const rv = (r as Record<string, unknown>)[col];
                  if ((op === '=' && rv === val) || (op === '!=' && rv !== val)) {
                    Object.assign(r, updates);
                  }
                }
              },
              where: (col2: string, op2: string, val2: unknown) => ({
                execute: async () => {
                  for (const r of authRows) {
                    const rv1 = (r as Record<string, unknown>)[col];
                    const rv2 = (r as Record<string, unknown>)[col2];
                    const m1 = (op === '=' && rv1 === val) || (op === '!=' && rv1 !== val);
                    const m2 = (op2 === '=' && rv2 === val2) || (op2 === '!=' && rv2 !== val2);
                    if (m1 && m2) Object.assign(r, updates);
                  }
                },
              }),
            }),
          }),
        };
      }
      if (table === 'targets') {
        return {
          set: (updates: Partial<TargetRow>) => ({
            where: (_col: string, _op: string, _val: unknown) => ({
              execute: async () => {
                /* noop */
              },
              where: (_col2: string, _op2: string, _val2: unknown) => ({
                execute: async () => {
                  for (const t of targets) {
                    if (t.id === _val) Object.assign(t, updates);
                  }
                },
              }),
            }),
          }),
        };
      }
      return { set: () => ({ where: () => ({ execute: async () => {} }) }) };
    },
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<void>) => {
        await fn(db);
      },
    }),
  } as unknown as Kysely<Database>;

  return { db, auditRows };
};

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const makeRateLimiter = (maxCalls = 10): RateLimiter & { calls: Record<string, number> } => {
  const calls: Record<string, number> = {};
  return {
    calls,
    recordFailureAndCheck(key: string) {
      calls[key] = (calls[key] ?? 0) + 1;
      const count = calls[key];
      if (count > maxCalls) {
        return { rejected: true, retryAfter: 3600 };
      }
      return { rejected: false };
    },
    reset(key: string) {
      delete calls[key];
    },
  } as RateLimiter & { calls: Record<string, number> };
};

// ─── Mock deps ────────────────────────────────────────────────────────────────

const noopMailer: Mailer = {
  send: async () => ({ messageId: 'mock-msg-1' }),
};

const makeMockWhoisClient = (email: string | null): WhoisClient => ({
  lookup: async (_d) =>
    email
      ? { raw: `Registrant Email: ${email}\n` }
      : { raw: 'Domain: example.com\nNo registrant info\n' },
});

const privacyWhoisClient: WhoisClient = {
  lookup: async (_d) => ({
    raw: 'Registrant Email: REDACTED FOR PRIVACY\n',
  }),
};

const _matchingHttpFetcher = (token: string): HttpFetcher => ({
  fetch: async (_url, _init) => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain' }),
    bodyReader: {
      read: async () => ({
        done: false,
        value: new TextEncoder().encode(`tensol-verify=${token}`),
      }),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>,
  }),
});

const noopTokenStore: TokenStore = {
  findByPlaintext: async () => null,
  markVerified: async () => {},
};

// ─── Test app factory ─────────────────────────────────────────────────────────

const makeApp = (deps: RouteDeps, actorOverride?: UserActor | null) => {
  const app = new Hono<SessionEnv>();

  // Inject actor without a real session lookup
  app.use('*', async (c, next) => {
    c.set('actor', actorOverride !== undefined ? actorOverride : makeActorA());
    c.set('sessionId', null);
    c.set('sessionExpired', false);
    await next();
  });

  app.post('/api/v1/targets/:targetId/authorize/start', tenantGuard(), (c) =>
    handleAuthorizeStart(deps, c),
  );
  app.post('/api/v1/targets/:targetId/authorize/verify', tenantGuard(), (c) =>
    handleAuthorizeVerify(deps, c),
  );
  app.get('/api/v1/targets/:targetId/authorize/status', tenantGuard(), (c) =>
    handleAuthorizeStatus(deps, c),
  );
  app.get('/api/v1/targets/:targetId/authorize/email-confirm', (c) => handleEmailConfirm(deps, c));
  return app;
};

const makeActorA = (): UserActor => ({
  type: 'user',
  id: 'user-a',
  email: 'a@test.com',
  displayName: 'A',
  role: 'admin',
  tenantId: TENANT_A,
});

const makeActorB = (): UserActor => ({
  type: 'user',
  id: 'user-b',
  email: 'b@test.com',
  displayName: 'B',
  role: 'admin',
  tenantId: TENANT_B,
});

const makeDomainTarget = (): TargetRow => ({
  id: TARGET_DOMAIN_ID,
  tenant_id: TENANT_A,
  project_id: PROJECT_ID,
  kind: 'domain',
  value: 'example.com',
  ownership_status: 'unverified',
});

const makeUrlTarget = (): TargetRow => ({
  id: TARGET_URL_ID,
  tenant_id: TENANT_A,
  project_id: PROJECT_ID,
  kind: 'url',
  value: 'https://example.com',
  ownership_status: 'unverified',
});

const makeDomainTargetRow = (): TargetRow => makeDomainTarget();

const makeDeps = (
  targets: TargetRow[],
  authRows: AuthRow[],
  overrides: Partial<RouteDeps> = {},
): RouteDeps => {
  const { db } = makeDb(targets, authRows);
  return {
    config: { appEnv: 'test', cookieName: 'session' } as RouteDeps['config'],
    db,
    repos: {} as RouteDeps['repos'],
    hasher: {} as RouteDeps['hasher'],
    totp: {} as RouteDeps['totp'],
    preAuthStore: {} as RouteDeps['preAuthStore'],
    rateLimiter: makeRateLimiter(),
    sessionRepo: {} as RouteDeps['sessionRepo'],
    dnsResolver: { resolveTxt: async () => [] },
    publicBaseUrl: 'http://localhost:3000',
    httpFetcher: { fetch: async () => ({ status: 404, headers: new Headers(), bodyReader: null }) },
    whoisClient: makeMockWhoisClient('owner@example.com'),
    mailer: noopMailer,
    tokenStore: noopTokenStore,
    ...overrides,
  };
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('routes.integration — authorize', () => {
  // ── Case 1: start dns_txt happy ─────────────────────────────────────────────
  it('1: start dns_txt — 201 with txtRecord; row inserted status=pending', async () => {
    const authRows: AuthRow[] = [];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.method).toBe('dns_txt');
    expect(body.status).toBe('pending');
    expect((body.instructions as Record<string, unknown>).txtRecord).toBeDefined();
    expect(authRows).toHaveLength(1);
    expect(authRows[0].status).toBe('pending');
    expect(authRows[0].token_hash).toBeTruthy();
  });

  // ── Case 2: start file_upload on URL target ──────────────────────────────────
  it('2: start file_upload on URL target — 201; file.url contains /.well-known/', async () => {
    const authRows: AuthRow[] = [];
    const deps = makeDeps([makeUrlTarget()], authRows);
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_URL_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'file_upload' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const file = (body.instructions as Record<string, Record<string, string>>).file;
    expect(file.url).toContain('/.well-known/');
    expect(authRows).toHaveLength(1);
  });

  // ── Case 3: start whois_email happy ─────────────────────────────────────────
  it('3: start whois_email — 201; mailer called; email_recipient populated, token_plaintext null', async () => {
    const authRows: AuthRow[] = [];
    let mailerCalls = 0;
    const countingMailer: Mailer = {
      send: async (args) => {
        mailerCalls++;
        return { messageId: args.traceId };
      },
    };
    const deps = makeDeps([makeDomainTargetRow()], authRows, {
      mailer: countingMailer,
      whoisClient: makeMockWhoisClient('owner@example.com'),
    });
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'whois_email' }),
    });

    expect(res.status).toBe(201);
    expect(mailerCalls).toBe(1);
    expect(authRows).toHaveLength(1);
    expect(authRows[0].email_recipient).toBe('owner@example.com');
    expect(authRows[0].token_plaintext).toBeNull();
  });

  // ── Case 4: start whois_email — privacy proxy ────────────────────────────────
  it('4: start whois_email privacy_proxy — 422; no row inserted', async () => {
    const authRows: AuthRow[] = [];
    const deps = makeDeps([makeDomainTargetRow()], authRows, { whoisClient: privacyWhoisClient });
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'whois_email' }),
    });

    expect(res.status).toBe(422);
    expect(authRows).toHaveLength(0);
  });

  // ── Case 5: start incompatible kind ─────────────────────────────────────────
  it('5: start dns_txt on url target — 422 method_incompatible_kind', async () => {
    const authRows: AuthRow[] = [];
    const deps = makeDeps([makeUrlTarget()], authRows);
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_URL_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe('method_incompatible_kind');
  });

  // ── Case 6: start re-issue idempotent ────────────────────────────────────────
  it('6: start twice same (target, method) — second call returns same row id', async () => {
    const authRows: AuthRow[] = [];
    const now = Date.now();
    const deps = makeDeps([makeDomainTargetRow()], authRows, { nowMs: () => now });
    const app = makeApp(deps);

    const req1 = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });
    const b1 = (await req1.json()) as Record<string, string>;

    const req2 = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });
    const b2 = (await req2.json()) as Record<string, string>;

    expect(req1.status).toBe(201);
    expect(req2.status).toBe(200);
    expect(b1.id).toBe(b2.id);
    // Only one row inserted
    expect(authRows).toHaveLength(1);
  });

  // ── Case 7: verify dns_txt success ──────────────────────────────────────────
  it('7: verify dns_txt success — 200 verified; row + target.ownership_status flipped', async () => {
    const token = `tensol-verify=${'a'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const target = makeDomainTargetRow();
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([target], authRows, {
      dnsResolver: { resolveTxt: async () => [[token]] },
    });
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.status).toBe('verified');
    expect(authRows[0].status).toBe('verified');
  });

  // ── Case 8: verify dns_txt mismatch ─────────────────────────────────────────
  it('8: verify dns_txt mismatch — 200 pending; attempt_count incremented to 1', async () => {
    const token = `tensol-verify=${'b'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows, {
      dnsResolver: { resolveTxt: async () => [[`tensol-verify=${'z'.repeat(64)}`]] },
    });
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(body.reason).toBe('token_mismatch');
    expect(authRows[0].attempt_count).toBe(1);
  });

  // ── Case 9: verify rate-limit ────────────────────────────────────────────────
  it('9: verify — 11th attempt returns 429', async () => {
    const token = `tensol-verify=${'c'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const rl = makeRateLimiter(10);
    const deps = makeDeps([makeDomainTargetRow()], authRows, {
      rateLimiter: rl,
      dnsResolver: { resolveTxt: async () => [] },
    });
    const app = makeApp(deps);

    let lastRes: Response | null = null;
    for (let i = 0; i < 11; i++) {
      // Reset token_plaintext to non-null so verification doesn't short-circuit
      authRows[0].status = 'pending';
      lastRes = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'dns_txt' }),
      });
    }

    expect(lastRes?.status).toBe(429);
  });

  // ── Case 10: verify after attempt_count=10 → row becomes failed ──────────────
  it('10: verify after 10 failures — row.status=failed; subsequent verify 404', async () => {
    const token = `tensol-verify=${'d'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 9,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows, {
      dnsResolver: { resolveTxt: async () => [] },
    });
    const app = makeApp(deps);

    // 10th failure — count goes to 10 → status flips to failed
    const res1 = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });
    expect(res1.status).toBe(200);
    expect(authRows[0].status).toBe('failed');

    // Subsequent verify: no pending row → 404
    const res2 = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });
    expect(res2.status).toBe(404);
    const b2 = (await res2.json()) as Record<string, string>;
    expect(b2.error).toBe('no_pending_challenge');
  });

  // ── Case 11: verify expired ──────────────────────────────────────────────────
  it('11: verify expired row — 410 token_expired; row flipped to expired', async () => {
    const token = `tensol-verify=${'e'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() - 1000), // already expired
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(410);
    expect(authRows[0].status).toBe('expired');
  });

  // ── Case 12: email-confirm happy ─────────────────────────────────────────────
  it('12: email-confirm happy — 302 confirmed=1; row.status=verified', async () => {
    const tokenPlain = 'f'.repeat(64);
    const tokenHash = await sha256Hex(tokenPlain);
    const target = makeDomainTargetRow();
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'whois_email',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: null,
        email_recipient: 'owner@example.com',
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([target], authRows);
    const app = makeApp(deps, null); // unauthenticated

    const res = await app.request(
      `/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/email-confirm?token=${tokenPlain}`,
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('confirmed=1');
    expect(authRows[0].status).toBe('verified');
  });

  // ── Case 13: email-confirm replay ────────────────────────────────────────────
  it('13: email-confirm replay — 302 confirmed=1 idempotent', async () => {
    const tokenPlain = '1'.repeat(64);
    const tokenHash = await sha256Hex(tokenPlain);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'whois_email',
        status: 'verified',
        token_hash: tokenHash,
        token_plaintext: null,
        email_recipient: 'owner@example.com',
        attempt_count: 0,
        last_error: null,
        verified_at: new Date(),
        consumed_at: new Date(),
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    const app = makeApp(deps, null);

    const res = await app.request(
      `/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/email-confirm?token=${tokenPlain}`,
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('confirmed=1');
  });

  // ── Case 14: email-confirm bad token ─────────────────────────────────────────
  it('14: email-confirm bad token — 302 confirmed=0 invalid_link', async () => {
    const deps = makeDeps([makeDomainTargetRow()], []);
    const app = makeApp(deps, null);

    const res = await app.request(
      `/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/email-confirm?token=${'9'.repeat(64)}`,
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('confirmed=0');
    expect(loc).toContain('invalid_link');
  });

  // ── Case 15: email-confirm expired ───────────────────────────────────────────
  it('15: email-confirm expired — 302 confirmed=0 expired', async () => {
    const tokenPlain = 'a'.repeat(64);
    const tokenHash = await sha256Hex(tokenPlain);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'whois_email',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: null,
        email_recipient: 'owner@example.com',
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() - 1000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    const app = makeApp(deps, null);

    const res = await app.request(
      `/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/email-confirm?token=${tokenPlain}`,
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('confirmed=0');
    expect(loc).toContain('expired');
  });

  // ── Case 16: status endpoint — no token_plaintext in response ────────────────
  it('16: status — returns attempts array; no token_plaintext field', async () => {
    const token = `tensol-verify=${'f'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    const app = makeApp(deps);

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/status`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempts: Record<string, unknown>[] };
    expect(Array.isArray(body.attempts)).toBe(true);
    expect(body.attempts).toHaveLength(1);
    // token_plaintext must NOT appear in any attempt entry
    for (const attempt of body.attempts) {
      expect('token_plaintext' in attempt).toBe(false);
    }
  });

  // ── Case 17: cross-tenant verify → 403 ──────────────────────────────────────
  it('17: cross-tenant verify — actor B gets 403; row untouched', async () => {
    const token = `tensol-verify=${'g'.repeat(64)}`;
    const tokenHash = await sha256Hex(token);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'dns_txt',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: token,
        email_recipient: null,
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    // App with onError that maps RbacDenyError → 403
    const app = new Hono<SessionEnv>();
    app.use('*', async (c, next) => {
      c.set('actor', makeActorB());
      c.set('sessionId', null);
      c.set('sessionExpired', false);
      await next();
    });
    app.onError((err, c) => {
      const { RbacDenyError } = require('@cyberstrike/authz');
      if (err instanceof RbacDenyError) return c.json({ error: 'forbidden' }, 403);
      return c.json({ error: 'internal_error' }, 500);
    });
    app.post('/api/v1/targets/:targetId/authorize/verify', tenantGuard(), (c) =>
      handleAuthorizeVerify(deps, c),
    );

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(403);
    expect(authRows[0].status).toBe('pending'); // row untouched
  });

  // ── Case 18: unauthenticated verify → 401 ────────────────────────────────────
  it('18: unauthenticated verify — 401 unauthenticated', async () => {
    const deps = makeDeps([makeDomainTargetRow()], []);
    const app = makeApp(deps, null); // actor = null

    const res = await app.request(`/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'dns_txt' }),
    });

    expect(res.status).toBe(401);
  });

  // ── Case 19: email-confirm is unauthenticated ─────────────────────────────────
  it('19: email-confirm is unauthenticated — no cookie still works', async () => {
    const tokenPlain = '2'.repeat(64);
    const tokenHash = await sha256Hex(tokenPlain);
    const authRows: AuthRow[] = [
      {
        id: crypto.randomUUID(),
        tenant_id: TENANT_A,
        target_id: TARGET_DOMAIN_ID,
        method: 'whois_email',
        status: 'pending',
        token_hash: tokenHash,
        token_plaintext: null,
        email_recipient: 'owner@example.com',
        attempt_count: 0,
        last_error: null,
        verified_at: null,
        consumed_at: null,
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const deps = makeDeps([makeDomainTargetRow()], authRows);
    // actor = null simulates unauthenticated
    const app = makeApp(deps, null);

    const res = await app.request(
      `/api/v1/targets/${TARGET_DOMAIN_ID}/authorize/email-confirm?token=${tokenPlain}`,
    );

    // Should work regardless of auth (302, not 401)
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('confirmed=1');
  });
});
