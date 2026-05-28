# Frontend ↔ Backend v2 Contract Diff

**Task:** T080 (Phase 8 — Frontend Reconciliation, analysis-only)
**Generated:** 2026-05-19
**Sources:**
- Frontend tree: `apps/site/src/`
- Canonical API: `specs/001-backend-v2/contracts/openapi.yaml`
- Canonical webhook: `specs/001-backend-v2/contracts/webhook.md`

---

## Executive Summary

| Metric | Count |
|---|---|
| Frontend `fetch()` call sites (real, non-mock) | **4** |
| Frontend backend modules (`lib/*-api.ts`) | **1** (`lib/authorize-api.ts`) |
| OpenAPI endpoints in v2 contract | **15** (excluding `/webhooks/scan-progress`) |
| Webhook endpoints | **1** (`/webhooks/scan-progress`) |
| Total mismatches | **6** |
| ├─ CRITICAL | 3 |
| ├─ HIGH | 2 |
| ├─ MEDIUM | 1 |
| └─ LOW | 0 |
| OpenAPI endpoints with NO frontend caller | **13** |
| Frontend endpoints REMOVED from contract | **3** (legacy `/api/v1/targets/{id}/authorize/*`) |

**Headline finding:** The frontend is **almost entirely mocked** — 21 pages (Dashboard, Projects, Targets, Findings, Reports, Live, Approval, Builder, Settings, Login, Invite, Bootstrap, etc.) hardcode UI state from `data.ts` and never call the backend. The only real network integration is the `AuthorizeTarget` wizard (3 endpoints) plus the `Contact` form which posts to a Telegram relay (out-of-tree).

This means **T081 scope is much larger than a URL rename pass**: it is a from-scratch wiring effort for projects, targets, scans, findings, audit, auth — not a diff-patch over existing fetchers.

---

## Discovered Frontend Call Sites

| # | File:line | URL | Method | Body shape (FE) | Credentials | Envelope |
|---|---|---|---|---|---|---|
| 1 | `lib/authorize-api.ts:55` | `/api/v1/targets/${targetId}/authorize/start` | POST | `{ method: AuthMethod }` | `include` | `{data?, error?}` (custom) |
| 2 | `lib/authorize-api.ts:66` | `/api/v1/targets/${targetId}/authorize/verify` | POST | `{ method: AuthMethod }` | `include` | `{data?, error?}` |
| 3 | `lib/authorize-api.ts:74` | `/api/v1/targets/${targetId}/authorize/status` | GET | — | `include` | `{data?, error?}` |
| 4 | `pages/Contact.tsx:143` | `import.meta.env.VITE_CONTACT_ENDPOINT` (out-of-tree Telegram relay) | POST | `{ name, telegram, phone, consent, … }` | — | n/a |

All other `/api/*` strings in the tree (~16 hits) are **string literals embedded in mock fixtures** in `src/data.ts` or page render output (e.g. `data.ts:194` `endpoint: 'GET /api/v3/accounts/{id}/statement'`) — they describe scan targets, not Tensol's own API.

### Notable patterns

- **No shared HTTP client.** No axios, no `fetch` wrapper module, no env-driven `VITE_API_BASE_URL`. URLs are absolute paths so the dev proxy is implicit.
- **Custom response envelope.** `lib/authorize-api.ts` expects `{ error, reason }` on failure. OpenAPI v2 standard is `{ error, details }` (`ValidationError`).
- **Cookie auth assumed** (`credentials: 'include'`). Aligns with v2 `sessionCookie`.
- **No magic-link integration.** `Login.tsx` is purely visual (email + password + MFA), never calls `/api/auth/*`.

---

## Endpoint-by-Endpoint Comparison

### Auth flow

| Endpoint (v2 OpenAPI) | Method | Frontend caller | Status |
|---|---|---|---|
| `/api/auth/request-link` | POST | **none** | **CRITICAL** — Login.tsx still implements password+MFA visual flow, no magic-link UI |
| `/api/auth/verify` | GET | **none** | CRITICAL — no client redirect handler |
| `/api/auth/logout` | POST | **none** | HIGH — Settings page shows logout button (visual only) |
| `/api/auth/me` | GET | **none** | CRITICAL — no session bootstrap; app assumes logged-in mock state |

### Projects

| Endpoint | Method | Frontend caller | Status |
|---|---|---|---|
| `/api/projects` | GET, POST | **none** | HIGH — `Projects.tsx` reads `data.ts` fixtures |
| `/api/projects/{projectId}` | DELETE | **none** | HIGH |

### Targets & ownership challenge

| Endpoint | Method | Frontend caller | Status |
|---|---|---|---|
| `/api/projects/{projectId}/targets` | GET, POST | **none** | HIGH — `Targets.tsx` reads mocks |
| `/api/targets/{targetId}` | DELETE | **none** | HIGH |
| `/api/targets/{targetId}/auth-proof/challenge` | POST | **none** (legacy `start` exists in lib) | **CRITICAL** — see Mismatch #1 |
| `/api/targets/{targetId}/auth-proof/verify` | POST | **none** (legacy `verify` exists in lib) | **CRITICAL** — see Mismatch #2 |
| ~~`/api/v1/targets/{id}/authorize/start`~~ | POST | `lib/authorize-api.ts:55` | **REMOVED from contract** — Mismatch #1 |
| ~~`/api/v1/targets/{id}/authorize/verify`~~ | POST | `lib/authorize-api.ts:66` | **REMOVED from contract** — Mismatch #2 |
| ~~`/api/v1/targets/{id}/authorize/status`~~ | GET | `lib/authorize-api.ts:74` | **REMOVED from contract** — Mismatch #3 |

### Scans & findings

| Endpoint | Method | Frontend caller | Status |
|---|---|---|---|
| `/api/scans` | GET, POST | **none** | HIGH — `Builder.tsx` start-scan button is visual |
| `/api/scans/{scanId}` | GET | **none** | HIGH — `Findings.tsx` / `Live.tsx` read mocks |
| `/api/scans/{scanId}/cancel` | POST | **none** | MEDIUM |
| `/api/scans/{scanId}/audit` | GET | **none** | MEDIUM — `Reports.tsx` reads mocks |

### Webhooks (server-side only, listed for completeness)

| Endpoint | Method | FE caller (expected) | Status |
|---|---|---|---|
| `/webhooks/scan-progress` | POST | **none** (correctly — webhooks are scan-environment → server) | OK |

---

## Detailed Mismatch Findings

### Mismatch #1 — CRITICAL · Auth-proof challenge endpoint renamed

- **Frontend call:** `lib/authorize-api.ts:55` — `POST /api/v1/targets/${targetId}/authorize/start` with `{ method: 'dns_txt'|'file_upload'|'whois_email' }`
- **OpenAPI v2:** `POST /api/targets/${targetId}/auth-proof/challenge` with **no body**
- **Response delta (CRITICAL):**
  - FE expects `ChallengeData { id, method, status, expiresAt, instructions: { kind, txtRecord?, file?, email? }, alreadyVerified? }`
  - Backend v2 returns `AuthProofChallenge { id, target_id, challenge, expires_at, methods: { dns_txt, file, meta_tag } }`
  - `whois_email` **deleted** from v2; new method `meta_tag` added.
  - Response is server-driven (all three methods returned at once) vs FE per-method choice.
- **Recommended fix (T081):** rewrite `startAuth` in `authorize-api.ts` — drop the `method` request param, switch to new URL + response shape; update `AuthorizeTarget.tsx` reducer to no longer pick method up-front (or pick post-hoc from the returned `methods` map). Drop `whois_email` UI; add `meta_tag` UI.

### Mismatch #2 — CRITICAL · Auth-proof verify endpoint renamed and re-shaped

- **Frontend call:** `lib/authorize-api.ts:66` — `POST /api/v1/targets/${targetId}/authorize/verify` with `{ method }`
- **OpenAPI v2:** `POST /api/targets/${targetId}/auth-proof/verify` with **no body**
- **Response delta (CRITICAL):**
  - FE expects `{ status: string, reason?: string }`
  - Backend v2 returns `AuthProofResult { verified: boolean, method: 'dns_txt'|'file'|'meta_tag'|null, attempted: [{ method, succeeded, note? }] }`
  - 410 / 422 semantics added (no active challenge / all probes failed) — FE only handles 200 vs error.
- **Recommended fix (T081):** rewrite `verifyAuth`, swap return type; teach `AuthorizeTarget.tsx` to render the `attempted[]` list when `verified=false`.

### Mismatch #3 — CRITICAL · No status endpoint in v2

- **Frontend call:** `lib/authorize-api.ts:74` — `GET /api/v1/targets/${targetId}/authorize/status`
- **OpenAPI v2:** **not present**. There is no per-target challenge polling endpoint.
- **Impact:** `pollOnce` in `authorize-api.ts:88` (the polling loop) has no backend.
- **Recommended fix (T081):** either (a) drop polling and rely on synchronous `auth-proof/verify` response, or (b) request a `/api/targets/{id}` GET (returns `Target.status`) and poll that. Option (b) requires adding `GET /api/targets/{targetId}` to OpenAPI — out of T081 scope, surface to maintainer.

### Mismatch #4 — HIGH · Login page does not call backend

- **Frontend:** `pages/Login.tsx:18` — `submit()` is pure local state, navigates to `/dashboard` on click. Password + 6-digit MFA fields are decorative.
- **OpenAPI v2:** magic-link only — `POST /api/auth/request-link` → email → `GET /api/auth/verify?token=…` redirect.
- **Recommended fix (T081):**
  - Replace password / MFA fields with a single email + "send link" button.
  - On submit: `POST /api/auth/request-link { email }`; show "check your inbox" confirmation.
  - Handle `/api/auth/verify?token=…` redirect via a `<Route path="/auth/verify">` that posts back, then navigates to `/dashboard`.
  - Remove `Invite.tsx` MFA second-step UI or repurpose it for the inbox-confirmation screen.

### Mismatch #5 — HIGH · Entire CRUD surface is mocked

- **Frontend:** `Projects.tsx`, `Targets.tsx`, `Builder.tsx`, `Findings.tsx`, `Reports.tsx`, `Live.tsx`, `Approval.tsx`, `Dashboard.tsx`, `Settings.tsx` all read `src/data.ts` fixtures.
- **OpenAPI v2:** 11 endpoints exist covering projects, targets, scans, findings, audit, cancel.
- **Recommended fix (T081):**
  - Add a thin client wrapper `lib/api-client.ts` (axios or typed fetch) with the v2 response envelope (`ValidationError`).
  - Add `lib/projects-api.ts`, `lib/targets-api.ts`, `lib/scans-api.ts`, `lib/findings-api.ts`, `lib/auth-api.ts` mirroring `lib/authorize-api.ts` style.
  - Replace mock reads page-by-page; `data.ts` stays only as a Storybook/fallback artifact.

### Mismatch #6 — MEDIUM · Response envelope contract drift

- **Frontend `parseEnvelope`** (`lib/authorize-api.ts:36`) reads `body.error` OR `body.reason` on non-2xx.
- **OpenAPI v2 `ValidationError`** returns `{ error, details }` (no `reason`).
- **Recommended fix (T081):** drop `reason` fallback, add `details[]` rendering. Centralize in the shared `api-client.ts`.

---

## Action Plan for T081

Ordered list (sequential dependencies marked `→`).

1. **Build shared HTTP client** — `apps/site/src/lib/api-client.ts` with `fetch` wrapper, v2 envelope, error mapping, `credentials: 'include'`. ← unblocks all downstream.
2. **Re-wire AuthorizeTarget** (Mismatch #1, #2, #3) → `lib/authorize-api.ts`:
   - Rename to `auth-proof-api.ts` (or keep filename, swap internals).
   - New URL prefix `/api/targets/{id}/auth-proof/{challenge,verify}`.
   - New types `AuthProofChallenge`, `AuthProofResult`.
   - Update `pages/AuthorizeTarget.tsx` reducer / steps; drop method-picker (or move to post-issuance).
   - Drop `whois_email`, add `meta_tag`.
   - Remove `pollOnce` or repoint to `GET /api/targets/{id}`.
3. **Rewrite Login flow** (Mismatch #4):
   - `pages/Login.tsx` → email-only form → `POST /api/auth/request-link`.
   - New route `pages/AuthVerify.tsx` handling `/auth/verify?token=…`.
   - Add `lib/auth-api.ts` with `requestLink`, `verifyToken`, `me`, `logout`.
   - Session bootstrap: `GET /api/auth/me` on app mount; route guard.
   - Remove/repurpose `pages/Invite.tsx` MFA UI.
4. **Wire Projects** (Mismatch #5a): `lib/projects-api.ts` + replace `data.ts` reads in `pages/Projects.tsx`, `Dashboard.tsx`.
5. **Wire Targets + verification status surfacing** (Mismatch #5b): `lib/targets-api.ts`, replace mocks in `pages/Targets.tsx`, `Builder.tsx`.
6. **Wire Scans** (Mismatch #5c): `lib/scans-api.ts` for list/create/get/cancel; replace `pages/Builder.tsx` (start), `pages/Live.tsx` (in-flight view).
7. **Wire Findings + Audit** (Mismatch #5d): `lib/scans-api.ts.getScan(id)` returns `ScanDetail` with findings inline; `pages/Findings.tsx`, `pages/Reports.tsx` consume.
8. **Centralize ValidationError envelope** (Mismatch #6): once `lib/api-client.ts` lands, all per-resource libs inherit it.
9. **Out-of-scope, flag to maintainer:**
   - `GET /api/targets/{targetId}` does not exist in OpenAPI but is useful for polling — consider adding.
   - No `POST /api/auth/logout` is called anywhere visible; settings page logout button needs wiring.
   - `Contact.tsx` Telegram relay is out-of-tree and stays as-is.

---

## Surprises

1. **Frontend is 95% mock** — the apparent UI completeness (21 pages, all routes live) masks the fact that only the auth-proof wizard talks to a backend.
2. **No env-driven API base URL** — no `VITE_API_BASE_URL`; pages assume same-origin dev proxy. Backend v2 deployment will need a Vite proxy entry or relative paths must be preserved.
3. **`whois_email` is dead** — FE supports a third proof method that v2 deleted in favor of `meta_tag`.
4. **Login is purely cosmetic** — has password + MFA inputs that go nowhere; v2 is magic-link only, so the UI design needs a real rewrite, not a wire-up.
5. **Custom envelope drift** — FE's `{data?, error?}` envelope is not what v2 standardized (`{error, details}`); shared client must reconcile.
6. **`src/data.ts` references mock target endpoints** (`/api/v3/accounts/...`) that are part of the *scanned product's* API, not Tensol's API — these are not mismatches, just visual noise during grep.
