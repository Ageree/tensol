# Security Review 2026-05 — Blackbox MVP (002)

**Reviewer**: automated review pass (driver-loop subagent)
**Date**: 2026-05-20
**Scope**: `002-blackbox-mvp` branch as of commit `b593435`
**Task**: T145 (polish phase) — manual review of 4 security surfaces

This pass reviews four surfaces called out in `tasks.md` T145:
(a) outbound/inbound webhook HMAC, (b) magic-link auth rate limits,
(c) DNS-TXT verify resolver hardening, (d) Deep inquiry scope_text
sanitization regex coverage. Findings are concrete, with file:line
references where load-bearing. No code modifications are made by this
review — only documentation. Follow-ups are filed against the polish
backlog.

---

## (a) Webhook HMAC Implementation

### Surface

| Side     | File                                                                       | Commit    |
| -------- | -------------------------------------------------------------------------- | --------- |
| Outbound | `vps-agent/src/webhook-sign.ts`                                            | `8665d8e` |
| Inbound  | `server/src/routes/webhooks-scan-complete.ts`                              | `cc3a9b7` |
| Contract | `server/tests/.../webhook-contract.test.ts`, `vps-agent/tests/webhook-contract.test.ts` (`192e48a`) | —         |

Header envelope: `X-Tensol-Signature: t=<unix-sec>, v1=<lowercase hex hmac_sha256(secret, "${t}.${rawBody}")>`.
Mirrors Stripe's `Stripe-Signature` shape.

### What's good

- **Timing-safe comparison** via `crypto.timingSafeEqual` (`webhooks-scan-complete.ts:273`) — no early-exit byte compare.
- **Replay window**: ±5 min strict drift check (`webhooks-scan-complete.ts:117,244`); requests outside the window emit a `webhook_invalid_signature` audit row with `reason: "stale_timestamp"` (line 247) so SOC sees replay attempts.
- **Validation order is correct and tight** (file header lines 27–49):
  signature parse → drift → HMAC → JSON.parse → Zod → idempotency → state — HMAC runs BEFORE any DB mutation per Constitution II.
- **Byte-exact mirror** verified by golden vector (`vps-agent/tests/webhook-contract.test.ts:37–40, 153–164`): `GOLDEN_TS=1716000000, GOLDEN_BODY='{"hello":"world"}', GOLDEN_HEX=794bc6…fc28e`. Both sides pinned.
- **Raw body bytes used** (`webhooks-scan-complete.ts:213`, `webhook-sign.ts:62–68`): server reads `c.req.text()` (not `c.req.json()`), agent encodes via `Buffer.from(...,"utf8")` and `Buffer.concat`. No re-canonicalisation drift.
- **Header parser tolerance is symmetric on both sides** (whitespace around `,`, key ordering, hex case) and pinned by contract tests `218–249`.
- **Audit row on rejection logs only signature LENGTH** (`webhooks-scan-complete.ts:283`), never the offending bytes — good defensive logging.
- **Probe path is silent** (`webhooks-scan-complete.ts:227–236`): missing/malformed header → bare 401 with no audit row, by design to avoid log flooding from scanners.

### Concerns

1. **MEDIUM — Idempotency dedup is O(n) LIKE-scan over `audit_log`.**
   `webhooks-scan-complete.ts:333–341` uses
   `metadata_json LIKE '%"scan_order_id":"…"%'` against the entire audit
   chain. Safe (26-char ULIDs make collisions impossible) but each
   webhook call scans the table. At ~1k orders this is fine; at 100k+ it
   becomes a hot path. **Recommendation:** add a dedicated
   `webhook_dedup(scan_order_id PK, received_at)` table or a partial
   index on `audit_log(event, metadata_json)`. Defer to T07x (production
   scale).

2. **MEDIUM — No documented secret-rotation playbook.**
   `TENSOL_WEBHOOK_SECRET` is shared across the entire VPS fleet
   (single-secret fleet model per `webhook-sign.ts:21–24`). The 001-era
   V1 path used per-VPS sign keys; V2 traded that for operational
   simplicity. **Recommendation:** add a runbook entry covering: (i)
   rotate `TENSOL_WEBHOOK_SECRET` on the server, (ii) bake the new
   secret into the next cloud-init template, (iii) keep both secrets
   live for one ±5min window via a `prev_secret` env (NOT currently
   supported — small server change needed). Filed as polish backlog.

3. **LOW — Crash-recovery between findings ingest and state transition.**
   Documented inline (`webhooks-scan-complete.ts:404–411`): if the
   process crashes between step 8 (ingest) and step 10 (audit anchor),
   a retry will see no `webhook_received` audit row, skip neither step,
   and may produce duplicate finding rows since `findings/ingest.ts`
   does not dedupe. The window is small (process crash mid-callback)
   but the comment defers to T07x. **Recommendation:** add a
   `findings.dedup_key UNIQUE` column derived from `(scan_id, slug)`
   so retry ingest is naturally idempotent. Defer.

4. **LOW — Bare 401 on probe path means probing IS unobservable.**
   By design (lines 227–236) but worth flagging: an attacker who never
   sends a syntactically valid `X-Tensol-Signature` will produce zero
   audit rows. The standard HTTP request log catches it, but a SOC
   query against `audit_log.event='webhook_invalid_signature'` will
   underreport. Documented choice; no action required.

### Recommendation

**LOW-RISK overall.** Production-ready. The two MEDIUM items are
operational (runbook + scaling) rather than correctness gaps. The
contract test (`192e48a`) gives strong regression guarantees.

---

## (b) Magic-link Auth Rate Limits

### Surface

| File                              | Commit (most recent) | Role                                  |
| --------------------------------- | -------------------- | ------------------------------------- |
| `server/src/auth/magic-link.ts`   | T021 (001-era)       | issueLink / verifyLink primitives     |
| `server/src/auth/middleware.ts`   | T023 (001-era)       | `requireAuth` session gate            |
| `server/src/routes/auth.ts`       | T026 (001-era)       | `/api/auth/{request-link,verify,me,logout}` HTTP routes |

### What's good

- **Tokens are HMAC-hashed at rest** (`magic-link.ts:117, 166`): DB column stores `hmacSha256(signingKey, rawToken)`, raw token only ever returned once to the caller. A DB snapshot leak does not yield usable tokens without the signing key. Strong design.
- **Atomic redemption via `withTx` + condition-on-unused UPDATE** (`magic-link.ts:175–197`): two concurrent verifies on the same token serialise; loser sees `usedAt != NULL` and gets a typed `{ ok:false, reason:"used" }`.
- **Enumeration safety** at HTTP layer (`auth.ts:106–164`):
  - Every POST `/request-link` returns 204, regardless of email validity or downstream error (try/catch wrapping issueLink + email.send at lines 136–159).
  - GET `/verify` collapses `{invalid, used, expired}` to a single 410 (`auth.ts:182–187`) — attacker cannot distinguish "never existed" from "already redeemed".
- **Token TTL = 15 min** (`magic-link.ts:58`); session TTL = 30 days (line 59); both injectable per-test.
- **Invalid token attempts are NOT audited** (`magic-link.ts:258`) — anti-log-flooding for probing attackers. Reasonable.
- **Token entropy**: `randomToken(32)` = 256 bits, base64url. Strong.
- **Session middleware fails closed on orphan sessions** (`middleware.ts:108–112`) — defensive if FK cascade window opens.

### Concerns

1. **MEDIUM — No rate-limit middleware exists anywhere in `server/src/`.**
   Confirmed by `grep -rn "throttle\|RateLimit\|rate.limit\|rateLimit" server/src/` — zero hits in route handlers or middleware. The only hits are (i) a developer comment in `middleware.ts:32` calling rate-limit explicitly out-of-scope for T023, (ii) handler heuristics for upstream cloud-provider 429s in VM spawn jobs. **This means**:
   - POST `/request-link` can be flooded by an attacker to (a) spam any email address with magic-link mail (reputation/abuse vector against Resend account, and harassment vector against arbitrary users), (b) burn DB rows in `magic_link_tokens`.
   - GET `/verify?token=…` can be brute-forced. With 256-bit token entropy the probability of guessing is negligible (~$2^{-256}$ per request), so this is operationally moot, but a flood of `/verify` requests can still DoS the SQLite write path.
   - POST `/logout`, GET `/me` — authenticated routes; abuse limited to authenticated users but still uncapped.
   **Recommendation:** add a thin per-IP + per-email throttling middleware:
   - `/request-link`: per-IP **5/min**, per-email-hash **3/hour** (sliding window).
   - `/verify`: per-IP **10/min**.
   - Global: 1000 req/min per IP across all `/api/*`.
   Hono ecosystem has `hono-rate-limiter` with a SQLite store; alternative is a hand-rolled `rate_limits(key, window_start, count)` table — ~50 LOC. **Severity: MEDIUM** because token entropy mitigates the cryptographic attack but email-flood and DB-write-flood remain real.

2. **MEDIUM — `request-link` echoes "downstream failure" to stderr** (`auth.ts:158`).
   On a misconfigured Resend key or rate-limit hit upstream, every request will log the bounce reason. A noisy stderr is not a vulnerability but it's a useful side-channel for an attacker who can grep logs. Pure logging hygiene; consider scrubbing or rate-limiting the log line itself.

3. **LOW — `expires_at` boundary inclusive on past side** (`middleware.ts:100`): `now >= expires_at` treats `==` as expired. Documented intentionally. No action.

4. **LOW — Sessions are never invalidated server-side except via `/logout`.**
   No session-revocation table, no kill switch on user password change (there is no password). If a session cookie leaks, attacker has it for up to 30 days. Mitigation is the `secure + httpOnly + SameSite` cookie posture (per `session.ts` — not re-read here, was clean in 001 audit). **Recommendation:** add an `admin/revoke-session` action; defer to a future feature.

### Recommendation

**MEDIUM**. Token primitives are strong (HMAC-at-rest, atomic redeem, enumeration-safe). The missing rate-limit layer is the dominant residual risk. File a polish task: "Add per-IP + per-email throttling middleware on `/api/auth/{request-link,verify}`".

---

## (c) DNS Verify Resolver Hardening

### Surface

| File                                  | Commit    | Role                                |
| ------------------------------------- | --------- | ----------------------------------- |
| `server/src/dns-verify/resolver.ts`   | `a03ae73` | T032 — pure TXT resolver, 4-way agreement |
| `server/src/dns-verify/service.ts`    | `3fc71f3` | T034 — state machine, audit, timeout |

### What's good

- **Unanimous-4/4 agreement per §R6 / FR-009** (`resolver.ts:25–30, 108–112`): queries 1.1.1.1 + 1.0.0.1 (Cloudflare) AND 8.8.8.8 + 8.8.4.4 (Google). Two-vendor independence defeats single-vendor spoofing AND single-vendor outages cause "not yet verified" rather than false-positive verification — fail-closed.
- **Per-resolver timeout 5s** (`resolver.ts:32, 92`) with `Promise.race` + `unref()` (lines 56–72) so a stuck resolver never blocks the others AND never blocks process exit.
- **`Promise.allSettled` collects all results** (`resolver.ts:103`); on ANY failure the entire batch collapses to `null` (lines 109–111). No partial-quorum approval — matches Constitution II (scope-of-authorization fails closed).
- **Intersection-not-union** (`resolver.ts:117–124`): only records present in EVERY resolver's reply survive. A split-DNS attacker who controls one upstream cannot inject a TXT record into the agreed set.
- **30-min hard timeout** per `data-model.md` E2 (`service.ts:39, 191–213`) with `dns_verify_failed` audit row.
- **Token format** `tensol-verify-<26-char-ULID>` (`service.ts:80–82`): 130-bit Crockford entropy in the random portion, with deterministic project-namespace prefix. ULID-based rather than orderId-derived (line 73–78 rationale) — leaking the orderId does not leak the verification token.
- **Dev bypass is strict-equality** (`service.ts:154`): `process.env.TENSOL_DEV_DNS_BYPASS === "true"` — `"1"`, `"yes"`, `"TRUE"` do NOT enable it. Resilient against accidental enabling.
- **Idempotent on already-verified orders** (`service.ts:138–146`): no resolver call, no extra audit row. Callers can poll freely.

### Concerns

1. **LOW — Default `node:dns` Resolver, no IPv4-only override.**
   `resolver.ts:91` uses `new dnsPromises.Resolver()` with default options. `resolveTxt` does not actually do A/AAAA work (TXT is a different RR type) so there is no IPv6-address-family concern at the data level. However: `Resolver.setServers(['1.1.1.1'])` (line 96) means we always query the resolver over IPv4. On an IPv6-only host, the UDP/TCP queries would fail with `EREFUSED`/`ENETUNREACH`. **Recommendation:** production must have IPv4 egress. For driver dev hosts, this could surface as flaky verification on an IPv6-only network — document in `quickstart.md` as a known gotcha.

2. **LOW — Slow-resolver DoS surface.**
   The 5s timeout is per-resolver, all 4 run concurrently → worst case ~5s wall time per call. The route layer polls every N seconds (UI flow); if four resolvers all hang to timeout repeatedly, the server's event loop is fine but a single client polling holds open connections. **Recommendation:** cap concurrent verification polls per user (covered by the rate-limit task in surface (b)).

3. **LOW — Resolver error message surfaced verbatim in `lastError`** (`service.ts:224`).
   The `(e as Error).message` from `node:dns` typically looks like `queryTxt ENOTFOUND example.com`. Safe to surface (no secrets), but mildly leaky as a fingerprinting signal (attacker can learn that the server uses `node:dns`). Low impact; trivial to scrub if desired.

4. **INFO — No DNSSEC validation.**
   `node:dns` does not do DNSSEC by default; we rely on TLS-to-resolver only insofar as the resolver supports DoH/DoT (1.1.1.1 + 8.8.8.8 both do, but we use plain UDP/53 via `setServers`). A nation-state on-path attacker between our server and ALL FOUR resolvers could in principle spoof. The two-vendor unanimous rule raises the bar to "attacker controls path to both Cloudflare AND Google networks", which is a very strong threat model. **Recommendation:** acceptable for MVP; consider DoH (DNS-over-HTTPS) to 1.1.1.1 + 8.8.8.8 in a follow-up for defense in depth.

### Recommendation

**LOW-RISK**. The unanimous-4/4 design is the correct shape. The two LOW concerns (IPv6-only host, slow-resolver DoS) are operational. DNSSEC/DoH is a future hardening, not a blocker for MVP.

---

## (d) Deep Inquiry Sanitization Regex Coverage

### Surface

| File                                       | Commit    | Role                            |
| ------------------------------------------ | --------- | ------------------------------- |
| `server/src/deep-inquiries/sanitize.ts`    | `2152d7e` | T098 — credential redactor      |
| `server/src/deep-inquiries/sanitize.test.ts` | T098     | 25+ unit assertions             |

### What's good

- **8 redaction rules** covering: (1) key:value passwords/secrets/api_key/token, (2) `Bearer <token>` per RFC 6750, (3) URL basic-auth, (4) AWS access key IDs (`AKIA…`), (5) GitHub PATs (`ghp_/gho_/ghu_/ghs_/ghr_`), (6) Slack tokens (`xox[bpoars]-…`), (7) Anthropic keys (`sk-ant-…`), (8) OpenAI keys (`sk-…`).
- **Anthropic-before-OpenAI ordering** (`sanitize.ts:69–80`) — the `sk-` rule is positioned AFTER `sk-ant-` so Anthropic-shaped strings are not over-matched by the generic OpenAI prefix.
- **Conservative philosophy** (file header `1–14`): deliberately skips entropy-based heuristics to avoid false positives on legit scope text. Documented rationale: asset names, hashes, JWT identifiers in prose.
- **Preserves prose context**: only the value is redacted; key stays visible so operators can audit *which* secret class leaked. Tests `120–129` confirm "strong password policy" prose is untouched.
- **Idempotent**: applying sanitize to already-sanitized text is a no-op (rules don't match `[REDACTED]` literal).
- **Test coverage** is thorough: 25+ assertions including negative cases, multi-rule single-input, case sensitivity, dashed variants, all 5 GitHub PAT prefixes.

### Concerns

1. **MEDIUM — JWT tokens (eyJ…) not detected by a dedicated rule.**
   JWTs are caught indirectly when they appear after `Bearer ` (rule 2) or after a `token:` key, but a bare JWT in scope text — e.g. *"the staging system rejects JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.foo"* — will pass through. JWTs are extremely common in scope text and frequently leak secrets (signed claims include sub/email/role). **Recommendation:** add a JWT-shape rule:
   ```
   /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g → REDACTED
   ```
   Trade-off: a legitimate "JWT" mentioned in prose without the three-part structure stays unmatched, so false-positive rate is low.

2. **MEDIUM — SSH private keys not detected.**
   `-----BEGIN OPENSSH PRIVATE KEY-----` / `-----BEGIN RSA PRIVATE KEY-----` / `-----BEGIN EC PRIVATE KEY-----` blocks would survive sanitization unchanged. While unlikely to be pasted into scope text, the consequence (full key disclosure) is severe enough to warrant a rule:
   ```
   /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) (?:PRIVATE KEY|MESSAGE)-----[\s\S]+?-----END [^-]+-----/g → REDACTED
   ```
   **Severity: MEDIUM** because of consequence, even though incidence is rare.

3. **MEDIUM — Connection-string embedded passwords beyond `https://` basic-auth.**
   Rule 3 covers `https?://user:pass@host`. It does NOT cover:
   - `postgres://user:pass@host:5432/db`
   - `mongodb://user:pass@host/db`
   - `redis://:pass@host:6379` (no user, only password)
   - `mysql://user:pass@host/db`
   These are likely-to-appear in scope text ("our DB is at postgres://app:hunter2@db.example/prod"). **Recommendation:** broaden rule 3:
   ```
   /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]*):([^@/\s]+)@/g
   ```
   to cover any scheme. Validate negative cases (`file://foo:bar/baz` is not basic-auth — would be a false positive, but `file://` URLs in scope text are vanishingly rare).

4. **LOW — Generic high-entropy strings deliberately skipped** (`sanitize.ts:11–14`).
   This is a documented design choice (false-positive avoidance on hashes/asset-names). Accept; document in operator runbook so operators know to manually scrub anything entropic that doesn't match a known shape.

5. **LOW — Google service-account keys / GCP API keys not detected.**
   - GCP API keys: `AIza[0-9A-Za-z\-_]{35}`
   - Stripe live keys: `sk_live_[0-9a-zA-Z]{24,}`
   - Stripe restricted: `rk_live_…`, `pk_live_…`
   These are well-known shapes worth adding for ecosystem parity with rules 4–7. After the international pivot, Stripe/GCP-style secret detection is more important and should be included in the next sanitizer/secret-scan pass.

6. **LOW — Replacement does not preserve quote characters.**
   Input `password = "secret-value"` becomes `password = [REDACTED]` (quotes dropped — test `15–19`). Cosmetic; some operators may prefer `password = "[REDACTED]"` for readability. No security impact.

### Recommendation

**MEDIUM**. The 8 rules cover canonical shapes well, and the conservative philosophy is sound. The dominant gap is JWT (commonly leaked in scope text) and SSH private keys (severe consequence). File polish tasks for: (i) JWT rule, (ii) SSH PEM block rule, (iii) generic scheme:// basic-auth widening.

---

## Summary

| Surface                 | Findings (CRIT / MED / LOW / INFO) | Verdict           |
| ----------------------- | ---------------------------------- | ----------------- |
| (a) Webhook HMAC        | 0 / 2 / 2 / 0                      | LOW-RISK, ready   |
| (b) Magic-link auth     | 0 / 2 / 2 / 0                      | MEDIUM — no rate limits |
| (c) DNS verify resolver | 0 / 0 / 3 / 1                      | LOW-RISK, ready   |
| (d) Scope-text sanitize | 0 / 3 / 3 / 0                      | MEDIUM — coverage gaps |

**Totals: 0 CRITICAL, 7 MEDIUM, 10 LOW, 1 INFO.**

### Top three concerns

1. **Missing rate-limit middleware on `/api/auth/*`** (surface b, finding 1).
   Real-world abuse vector — email-flood + DB-write-flood. No
   cryptographic exposure thanks to 256-bit tokens, but operationally
   important. Add per-IP + per-email throttling.

2. **Scope-text sanitizer misses JWT and SSH private-key shapes** (surface d, findings 1 + 2).
   Both are common-enough leaks in customer-pasted scope text that the
   incremental rules are clearly worth adding.

3. **Webhook idempotency uses LIKE-scan on `audit_log`** (surface a, finding 1).
   Fine at MVP scale, becomes a hot path at production scale. Plan a
   dedicated dedup table or index.

### Items to file as polish tasks

- `T146` (proposed): rate-limit middleware on `/api/auth/{request-link,verify}` (per-IP + per-email).
- `T147` (proposed): extend `sanitize.ts` rules with JWT, SSH PEM block, broaden basic-auth scheme.
- `T148` (proposed): add `webhook_dedup` table OR partial index on `audit_log` for production scale.
- `T149` (proposed): operator runbook entry for `TENSOL_WEBHOOK_SECRET` rotation.

### No blockers found

No CRITICAL findings. The four surfaces are production-acceptable for
MVP. The MEDIUM items above are polish/hardening, not gating defects.

**End of review.**
