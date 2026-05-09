# Product Spec — target-authorization-proof

Workstream C, team `tensol-overnight-2026-05-09`. Three sprints, no code in this doc, only the contract Generator implements and Evaluator checks.

---

## 0. Context (verified by Planner)

The platform already has a **Sprint-25 single-method** flow at `apps/api/src/routes/domains/domain-verify.ts` (DNS-TXT only, table `domain_verifications`, mig 024) and the legacy `target_ownership_claims` append-only log used by `POST /api/v1/targets/:id/ownership-proof`. Both stay untouched. This sprint adds a **second, methods-aware track** that:

1. supports three methods (`dns_txt`, `file_upload`, `whois_email`),
2. lives behind dedicated verifier files with **DI-mockable boundaries** (no real DNS/HTTP/WHOIS/SMTP in tests),
3. feeds the FE wizard at `/projects/:projectId/targets/:targetId/authorize`.

The existing single-method flow is **left in place** for backwards compat — it only verifies `kind='domain'` and is not method-aware. The new flow handles every authorizable target (domain + URL).

**Stack confirmed at planning time:**
- Backend: Bun + Hono. Factory at `apps/api/src/factory.ts` already plumbs `dnsResolver` via `RouteDeps`. Pattern to follow: extend `RouteDeps` with `httpFetcher`, `whoisClient`, `mailer`, `nowMs?`.
- DB: Kysely + Postgres. Migrations at `packages/db/migrations/`, latest is `025_scans_api_tokens.ts`. Schema interface union at `packages/db/src/schema.ts` line 480 (`Database`). `ALL_TABLE_NAMES` line 515. `attachAppendOnlyTriggers()` and `dropAppendOnlyTriggers()` helpers in `_common.ts`.
- Frontend: React 19 + react-router v7 inside `apps/site`. Lazy-loaded routes registered in `apps/site/src/App.tsx`. Primitives in `apps/site/src/components/primitives.tsx` (Btn, Field, Input, Select, Textarea, Modal, Mono, StatusChip, etc.). i18n in `apps/site/src/i18n.ts` with namespace anchor convention `// ── BEGIN:<ns> ──` / `// ── END:<ns> ──`.
- All routes guarded by `tenantGuard()` middleware, ownership enforced by `assertOwnership(actor.tenantId, {resourceType, resourceId, resourceTenantId})`. RBAC through `assertCan(actor, 'update', 'target')`.

**Gitnexus impact verified before recommending edits to:**
- `Database` interface — adding `target_authorizations` is additive (new key); `DomainVerificationsTable` impact d=1 was the same set of files (LOW–MEDIUM, only repo+aggregate scaffolding). No breakage.
- `registerRoutes` — appending route registrations is additive, impactedCount=0.
- `RouteDeps` — adding optional `httpFetcher`, `whoisClient`, `mailer`, `tokenStore` is additive (`?` modifier required because legacy callers won't supply them); risk LOW.

---

## 1. Architecture decisions (≥7, all locked)

### AD-1 — Token format
`tensol-verify=<32-byte-hex>` for DNS-TXT and file-upload. WHOIS-email link uses an opaque url-safe token: `<32-byte-hex>` (no prefix). Both paths use 32 random bytes from `crypto.getRandomValues` rendered as hex (64 chars). Zero shared state across methods — each row stores its own token.

### AD-2 — Expiry policy
Every `target_authorizations` row has `expires_at = now() + interval '24 hours'`. Re-issuing a challenge for the same `(target_id, method)` is allowed iff: previous row is `expired` OR `failed` OR `(pending` AND `expires_at <= now())`. Expired pending rows transition to `expired` lazily on read (same pattern as `domain-verify.ts:198`).

### AD-3 — Retry semantics
Two **orthogonal** caps, both enforced on `/verify`:
1. **Per-row lifetime cap** — `attempt_count int not null default 0` increments on each failed verification. When `attempt_count >= 10` the row's `status` flips to `failed` and subsequent `/verify` calls receive `404 no_pending_challenge` (the row is no longer pending). User must re-issue via `/start`.
2. **Per-target hourly bucket** — existing `RateLimiter` keyed on `auth-proof:${targetId}` (separate bucket from login limiter), 10 events / 60 min window. The 11th attempt within the window returns `429 too_many_attempts` with `retryAfter`. Cap is per-target, not per-method (rotating methods doesn't extend the budget).

These mechanisms are independent — a fast attacker hits the rate-limit (#2) before exhausting the per-row counter (#1); a slow attacker grinding once per hour will exhaust the per-row counter without ever triggering the rate-limit. Both are required.

### AD-4 — Email-link signing
WHOIS-email confirmation link: `${PUBLIC_BASE_URL}/api/v1/targets/${targetId}/authorize/email-confirm?token=${tokenPlaintext}`. The token is **bare 32-byte hex**, not signed. Security comes from (a) high entropy (256 bits), (b) 24h expiry, (c) one-time use (consumed_at column flips on first hit), (d) constant-time compare via `timingSafeEqual`. No HMAC layer — extra crypto with no incremental security in this threat model.

### AD-5 — Redirect URL after email-click
On success: `${PUBLIC_BASE_URL}/projects/${projectId}/targets/${targetId}/authorize?confirmed=1`. On expired/invalid: same path with `?confirmed=0&reason=expired`. The redirect is a 302 from the API; FE reads `confirmed` from `URLSearchParams` in step-3.

### AD-6 — Token replay defence
Email-confirm endpoint sets `status='verified'` AND `consumed_at=now()` in a transaction with a `WHERE status = 'pending'` guard. Second click on the same link reads `status='verified'` and just redirects without re-toggling — no error to the user, but no double-auth either. Internal audit row `auth_proof.email_link.replay` recorded with outcome=`failure`.

### AD-7 — Cross-method ownership
A target may have multiple `target_authorizations` rows (one per method tried). The target is considered **authorized** iff `EXISTS (SELECT 1 FROM target_authorizations WHERE target_id=$1 AND status='verified')`. The first verified row wins; subsequent attempts on other methods are no-ops (`/start` returns the existing `verified` row's metadata). The `targets.ownership_status='verified'` column is flipped on the first method that verifies, mirroring the `domain-verify.ts` pattern.

### AD-8 — Wildcard / CNAME edge case (DNS)
Resolver targets `_tensol-verify.<domain>` (subdomain, not root). Wildcard CNAME at `*.example.com` will return whatever the wildcard points to; the verifier checks for **exact token match** in any of the returned TXT chunks (after `.join('')` of each record's parts, mirroring domain-verify M1 fix). If the wildcard resolves to a record without our token, verifier returns `not_found`, NOT `wildcard_detected` — we do not warn the user about wildcards because that leaks DNS topology.

### AD-9 — HTTPS-only file fetch
`file-upload-verifier.verify()` rejects schemes other than `https:` synchronously before any network call (`return {ok:false, reason:'non_https'}`). Redirects are NOT followed (`redirect: 'manual'`). Status 3xx → `{ok:false, reason:'redirect_rejected'}`. This blocks both http→https downgrades and open-redirect-as-oracle attacks. 5s `AbortSignal.timeout(5000)`. Body read capped at **1024 bytes** via a streaming reader (`response.body!.getReader()` + manual byte counter); over-cap → `{ok:false, reason:'oversize'}`.

### AD-10 — WHOIS registrant extraction
`whois-verifier.lookupRegistrantEmail()` accepts a `WhoisClient` interface returning the raw WHOIS response object/string. Email extraction:
1. Prefer `Registrant Email:` field if present.
2. Fallback to `Admin Email:` only when no Registrant.
3. If multiple emails → pick the **first** Registrant entry (do not spam multiples).
4. Strip RFC-rate-limit/redacted markers (`REDACTED FOR PRIVACY`, `Please query the RDDS service`).
5. If only privacy-proxied email is present → `{reason:'privacy_proxy'}` (user-actionable: "switch to DNS or file method").

### AD-11 — Mailer abstraction
`Mailer` interface: `send({to, subject, textBody, htmlBody, traceId}): Promise<{messageId: string}>`. Production binding lazy-loads SMTP creds from env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). When any are absent, factory wires a `LoggingMailer` that logs the would-be email to stderr with the token redacted (`***`) and `traceId` — preserves dev/CI flow with no real send. Tests never use real mailer; CI default is `LoggingMailer`.

### AD-12 — Token store for WHOIS-email
`tokenStore` interface backed by `target_authorizations` itself (no Redis). Methods: `findByPlaintext(token): Row|null`, `markVerified(rowId, now): void`. Lookup by **sha256 of the plaintext** (`token_hash` column), not the plaintext — same hash-at-rest pattern as `password_reset_tokens`. The plaintext lives only in the email link.

### AD-13 — Frontend state machine (Step 1 → 2 → 3)
React `useReducer` with state shape `{ step: 1|2|3, method: 'dns_txt'|'file_upload'|'whois_email'|null, challenge: ChallengeData|null, verifyState: 'idle'|'loading'|'success'|'error', errorReason: string|null }`. Transitions:
- `step1.choose(method)` → fetch `POST /authorize/start` → on success `step=2, challenge=res, method=res.method`.
- `step2.next()` → `step=3, verifyState='idle'`.
- `step3.verify()` → `verifyState='loading'`; `POST /authorize/verify` → `success` or `error` with `errorReason`.
- Any step: `back()` decrements `step`. Once `verifyState='success'`, navigation locks (only "Done" / "Go to scan" allowed).
- WHOIS-email path: step 3 polls `GET /authorize/status` every 5s up to 5 min waiting for `email-confirm` redirect; user can click "Я перешёл по ссылке" to trigger immediate poll.

### AD-14 — i18n namespace
New top-level key `authorize` (plain object, not `as const`). Keys live in BOTH `en` and `ru` blocks bracketed by `// ── BEGIN:authorize ──` / `// ── END:authorize ──` markers. Shape pre-stubbed in this spec; Generator may NOT add/remove keys — only edit values. **Naming check done:** no existing `authorize` key in i18n.ts (verified via grep at planning time).

### AD-15 — Audit hooks
Every state transition emits an audit row via `audit(deps, …)`:
- `auth_proof.start` (success) — `{method}` in metadata.
- `auth_proof.verify.success` — `{method}`.
- `auth_proof.verify.failure` — `{method, reason}` (reason is the verifier's `reason` field, e.g. `dns_lookup_error`).
- `auth_proof.email.sent` — `{method:'whois_email', recipientHashed: sha256(email).slice(0,16)}` (NEVER log the cleartext email — privacy invariant).
- `auth_proof.email_link.replay` — `{method:'whois_email'}` outcome=failure.

### AD-16 — Backwards compat with `domain-verify.ts`
`domain-verify.ts` is **left untouched**. Its `domain_verifications` row continues to exist independently. The new `target_authorizations` is read by both old and new UIs in different code paths. The "Start scan" gate (future sprint) will check `target_authorizations.status='verified' OR domain_verifications.status='verified'` to grandfather already-verified targets. Spec'd here as a non-breaking transition note — not in scope this sprint.

---

## 2. Sprint 1 — Backend verifiers (pure, mockable)

### 2.1 Files Generator CREATES (Sprint 1)

| Path | Role |
|------|------|
| `apps/api/src/routes/targets/authorize/dns-txt-verifier.ts` | Pure verifier + types. Imports nothing from `RouteDeps`. |
| `apps/api/src/routes/targets/authorize/file-upload-verifier.ts` | Pure verifier + types. |
| `apps/api/src/routes/targets/authorize/whois-verifier.ts` | Pure verifier (lookup + verify). |
| `apps/api/src/routes/targets/authorize/types.ts` | Shared `AuthMethod = 'dns_txt'|'file_upload'|'whois_email'`, `VerifierResult`, `ChallengeArtifact`. |
| `apps/api/src/routes/targets/authorize/dns-txt-verifier.test.ts` | Bun test suite. |
| `apps/api/src/routes/targets/authorize/file-upload-verifier.test.ts` | Bun test suite. |
| `apps/api/src/routes/targets/authorize/whois-verifier.test.ts` | Bun test suite. |

### 2.2 Files Generator does NOT touch (Sprint 1)

- `apps/api/src/routes/domains/domain-verify.ts` — read-only reference.
- `apps/api/src/routes/targets/targets.ts` — read-only reference (touched in Sprint 2).
- Anything in `packages/db/` (touched in Sprint 2).
- Anything in `apps/site/` (touched in Sprint 3).

### 2.3 Contracts

#### `types.ts`
```ts
export type AuthMethod = 'dns_txt' | 'file_upload' | 'whois_email';

export interface ChallengeArtifact {
  readonly token: string;        // 64-char hex (or `tensol-verify=<hex>` for DNS/file)
  readonly instructions: {       // method-specific
    readonly kind: AuthMethod;
    readonly txtRecord?: { readonly name: string; readonly value: string };  // dns_txt
    readonly file?: { readonly url: string; readonly body: string };          // file_upload
    readonly email?: { readonly recipient: string };                          // whois_email
  };
}

export interface VerifierResult {
  readonly ok: boolean;
  readonly reason?: string;      // machine-readable code on failure (snake_case)
  readonly observed?: unknown;   // optional debug payload, NEVER returned to client
}
```

#### `dns-txt-verifier.ts`
```ts
export interface TxtDnsResolver { resolveTxt(hostname: string): Promise<string[][]>; }

export const DNS_TOKEN_PREFIX = 'tensol-verify=';

export const generateChallenge = (
  targetId: string,
  domain: string,
  randomBytes?: () => string  // override for deterministic tests
): { token: string; txtRecord: { name: string; value: string } };
// Token = `tensol-verify=<32-byte-hex>`. txtRecord.name = `_tensol-verify.<domain>`.

export const verify = (
  domain: string,
  expectedToken: string,
  deps: { dnsResolver: TxtDnsResolver }
): Promise<VerifierResult>;
// Calls deps.dnsResolver.resolveTxt(`_tensol-verify.${domain}`).
// Joins each parts[]; checks for exact match against expectedToken.
// On any thrown error → {ok:false, reason:'dns_lookup_error'}.
// 5s wallclock timeout via Promise.race + setTimeout (not AbortSignal — node:dns/promises ignores it).
```

#### `file-upload-verifier.ts`
```ts
export interface HttpFetcher {
  fetch(url: string, init: { method: 'GET'; signal: AbortSignal; redirect: 'manual' }): Promise<HttpFetchResult>;
}
export interface HttpFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyReader: ReadableStreamDefaultReader<Uint8Array> | null;
}

export const FILE_TOKEN_PREFIX = 'tensol-verify=';
export const MAX_BODY_BYTES = 1024;
export const FETCH_TIMEOUT_MS = 5_000;

export const generateChallenge = (
  targetId: string,
  originUrl: string,
  randomBytes?: () => string
): { token: string; urlPath: string; expectedBody: string };
// originUrl is e.g. https://example.com (no trailing slash).
// urlPath = /.well-known/tensol-verify-<token>.txt
// expectedBody = `tensol-verify=<token>` (one line, no trailing whitespace).

export const verify = (
  originUrl: string,
  expectedToken: string,
  deps: { httpFetcher: HttpFetcher }
): Promise<VerifierResult>;
// 1. Parse originUrl. If protocol !== 'https:' → {ok:false, reason:'non_https'}.
// 2. Construct full URL = originUrl + `/.well-known/tensol-verify-${expectedToken}.txt`.
// 3. fetch with redirect:'manual', signal:AbortSignal.timeout(5000).
// 4. status 3xx → {ok:false, reason:'redirect_rejected'}.
// 5. status !== 200 → {ok:false, reason:`status_${status}`}.
// 6. Read up to 1024 bytes; if body finished beyond cap → {ok:false, reason:'oversize'}.
// 7. Trim whitespace, compare to `tensol-verify=${expectedToken}` via timingSafeEqual.
// 8. Match → {ok:true}; mismatch → {ok:false, reason:'token_mismatch'}.
// On thrown error → {ok:false, reason:'fetch_error'}. On AbortError → {ok:false, reason:'timeout'}.
```

#### `whois-verifier.ts`
```ts
export interface WhoisClient { lookup(domain: string): Promise<{ raw: string }>; }
export interface Mailer {
  send(args: {
    to: string; subject: string; textBody: string; htmlBody?: string; traceId: string;
  }): Promise<{ messageId: string }>;
}
export interface TokenStore {
  findByPlaintext(token: string, nowMs: number): Promise<{ id: string; targetId: string; status: string; expiresAt: Date } | null>;
  markVerified(id: string, nowMs: number): Promise<void>;
}

export const lookupRegistrantEmail = (
  domain: string,
  deps: { whoisClient: WhoisClient }
): Promise<{ email?: string; reason?: string }>;
// Reasons: 'whois_lookup_error', 'no_registrant_email', 'privacy_proxy'.
// Implementation: regex /^Registrant Email:\s*(\S+)/im on raw response, fallback /^Admin Email:\s*(\S+)/im.
// Strip if matches /(REDACTED FOR PRIVACY|whoisguard|privacyprotect|whois-protect)/i → {reason:'privacy_proxy'}.

export const sendVerificationEmail = (
  args: { email: string; token: string; targetId: string; projectId: string; baseUrl: string; traceId: string },
  deps: { mailer: Mailer }
): Promise<{ messageId: string }>;
// Subject (RU+EN): "Tensol — подтверждение прав на домен / Domain authorization".
// Body contains link: `${baseUrl}/api/v1/targets/${targetId}/authorize/email-confirm?token=${token}`.
// Email body NEVER includes the token outside the link href; HTML body has the same link as <a href>.
// Failures bubble up; route layer translates to {reason:'email_send_failed'}.

export const verify = (
  token: string,
  nowMs: number,
  deps: { tokenStore: TokenStore }
): Promise<VerifierResult>;
// 1. tokenStore.findByPlaintext(token, nowMs).
// 2. null → {ok:false, reason:'not_found'}.
// 3. status === 'verified' → {ok:true} (idempotent re-check).
// 4. status !== 'pending' || expiresAt <= now → {ok:false, reason:'expired'}.
// 5. tokenStore.markVerified(row.id, nowMs).
// 6. {ok:true}.
```

### 2.4 Test plan (Sprint 1, ≥5 cases each)

#### `dns-txt-verifier.test.ts` (≥6 cases)
1. **happy path** — resolver returns `[['tensol-verify=abc...']]` → `{ok:true}`.
2. **multi-part records** — `[['tensol-', 'verify=abc...']]` → joined → `{ok:true}`.
3. **multiple records, one matches** — `[['noise'], ['tensol-verify=abc...']]` → `{ok:true}`.
4. **wrong token** — `[['tensol-verify=zzz...']]` → `{ok:false, reason:'token_mismatch'}`.
5. **no record** — `[]` → `{ok:false, reason:'token_mismatch'}`.
6. **resolver throws** (e.g. NXDOMAIN) → `{ok:false, reason:'dns_lookup_error'}`.
7. **timeout** — resolver hangs >5s → `{ok:false, reason:'timeout'}`.
8. **generateChallenge determinism** — same `randomBytes` override → same token; subdomain prefix is `_tensol-verify`.

#### `file-upload-verifier.test.ts` (≥7 cases)
1. **happy path** — 200 + matching body → `{ok:true}`.
2. **non-https rejected** — `http://...` → `{ok:false, reason:'non_https'}` (no fetch call made — assert `httpFetcher.fetch` invocation count = 0).
3. **redirect (302) rejected** — `{ok:false, reason:'redirect_rejected'}`.
4. **404 / 403 / 500** → `{ok:false, reason:'status_404'}` etc.
5. **body mismatch** — 200 but body is `tensol-verify=zzz` → `{ok:false, reason:'token_mismatch'}`.
6. **oversize body** — reader yields 2000 bytes → `{ok:false, reason:'oversize'}`.
7. **timeout** — fetcher rejects with `AbortError` → `{ok:false, reason:'timeout'}`.
8. **arbitrary fetch error** → `{ok:false, reason:'fetch_error'}`.
9. **generateChallenge** — path is `/.well-known/tensol-verify-<token>.txt`; body matches `tensol-verify=<token>`.

#### `whois-verifier.test.ts` (≥8 cases)
1. **registrant found** — raw contains `Registrant Email: owner@example.com` → `{email:'owner@example.com'}`.
2. **admin fallback** — no Registrant, has `Admin Email: admin@example.com` → `{email:'admin@example.com'}`.
3. **multiple registrants** — first wins.
4. **privacy proxy** — `Registrant Email: REDACTED FOR PRIVACY` → `{reason:'privacy_proxy'}`.
5. **whois client throws** → `{reason:'whois_lookup_error'}`.
6. **mailer success** — `sendVerificationEmail` returns `{messageId}`; assert `mailer.send` called once with link containing token plaintext.
7. **mailer rejects** — error bubbles up.
8. **verify happy path** — tokenStore returns pending row → `{ok:true}` and `markVerified` called once.
9. **verify expired** — `expiresAt < now` → `{ok:false, reason:'expired'}`; `markVerified` NOT called.
10. **verify not-found** — store returns null → `{ok:false, reason:'not_found'}`.
11. **verify replay** — store returns `status='verified'` → `{ok:true}` and `markVerified` NOT called (idempotent).

### 2.5 Coverage gate (Sprint 1)
Coverage on **the three verifier files specifically** ≥ 90% line. Use Bun's `--coverage` JSON output filtered to the `apps/api/src/routes/targets/authorize/{dns-txt,file-upload,whois}-verifier.ts` paths. Existing `scripts/coverage-gate.ts` already enforces 80% project-wide; Sprint 1 evaluator must add a per-file assertion.

### 2.6 Sprint 1 Definition of Done
- [ ] All four production files exist and compile with `tsc -b`.
- [ ] All three test files run green via `bun test`.
- [ ] Per-file line coverage ≥ 90% for verifiers.
- [ ] No real DNS/HTTP/WHOIS/SMTP I/O happens during tests (verified by grep for `node:dns`, `globalThis.fetch`, etc. inside test files — must be absent).
- [ ] Conventional commit: `feat(authorize): pure verifiers for dns-txt/file-upload/whois (sprint 1)`.

---

## 3. Sprint 2 — Database + API routes

### 3.1 Files Generator CREATES (Sprint 2)

| Path | Role |
|------|------|
| `packages/db/migrations/026_target_authorizations.ts` | New migration. |
| `apps/api/src/routes/targets/authorize/routes.ts` | 4 Hono handlers. |
| `apps/api/src/routes/targets/authorize/token-store.ts` | DB-backed `TokenStore` impl. |
| `apps/api/src/routes/targets/authorize/mailer.ts` | `LoggingMailer` + `SmtpMailer` factories. |
| `apps/api/src/routes/targets/authorize/whois-client.ts` | `NodeWhoisClient` thin wrapper around `whois-json` package (or stub). |
| `apps/api/src/routes/targets/authorize/http-fetcher.ts` | `NodeHttpFetcher` thin wrapper around `globalThis.fetch`. |
| `apps/api/src/routes/targets/authorize/routes.integration.test.ts` | Hono integration test. |

### 3.2 Files Generator MODIFIES (Sprint 2)

| Path | Change scope |
|------|--------------|
| `packages/db/src/schema.ts` | Add `TargetAuthorizationsTable` interface, `target_authorizations` key to `Database`, push name to `ALL_TABLE_NAMES`. **NO change** to `APPEND_ONLY_TABLES` (this table is mutable by design). |
| `apps/api/src/routes/register-routes.ts` | Append 4 route registrations after the S25 domain-verify block. Import handlers from `./targets/authorize/routes.ts`. |
| `apps/api/src/routes/shared.ts` | Extend `RouteDeps` with **optional** `httpFetcher?: HttpFetcher`, `whoisClient?: WhoisClient`, `mailer?: Mailer`, `tokenStore?: TokenStore`, `nowMs?: () => number`, `publicBaseUrl?: string`. |
| `apps/api/src/factory.ts` | Wire production defaults: `httpFetcher: new NodeHttpFetcher()`, `whoisClient: new NodeWhoisClient()`, `mailer: SmtpMailer.fromEnv() ?? new LoggingMailer()`, `tokenStore: createDbTokenStore(options.db)`, `publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'`. |
| `apps/api/src/index.ts` | Re-export new types `AuthMethod`, `HttpFetcher`, `WhoisClient`, `Mailer`, `TokenStore`. |

### 3.3 Files Generator does NOT touch (Sprint 2)
- `apps/api/src/routes/domains/domain-verify.ts` — unrelated S25 path.
- `apps/api/src/routes/targets/targets.ts` — legacy `ownership-proof` path.
- `packages/db/src/repos/*` — no aggregate Repository for target_authorizations needed (route layer uses Kysely directly, same as `domain-verify.ts`).
- `_common.ts` — append-only triggers do NOT apply to this table.

### 3.4 Migration `026_target_authorizations.ts` — exact SQL

```ts
import { type Kysely, sql } from 'kysely';

export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('target_authorizations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id').onDelete('cascade'))
    .addColumn('method', 'text', (c) =>
      c.notNull().check(sql`method IN ('dns_txt','file_upload','whois_email')`),
    )
    .addColumn('token_hash', 'char(64)', (c) => c.notNull())  // sha256(plaintext) hex
    .addColumn('token_plaintext', 'text')                      // NULL once verified or for non-email methods
    .addColumn('email_recipient', 'text')                      // populated only for whois_email
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('pending').check(sql`status IN ('pending','verified','failed','expired')`),
    )
    .addColumn('verified_at', 'timestamptz')
    .addColumn('consumed_at', 'timestamptz')                   // email-link one-time-use marker
    .addColumn('expires_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now() + interval '24 hours'`),
    )
    .addColumn('attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`CREATE INDEX idx_target_auth_target_status ON target_authorizations (target_id, status)`.execute(db);
  await sql`CREATE INDEX idx_target_auth_token_hash ON target_authorizations (token_hash) WHERE status='pending'`.execute(db);
  await sql`CREATE INDEX idx_target_auth_expires ON target_authorizations (expires_at) WHERE status='pending'`.execute(db);
};

export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('target_authorizations').ifExists().execute();
};
```

**Why these columns:**
- `token_hash` (not plaintext) for whois-email lookup (privacy-at-rest, mirrors `password_reset_tokens`).
- `token_plaintext` is briefly retained for DNS/file methods so the FE can re-display instructions on Step-2 reload; **MUST be nulled on transition to `verified` or `failed`/`expired`** in route handler.
- No append-only trigger — table is mutable by design (status flips, attempt_count increments).
- Composite-index choice matches AD-7 lookup: `WHERE target_id=$1 AND status='verified'`.

### 3.5 Schema interface addition (`packages/db/src/schema.ts`)

```ts
// =============== target authorizations (mig 026) ===============
export interface TargetAuthorizationsTable {
  id: Generated<string>;
  tenant_id: string;
  target_id: string;
  method: string;             // CHECK ('dns_txt'|'file_upload'|'whois_email')
  token_hash: string;          // CHAR(64) sha256 hex
  token_plaintext: string | null;
  email_recipient: string | null;
  status: string;              // CHECK ('pending'|'verified'|'failed'|'expired')
  verified_at: Date | null;
  consumed_at: Date | null;
  expires_at: Date;
  attempt_count: DbDefault<number>;
  last_error: string | null;
  created_at: DbDefault<Date>;
  updated_at: DbDefault<Date>;
}
```
Add to `Database`: `target_authorizations: TargetAuthorizationsTable;` (alphabetical position not required — append after `domain_verifications`). Push string `'target_authorizations'` into `ALL_TABLE_NAMES`. **Do NOT** add to `APPEND_ONLY_TABLES`.

### 3.6 Route handlers (Hono signatures)

All four mounted by `register-routes.ts`. All call `tenantGuard()`. All resolve `targetId`, run `assertOwnership(actor.tenantId, ...)`, run `assertCan(actor, 'update', 'target')` (same role gate as `handleOwnershipProof`).

#### `POST /api/v1/targets/:targetId/authorize/start`
Body schema (zod, `.strict()`):
```ts
{ method: z.enum(['dns_txt','file_upload','whois_email']) }
```
Algorithm:
1. Resolve target by id → 404 if missing or cross-tenant.
2. Pre-flight method-target compatibility:
   - `dns_txt` requires `target.kind === 'domain'` → 422 `method_incompatible_kind` otherwise.
   - `file_upload` requires `target.kind` ∈ `{'url','domain'}` → 422 otherwise.
   - `whois_email` requires `target.kind === 'domain'` → 422 otherwise.
3. Look up existing pending row for `(target_id, method)`. If pending+not-expired → return its public form (idempotent). If verified → return `{status:'verified', alreadyVerified:true}`. If expired/failed → soft-delete (set `status='expired'` if not already) and continue.
4. Generate token via verifier's `generateChallenge`.
5. For `whois_email`: call `whoisVerifier.lookupRegistrantEmail(domain, deps)`. On failure → 422 with `reason` from verifier; do NOT persist a row. On success → call `sendVerificationEmail(...)`. If mailer rejects → 502 `email_send_failed`; do NOT persist a row.
6. Insert row: `tenant_id=actor.tenantId`, `target_id`, `method`, `token_hash=sha256(plaintext)`, `token_plaintext=plaintext` (NULL for whois_email — only hash is stored), `email_recipient=email` (whois_email only), defaults applied for status/expires_at/attempt_count.
7. Audit `auth_proof.start`.
8. Response 201 body:
```ts
{
  id: string,
  method: AuthMethod,
  status: 'pending',
  expiresAt: string,                 // ISO
  instructions: ChallengeArtifact['instructions']
}
```
Notes: `token_plaintext` is **NEVER** in the response body for whois_email (the user clicks a link instead). For DNS/file the txtRecord/file body is in `instructions`.

#### `POST /api/v1/targets/:targetId/authorize/verify`
Body schema:
```ts
{ method: z.enum(['dns_txt','file_upload','whois_email']) }
```
Algorithm:
1. Tenancy + RBAC gate (same as `/start`).
2. **Rate-limit gate** — call `deps.rateLimiter.recordFailureAndCheck(\`auth-proof:${targetId}\`)`. If rejected → 429 `{error:'too_many_attempts', retryAfter}`.
3. Load most-recent pending row for `(target_id, method)`. None → 404 `no_pending_challenge`.
4. If `expires_at <= now` → flip to `expired`, return 410 `token_expired`.
5. Run verifier:
   - `dns_txt` → `dnsTxtVerifier.verify(target.value, plaintext, {dnsResolver: deps.dnsResolver})`.
   - `file_upload` → `fileUploadVerifier.verify(target.value, plaintext, {httpFetcher: deps.httpFetcher})`.
   - `whois_email` → return 202 `awaiting_email_click` (verification only happens via the email-link callback). UI will poll `/status`.
6. On `{ok:true}`: in transaction, set `status='verified'`, `verified_at=now`, `token_plaintext=null`, AND set `targets.ownership_status='verified'` (only if not already verified). Audit `auth_proof.verify.success`.
7. On `{ok:false, reason}`: `attempt_count = attempt_count + 1`, `last_error = reason`, `status` stays `pending` unless `attempt_count >= 10` → set `status='failed'`. Audit `auth_proof.verify.failure`. Reset rate-limit bucket only when `ok:true` (failures count toward limit).
8. Response: `{status, reason?}` body, status 200.

#### `GET /api/v1/targets/:targetId/authorize/status`
1. Tenancy + RBAC gate (read variant: `assertCan(actor, 'read', 'target')`).
2. Load **all** rows for target, ordered by `created_at desc`. Return:
```ts
{
  authorizedTargetVerified: boolean,           // any row.status='verified'
  attempts: Array<{
    id: string, method: AuthMethod, status: string,
    expiresAt: string, verifiedAt: string|null,
    attemptCount: number, lastError: string|null,
    createdAt: string
  }>
}
```
No mutation, no rate-limit. **Token plaintext NEVER in response.**

#### `GET /api/v1/targets/:targetId/authorize/email-confirm?token=<plaintext>`
Mounted as **GET** (302-redirect endpoint, browser navigation, idempotent). `user-criteria.md` line 53 lists `POST` but the body of that line and our final design call for GET — generator MUST use GET.

This endpoint is **unauthenticated** (the token is the proof; same pattern as `/auth/password/reset/confirm`). Wired in `register-routes.ts` outside `tenantGuard`.

Algorithm:
1. Validate `targetId` UUID + `token` 64-hex regex. Bad → 400 `invalid_request`.
2. Load row by `token_hash = sha256(token)` AND `target_id = :targetId`. None → 302 to `/projects/UNKNOWN/targets/${targetId}/authorize?confirmed=0&reason=invalid_link`.
3. Resolve target's `project_id` for redirect URL.
4. If `expires_at <= now` → set status=`expired`, redirect with `confirmed=0&reason=expired`.
5. If `status='verified'` → audit `auth_proof.email_link.replay` outcome=failure. Redirect to `confirmed=1` (idempotent UX, but audit captures the replay).
6. If `status='pending'`: in transaction, set `status='verified'`, `verified_at=now`, `consumed_at=now`, `targets.ownership_status='verified'`. Audit `auth_proof.verify.success`. Redirect `confirmed=1`.
7. Redirect URL: `${publicBaseUrl}/projects/${projectId}/targets/${targetId}/authorize?confirmed=${1|0}${reason?`&reason=${reason}`:''}`.

**No CSRF protection needed** (GET, idempotent state transition, token is proof of possession).

### 3.7 Integration test plan (Sprint 2, ≥10 cases)

`routes.integration.test.ts` uses the existing `auth-fixture.ts` pattern:
1. **start dns_txt happy** — POST → 201 with txtRecord; row inserted with `status='pending'`, `token_hash` populated.
2. **start file_upload happy on URL target** — 201; instructions.file.url contains `/.well-known/`.
3. **start whois_email happy with mock WhoisClient** — 201; mailer.send called once; row created with `email_recipient` populated, `token_plaintext` NULL.
4. **start whois_email privacy_proxy** — mock returns redacted → 422 `privacy_proxy`; no row inserted.
5. **start incompatible kind** — `dns_txt` on `kind='url'` → 422 `method_incompatible_kind`.
6. **start re-issue** — call /start twice for same (target, method); second call returns the same row (idempotent, no new insert).
7. **verify dns_txt success** — mock dnsResolver returns matching token → 200 `{status:'verified'}`; row + target.ownership_status both flipped.
8. **verify dns_txt mismatch** — mock returns wrong token → 200 `{status:'pending', reason:'token_mismatch'}`; attempt_count incremented to 1.
9. **verify rate-limit** — 11 verify attempts within window → 11th returns 429.
10. **verify after attempt_count=10** — row.status flips to `failed`; subsequent verify → 404 `no_pending_challenge` (the failed row is no longer "pending").
11. **verify expired** — row.expires_at = past → 410 `token_expired`; row flipped to `expired`.
12. **email-confirm happy** — GET with valid token → 302 to `/projects/.../authorize?confirmed=1`; row.status=verified, target.ownership_status=verified.
13. **email-confirm replay** — second GET with same token → 302 `confirmed=1` (idempotent), but audit row `auth_proof.email_link.replay` exists.
14. **email-confirm bad token** — 302 `confirmed=0&reason=invalid_link`.
15. **email-confirm expired** — 302 `confirmed=0&reason=expired`.
16. **status endpoint** — returns array of attempts; no `token_plaintext` field anywhere in response (assert absence).
17. **cross-tenant verify** — actor B verifies a target owned by tenant A → 403 `forbidden`; no row mutated (verifier never even called — fail at assertOwnership).
18. **unauth verify** — no session cookie → 401 `unauthenticated`.
19. **email-confirm is unauthenticated** — no cookie → still works (token is the proof).

### 3.8 Sprint 2 Definition of Done
- [ ] Migration applies cleanly via `db:migrate:check` (rollback+reapply schema-equivalent).
- [ ] All integration tests green; ≥80% line coverage on new files.
- [ ] tsc -b clean across `apps/api`, `packages/db`.
- [ ] No real network/SMTP I/O during tests (only the injected mocks).
- [ ] `gitnexus_detect_changes()` shows only the expected files modified.
- [ ] Conventional commit: `feat(authorize): db migration + 4 routes for target authorization (sprint 2)`.

---

## 4. Sprint 3 — Frontend wizard

### 4.1 Files Generator CREATES (Sprint 3)

| Path | Role |
|------|------|
| `apps/site/src/pages/AuthorizeTarget.tsx` | 3-step wizard. Default-export a React component. |
| `apps/site/src/pages/AuthorizeTarget.test.tsx` | Component test (Bun + happy-dom or @testing-library/react if installed). |
| `apps/site/src/lib/authorize-api.ts` | Thin fetch wrapper — `startAuth`, `verifyAuth`, `getAuthStatus`. |

### 4.2 Files Generator MODIFIES (Sprint 3, surgical only)

| Path | Allowed change |
|------|----------------|
| `apps/site/src/App.tsx` | Append `const AuthorizeTarget = lazy(() => safeImport(() => import('./pages/AuthorizeTarget.tsx'), 'authorize'));` and `<Route path="/projects/:projectId/targets/:targetId/authorize" element={<AuthorizeTarget />} />`. NO other route changes. |
| `apps/site/src/i18n.ts` | Insert key-value pairs ONLY between `// ── BEGIN:authorize ──` and `// ── END:authorize ──` markers, in BOTH `en` (around line 896) and `ru` (around line 1789) blocks. NO change to other namespaces, NO `as const`. |

### 4.3 Files Generator does NOT touch (Sprint 3)
- `apps/site/src/components/primitives.tsx` — use existing primitives only; NO new ones.
- Any other `pages/*.tsx`.
- Any other namespace in `i18n.ts`.
- `data.ts`, `context.tsx`.

### 4.4 i18n keys to add (Sprint 3)

Pre-stubbed shape; Generator copies into BOTH `en` and `ru` blocks:

```ts
// ── BEGIN:authorize ──────────────────────────────────────────────────
authorize: {
  pageTitle: 'Authorize target',                  // ru: 'Подтверждение прав на цель'
  back: '← Back',                                 // ru: '← Назад'
  next: 'Next →',                                 // ru: 'Далее →'
  done: 'Done',                                   // ru: 'Готово'
  whyTitle: 'Why am I doing this?',               // ru: 'Зачем это нужно?'
  whyBody: 'We need proof that you control this target before launching a real attack chain. Without it, scanning is unauthorized access (Art. 272 РФ).',  // ru analog
  step1Title: 'Choose verification method',       // ru: 'Выберите способ проверки'
  step1Hint: 'Pick the method easiest for you. We re-check on the next step.',
  methodDnsTitle: 'DNS TXT record',               // ru: 'DNS-запись TXT'
  methodDnsDesc: 'Add a TXT record to your DNS zone. Best if you control DNS.',
  methodDnsTime: '~5 min',
  methodFileTitle: 'File on origin',
  methodFileDesc: 'Upload a small file to /.well-known/. Best if you have a deploy pipeline.',
  methodFileTime: '~3 min',
  methodEmailTitle: 'WHOIS email',
  methodEmailDesc: 'We send a one-time link to the registrant email on file. Best if you cannot edit DNS.',
  methodEmailTime: '~10 min',
  step2Title: 'Set up the proof',
  step2HintDns: 'Add this TXT record. DNS may take a few minutes to propagate.',
  step2HintFile: 'Upload this file at the path below over HTTPS.',
  step2HintEmail: 'We sent a verification link to the registrant email. Click it, then come back.',
  copy: 'Copy',
  copied: 'Copied',
  step3Title: 'Verify',
  step3Run: 'Verify now',
  step3Polling: 'Waiting for the email link…',
  step3PollNow: 'I clicked the link',
  step3Success: 'Authorized. You can now launch a scan against this target.',
  step3FailGeneric: 'Verification failed. Check the proof and try again.',
  errTokenMismatch: 'Token does not match. Re-check the value you posted.',
  errDnsLookup: 'DNS lookup failed. Check the record name and propagation.',
  errStatus: 'The file URL returned an unexpected status.',
  errNonHttps: 'The origin must be served over HTTPS.',
  errRedirect: 'The origin redirected the request. Disable the redirect on /.well-known/.',
  errOversize: 'The file is larger than expected. Make it a single line.',
  errTimeout: 'The request timed out after 5 seconds.',
  errPrivacyProxy: 'The WHOIS record is privacy-protected. Use DNS or file method instead.',
  errExpired: 'The challenge expired. Start over to get a fresh token.',
  errRateLimit: 'Too many attempts. Try again later.',
  errMethodIncompatible: 'This method is not available for this target type.',
  goToScan: 'Go to scan launch →',
},
// ── END:authorize ────────────────────────────────────────────────────
```

### 4.5 Component tree

```
<AuthorizeTarget />
  ├─ <AppShell breadcrumb=[t.navProjects, t.navTargets, t.authorize.pageTitle]>
  │    ├─ <h1>{t.authorize.pageTitle}</h1>
  │    ├─ <Steps current={step} of={3} />              // simple Mono breadcrumb of dots
  │    ├─ {step===1 && <Step1ChooseMethod onPick={dispatch}/>}
  │    ├─ {step===2 && <Step2Instructions challenge={challenge} method={method} onNext={dispatch}/>}
  │    ├─ {step===3 && <Step3Verify state={verifyState} onVerify={dispatch} method={method}/>}
  │    └─ <details><summary>{t.authorize.whyTitle}</summary><p>{t.authorize.whyBody}</p></details>
  └─ </AppShell>
```

`Step1ChooseMethod`: 3 selectable cards in a vertical stack, using `Card` primitive and a radio behaviour (clicking a card highlights it; bottom Btn calls `startAuth`).

`Step2Instructions`: switch on `method` to render method-specific block.
- DNS: two `Mono` blocks for `name` and `value` with inline copy buttons; muted `step2HintDns` hint.
- File: one `Mono` for full URL, one `Mono` for body, copy buttons; `step2HintFile`.
- Email: shows `email-recipient` as `Mono` (masked: `o***@example.com`), `step2HintEmail`, no copy needed.

`Step3Verify`: large primary Btn `step3Run`; on click → `verifyState='loading'`. Result rendered with `StatusChip` (tone=`ok|danger`) and reason text from `errXxx` keys mapped via a small `errorMessage(reason, t)` function. WHOIS-email path shows polling spinner + "I clicked the link" Btn.

### 4.6 State machine details

`useReducer` with this exhaustive action union:
```ts
type Action =
  | { type: 'pickMethod'; method: AuthMethod }
  | { type: 'startSuccess'; challenge: ChallengeData }
  | { type: 'startFailure'; reason: string }
  | { type: 'goNext' }
  | { type: 'goBack' }
  | { type: 'verifyStart' }
  | { type: 'verifySuccess' }
  | { type: 'verifyFailure'; reason: string }
  | { type: 'pollTick' };  // polling for whois_email
```

`whois_email` polling: in `Step3Verify`, `useEffect` mounts a 5s `setInterval` calling `getAuthStatus`; on `authorizedTargetVerified=true` dispatch `verifySuccess`; clears after 60 ticks (5min) and stops.

URL parameter handling: `useSearchParams` reads `?confirmed=1` after email redirect; if set, dispatch `verifySuccess` immediately on mount (covers the case where user lands here after clicking email link).

### 4.7 `authorize-api.ts` shape

```ts
export interface ChallengeData {
  id: string; method: AuthMethod; status: 'pending'|'verified';
  expiresAt: string; instructions: ChallengeArtifact['instructions']; alreadyVerified?: boolean;
}
export const startAuth = (targetId: string, method: AuthMethod) =>
  fetch(`/api/v1/targets/${targetId}/authorize/start`, { method:'POST', credentials:'include',
    headers:{'content-type':'application/json'}, body: JSON.stringify({method}) }).then(r => parseEnvelope<ChallengeData>(r));
// Same shape for verifyAuth, getAuthStatus.
```
Returns the `ApiResponse<T>` envelope from global patterns; UI renders `error` directly from server's `reason`/`error` field.

### 4.8 Test plan (Sprint 3, ≥6 cases)

`AuthorizeTarget.test.tsx`:
1. **renders step 1 by default** with 3 method cards.
2. **picks DNS, fetch resolves**, dispatches startSuccess, advances to step 2; renders TXT name + value.
3. **copy button** writes to clipboard mock; flips label to "Copied" then back after 1.5s.
4. **goBack from step 2** restores step 1 with method preselected.
5. **verify success on step 3** → renders `step3Success`, `goToScan` button visible, primary button hidden.
6. **verify failure → mapped error text** rendered (e.g. `errTokenMismatch` for `reason='token_mismatch'`).
7. **whois_email polling** — fake `setInterval`, after first tick status returns verified → `verifySuccess` dispatched.
8. **search-param `?confirmed=1`** mounted → component opens directly on success state.
9. **rate-limit error** → renders `errRateLimit`.

### 4.9 Sprint 3 Definition of Done
- [ ] `tsc --noEmit` clean in `apps/site`.
- [ ] `bun test apps/site/src/pages/AuthorizeTarget.test.tsx` green.
- [ ] Dev server (`tmux + npx vite` per memory) renders `/projects/p1/targets/t1/authorize` with all three method paths working against a mocked API.
- [ ] No new top-level keys in `i18n.ts` outside the `authorize:` block.
- [ ] No new files inside `components/`.
- [ ] Conventional commit: `feat(authorize): 3-step wizard + i18n + route (sprint 3)`.

---

## 5. Edge cases (consolidated)

| # | Case | Handling |
|---|------|----------|
| E1 | Wildcard CNAME on parent domain | Verifier returns `token_mismatch`, never `wildcard_detected` (AD-8). |
| E2 | DNS server returns NXDOMAIN | `{ok:false, reason:'dns_lookup_error'}`. |
| E3 | DNS slow (~30s) | 5s timeout via Promise.race → `{reason:'timeout'}` (AD-1 + verifier impl). |
| E4 | HTTPS cert invalid on file fetch | Node fetch throws, caught → `{reason:'fetch_error'}`. Do NOT leak cert details. |
| E5 | Origin returns 301 → /.well-known/foo.txt | `redirect:'manual'` → `{reason:'redirect_rejected'}` (AD-9). |
| E6 | File body has BOM or trailing CRLF | trim() before compare; spec mandates `expectedBody = 'tensol-verify=<token>'` exact one-line. |
| E7 | WHOIS rate-limited (TLD throttling) | Verifier propagates `whois_lookup_error`; user retries later. No exponential backoff at MVP. |
| E8 | WHOIS returns multiple Registrant Email lines | First wins (AD-10). |
| E9 | Privacy-protected WHOIS | 422 at /start, no row created (AD-10). |
| E10 | Email link clicked twice | First click flips, second is replay → audit row + redirect `confirmed=1` (AD-6). |
| E11 | Token replay across users (B steals A's link) | Token hash + tenant scoping at /verify aren't checked on `/email-confirm` (it's unauth). MITIGATION: redirect goes to `/projects/${projectId}/...` derived from row, not request — B sees A's project URL but cannot navigate further (B is not in tenant A; `/dashboard` denies). The token still flips status — accepted residual risk per "the email is the proof" model. Documented in AD-4. |
| E12 | User owns project but not target tenant | Cannot happen by data model: targets are tenant-scoped; cross-tenant means cross-project. assertOwnership covers it. |
| E13 | Target deleted mid-flight | FK `on delete cascade` purges the auth row. Next `/status` returns 404 `target_not_found`. |
| E14 | Re-issue an expired challenge | `/start` returns 201 with a NEW token; old row kept with `status='expired'`. |
| E15 | User changes target.value (re-points domain) after verifying | Out of scope this sprint — the verified row stays, but TODO note: future sprint should invalidate on `targets.value` change. |
| E16 | Concurrent verify clicks (double-submit) | Rate limiter throttles; if both pass, second is a no-op because row.status is already `verified` (AD-7 + idempotent UPDATE WHERE status='pending'). |
| E17 | Tenant deleted while pending | FK `tenants.id` doesn't cascade; deletion would fail until rows manually purged. Out of scope. |
| E18 | `kind='ip'` or `'cidr'` target | All three methods reject (no DNS, no HTTPS-served well-known, no WHOIS for IP). 422 `method_incompatible_kind`. Future sprint: add `manual_attestation` method for IP/CIDR. |
| E19 | i18n key missing in one locale | `TensolDict = typeof en` enforces structural match — tsc will fail Sprint 3 if any key is missing in `ru`. (memory `feedback_apps_site_tsconfig_i18n_gotchas.md`). |

---

## 6. Open questions (≤5)

1. **Q-OQ1 — IP/CIDR targets in MVP?** Spec excludes them via E18. Do we ship an "out of scope this sprint" UI message on Step 1, or hide the menu entirely? **Default: hide on Step 1 with a banner "for IP/CIDR use manual attestation, coming next sprint".**
2. **Q-OQ2 — Email body language.** RU-only, EN-only, or both? **Default: bilingual body (EN + RU sections, single email).**
3. **Q-OQ3 — Polling tick on whois_email.** 5s × 60 ticks = 5 min. Long enough? Some MTAs delay 2–10 min. **Default: 5s × 120 ticks = 10 min, then "click to refresh manually".**
4. **Q-OQ4 — Should successful authorization auto-flip `targets.ownership_status` even if user already passed legacy `/ownership-proof`?** **Default: yes, idempotent — `WHERE ownership_status != 'verified'`.**
5. **Q-OQ5 — Does `email-confirm` require ratelimiting?** Token entropy makes brute-force impractical, but a malicious actor could DoS the redirect endpoint. **Default: add a global per-IP limiter (60 req/min) on email-confirm to prevent crawlers from flapping the audit log.**

---

## 7. Constraints reminder

- No real DNS/HTTP/WHOIS/SMTP in unit OR integration tests — all four interfaces are DI'd; tests inject mocks.
- `i18n.ts`: Generator may only edit between `// ── BEGIN:authorize ──` and `// ── END:authorize ──`. NO `as const` on `en` block.
- `tsconfig.json`: leave `allowImportingTsExtensions: true` alone.
- `gitnexus_impact` MUST be run before modifying `Database`, `RouteDeps`, `registerRoutes`, `factory.ts` (already done in this spec; Generator should re-run on the actual edits to confirm no regressions appeared).
- Cyrillic+space path: use `fileURLToPath(import.meta.url)`, not `URL.pathname`.
- JSONB columns: this sprint has none — no JSONB pitfall.
- Per-sprint conventional-commit history: one commit per sprint.

---

## 8. Generator order of operations (suggested)

1. Sprint 1 — pure verifiers + tests + types. No dependency on DB or routes.
2. Sprint 2 — migration first (`db:migrate:check` clean), then schema interface, then routes.ts wiring (factory + register-routes), then integration tests.
3. Sprint 3 — i18n keys (BOTH locales, anchors only), then `authorize-api.ts`, then `AuthorizeTarget.tsx`, then `App.tsx` route, then component tests.

After each sprint: `gitnexus_detect_changes()` to confirm scope, then commit. Hand off to Evaluator.

---

End of spec.
