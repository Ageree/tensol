# User Criteria: target-authorization-proof

## Goal

Implement the **legal lock** on the "Start scan" button: prove the user owns or is authorized to scan the target before the platform allows a scan to launch. Three verification methods, working end-to-end with backend verifiers + UI wizard + tests.

This is a **mandatory** part of MVP per the egress-isolation decision (`project_tensol_egress_isolation_decision_2026-05-09.md` — "Authorization-of-target proof is mandatory at MVP — not bureaucracy, it's the legal lock on the button (Art. 272 РФ)").

## Acceptance Criteria

### Sprint 1 — Backend verifiers (pure, mockable)

`apps/api/src/routes/targets/authorize/`:
- `dns-txt-verifier.ts`
  - `generateChallenge(targetId, domain): { token, txtRecord }` — token is `tensol-verify=<32-byte-hex>`
  - `verify(domain, expectedToken, deps: { dnsResolver }): { ok: boolean, found?: string[], reason?: string }` — uses injected DNS resolver so tests can mock
  - Honors `_tensol-verify.<domain>` subdomain (don't pollute root TXT)
- `file-upload-verifier.ts`
  - `generateChallenge(targetId, originUrl): { token, urlPath, expectedBody }` — path is `/.well-known/tensol-verify-<token>.txt`
  - `verify(originUrl, expectedToken, deps: { httpFetcher }): { ok, status?, body?, reason? }`
  - HTTPS-only (reject HTTP); 5s timeout; max 1KB body read
- `whois-verifier.ts`
  - `lookupRegistrantEmail(domain, deps: { whoisClient }): { email?: string, reason?: string }`
  - `sendVerificationEmail(email, token, deps: { mailer })` — mailer is injectable; production stub if no SMTP creds
  - `verify(token, deps: { tokenStore }): { ok, reason? }` — token comes from clicked link; stored in DB or in-memory store for now
- All three files: pure, no I/O outside injected deps, exhaustive unit tests (≥ 90% coverage on these specific files), table-driven where it makes sense.

Tests:
- `dns-txt-verifier.test.ts` — found/not-found/multiple-records/wrong-token/dns-error/timeout
- `file-upload-verifier.test.ts` — 200-match/200-mismatch/404/redirect-rejected/non-https-rejected/timeout/oversize-rejected
- `whois-verifier.test.ts` — registrant-found/none/multiple-emails/whois-server-error; mailer-called/mailer-failed; token-store-roundtrip

### Sprint 2 — Database + API routes

- New migration in `packages/db/migrations/` (find correct numbering — read latest):
  - `target_authorizations` table:
    - `id uuid pk`
    - `target_id uuid fk → targets(id) on delete cascade`
    - `method text check (method in ('dns_txt','file_upload','whois_email'))`
    - `token text not null`
    - `status text check (status in ('pending','verified','failed','expired'))`
    - `verified_at timestamptz null`
    - `expires_at timestamptz not null` (default `now() + interval '24 hours'`)
    - `attempt_count int not null default 0`
    - `last_error text null`
    - `created_at`, `updated_at` with the existing repo pattern
  - Index on `(target_id, status)`
  - Migration is reversible (down-script provided) and `db:migrate:check` clean
- API routes in `apps/api/src/routes/targets/authorize/routes.ts` (Hono — match existing factory.ts and middleware patterns):
  - `POST /v1/targets/:targetId/authorize/start` — body `{ method: 'dns_txt'|'file_upload'|'whois_email' }` → returns `{ token, instructions }` for chosen method, persists row
  - `POST /v1/targets/:targetId/authorize/verify` — runs the chosen verifier, updates row (verified or failed + last_error), returns `{ status, reason? }`
  - `GET /v1/targets/:targetId/authorize/status` — returns latest auth row for target
  - `POST /v1/targets/:targetId/authorize/email-confirm` — clicked-link endpoint for whois_email; expects `?token=...`, sets row to verified, redirects to `/projects/:p/targets/:t/authorize?confirmed=1`
- Wired into `register-routes.ts`
- Auth: must require valid session; user must own the project that owns the target (use existing middleware)
- Rate limit: max 10 verify attempts per target per hour (use existing rate-limit middleware if present, else add a simple counter on the row)
- Integration test: `routes.integration.test.ts` — happy path for each method (with mocked verifiers), unauthorized request rejected, rate-limit hit rejected

### Sprint 3 — Frontend wizard

- `apps/site/src/pages/AuthorizeTarget.tsx` — 3-step wizard mounted at `/projects/:projectId/targets/:targetId/authorize`
  - Step 1 — **Choose method**: 3 radio cards (DNS TXT / File upload / WHOIS email) with description + estimated time + "easiest if..." hint
  - Step 2 — **Instructions**: shows method-specific copy with one-click copy buttons (TXT record, file path + body, email-sent-to)
  - Step 3 — **Verify**: "Verify now" button → POST verify → loading state → success (green) or specific error (red, with retry)
- Use existing primitives only (`apps/site/src/components/primitives.tsx`). NO new design tokens.
- i18n strings in BOTH `ru` and `en` under namespace `authorize` in `apps/site/src/i18n.ts`. Use BEGIN/END comment anchors per memory `reference_parallel_agents_shared_i18n.md`.
- Add route in `App.tsx` (lazy-loaded, matching existing pattern)
- Optional polish: a "Why am I doing this?" expandable explainer that points to RU 272 УК + similar
- Component test: `AuthorizeTarget.test.tsx` — Bun test + happy-dom or @testing-library/react if already installed; verify step transitions, copy buttons, error rendering

## Constraints

- **Stack**: Bun + Hono on backend (match `apps/api/src/factory.ts`), React + react-router v7 on frontend (match `apps/site/src/App.tsx`), Postgres via `packages/db`.
- **Read existing code first** — `apps/api/src/routes/targets/targets.ts`, `apps/api/src/factory.ts`, `apps/api/src/middleware/`, `packages/db/migrations/`, `apps/site/src/components/primitives.tsx`. Match conventions, don't invent.
- **NO real DNS/HTTP/WHOIS/SMTP calls** in tests — all deps injected and mocked. Production wiring documented in code comments only.
- **i18n.ts hygiene** — no `as const` on en dict; use `// ── BEGIN:authorize ──` / `// ── END:authorize ──` anchors; ru and en shape must match exactly.
- **Coverage** ≥ 80% per global testing rules; verifier files specifically ≥ 90%.
- **gitnexus impact analysis required** before modifying any existing symbol (per project CLAUDE.md). Also use mempalace to remember findings.
- **Memory to read first**:
  - `project_tensol_egress_isolation_decision_2026-05-09.md`
  - `project_tensol_runtime_architecture.md`
  - `feedback_apps_site_tsconfig_i18n_gotchas.md`
  - `reference_parallel_agents_shared_i18n.md`
  - `project_tensol_site_apps_site.md`
- **DO NOT modify** `apps/site/src/i18n.ts` outside the new `authorize` namespace anchors. DO NOT modify any unrelated route, page, or migration.

## Definition of Done

- All three sprints PASS via Evaluator
- `bun test` green; `tsc -b` clean; `db:migrate:check` clean
- `/projects/:p/targets/:t/authorize` route renders the wizard end-to-end against a running dev server
- Conventional-commit history (one logical change per commit)
- Final summary in `.harness/target-authorization-proof/FINAL.md`
