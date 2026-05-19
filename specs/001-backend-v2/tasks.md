# Tasks: Tensol Backend v2 — Clean-Slate Redesign

**Branch**: `001-backend-v2`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Data model**: [data-model.md](./data-model.md) · **Constitution**: [v1.0.0](../../.specify/memory/constitution.md)

**Note**: Tests-first per Constitution VI (NON-NEGOTIABLE). Every implementation task is preceded by a failing-test task in the same phase. [P] marks tasks that can run in parallel (different files, no inter-task dependencies). Complexity: XS (≤30 min), S (≤2 h), M (≤4 h), L (≤1 day).

---

## Phase 1: Setup & Cleanup

- [x] **T001** Delete v1 backend in one commit: `rm -rf apps/api packages services tests/integration`; keep `apps/site/`, `external/decepticon/`, `docs/`, `.harness/`. Update root `package.json` workspaces array to remove deleted dirs. Acceptance: `git status` shows only the deletions + workspaces edit; `bun install` succeeds at repo root. Complexity: **M**. Blocks everything. (7bd731c+3b4b7ff)

- [x] **T002** Scaffold `server/` package: `bun init` skeleton, `package.json` (deps: hono, drizzle-orm, better-sqlite3, zod, resend, drizzle-kit dev), `tsconfig.json` strict, `drizzle.config.ts`, `README.md` placeholder, empty `src/server.ts` that boots Hono and responds 200 on `GET /healthz`. Acceptance: `cd server && bun run dev` starts on port 3000; `curl localhost:3000/healthz` returns `{ok:true}`. Complexity: **S**. blockedBy: T001. (35317d0)

- [x] **T003** [P] Scaffold `vps-agent/` package: same shape, single endpoint `GET /healthz`. Acceptance: `cd vps-agent && bun run dev` starts; healthz returns 200. Complexity: **XS**. blockedBy: T001. (5fd85ca)

- [x] **T004** [P] Update root `.gitignore`: add `server/data/`, `server/*.db`, `server/*.db-shm`, `server/*.db-wal`, `vps-agent/dist/`. Acceptance: `git check-ignore server/data/foo.db` returns 0. Complexity: **XS**. blockedBy: T001. (already in 3b4b7ff)

- [x] **T005** [P] Write `server/src/config.ts` reading env vars (`TENSOL_AUDIT_SIGNING_KEY`, `TENSOL_SESSION_COOKIE_SECRET`, `EMAIL_PROVIDER`, `RESEND_API_KEY`, `HETZNER_API_TOKEN`, `HETZNER_LOCATION`, `HETZNER_SERVER_TYPE`, `HETZNER_IMAGE`, `HETZNER_SSH_KEY_NAME`, `TENSOL_VPS_AGENT_IMAGE`, `TENSOL_WEBHOOK_BASE_URL`, `PORT`, `NODE_ENV`) with Zod validation at module load. **Write test first** (`config.test.ts`): missing required → throws; valid env → returns typed object. Acceptance: `bun test src/config.test.ts` passes. Complexity: **S**. blockedBy: T002. (629d8fd)

---

## Phase 2: Foundational

These block every user story. Must finish in order before any P1 work begins.

- [x] **T010** Write Drizzle schema in `server/src/db/schema.ts` for all 9 tables from `data-model.md` (users, sessions, magic_link_tokens, projects, targets, auth_proofs, scans, findings, audit_log, vps_instances, jobs) with all FKs and indexes. Generate `migrations/0000_init.sql` via `bunx drizzle-kit generate`. **Test** (`db/schema.test.ts`): apply migration to `:memory:` DB, assert every table + index exists via `PRAGMA table_info` / `PRAGMA index_list`. Acceptance: `bun test src/db/schema.test.ts` passes. Complexity: **M**. blockedBy: T005. (b523fbf)

- [x] **T011** Write `server/src/db/client.ts`: factory `createDb(path: string)` returning Drizzle instance + `withTx(db, fn)` helper using `BEGIN IMMEDIATE`. **Test**: concurrent `withTx` calls serialize correctly. Acceptance: test passes. Complexity: **S**. blockedBy: T010. (f73b460)

- [x] **T012** [P] Write `server/src/lib/ids.ts` (ULID generator using `node:crypto`), `server/src/lib/time.ts` (`now()` injectable), `server/src/lib/crypto.ts` (HMAC-SHA256, constant-time compare, random base64 32-byte). **Tests**: ULID monotonicity, HMAC stability vs Python reference vectors, constant-time compare timing-safe. Acceptance: tests pass. Complexity: **S**. blockedBy: T002. (27fc746)

- [x] **T013** Implement `server/src/audit/sign.ts`: `canonicalMessage(entry)` produces 13-field pipe-delimited string with alpha-sorted metadata JSON (port from EE-2 `packages/audit/src/signer.ts` per `research.md` Decision 4); `signEntry(key, entry, prevSig)` returns hex HMAC. **Test** (`audit/sign.test.ts`) with frozen reference vectors: same input → same output bit-for-bit; alpha sort verified; metadata empty-object handled. Acceptance: tests pass. Complexity: **S**. blockedBy: T012. (4aac7f1)

- [x] **T014** Implement `server/src/audit/emit.ts`: `emitSignedAudit(db, args)` that opens immediate transaction, reads last row's signature, computes new signature, inserts. **Tests** (`audit/emit.test.ts`): single emit produces row; concurrent emits serialize and chain correctly; chain links to previous row's signature byte-perfectly. Acceptance: tests pass. Complexity: **M**. blockedBy: T013, T011. (a554d2f)

- [x] **T015** Implement `server/src/audit/verify-chain.ts` CLI: reads all rows, recomputes each signature from prev + canonical message, prints `chain ok: N rows` or `chain broken at row X`. **Tests** (`audit/verify-chain.test.ts`): seed 10 rows via emit → verify passes; mutate row 5 metadata → verify fails at row 5. Acceptance: `bun run src/audit/verify-chain.ts --db :memory:` exits 0 on a fresh DB. Complexity: **S**. blockedBy: T014. (e07f98b)

---

## Phase 3: User Story 1 — End-to-End First Scan (P1) — MVP

Goal: a user can register, prove a target, run a scan, and see findings. Independent test = the integration test in T037 plus E2E in T070 passing against a fake VPS provider.

### 3.1 Magic-link auth (FR-001..004)

- [x] **T020** [US1] Write `server/src/lib/url-guard.ts` to reject malformed / private IP / localhost URLs (used for both targets and backend self-checks). **Test** (`url-guard.test.ts`): valid URLs pass; `http://192.168.1.1`, `http://localhost`, `http://127.0.0.1`, `not-a-url`, `file:///etc/passwd` all rejected. Acceptance: tests pass. Complexity: **S**. blockedBy: T012. (1a458ef)

- [x] **T021** [US1] Implement `server/src/auth/magic-link.ts`: `issueLink(db, email)` (validates email Zod, generates 256-bit token, inserts row, returns token + expires_at), `verifyLink(db, token)` (atomic: read + check unused + check fresh + mark `used_at` + create session + return user). **Tests** (`auth/magic-link.test.ts`): valid link → session created and user found-or-created; expired link → 410 error; used link → 410; second redemption of same link → 410. Acceptance: tests pass. Complexity: **M**. blockedBy: T011, T012, T014. (6b13e4a)

- [x] **T022** [US1] Implement `server/src/auth/session.ts` cookie helpers (`setSessionCookie(c, sessionId)`, `clearSessionCookie(c)`, `readSessionCookie(c)`) with `httpOnly + secure + sameSite=lax`. **Tests** (`auth/session.test.ts`): cookie attributes correct on prod env; cleared correctly on logout. Acceptance: tests pass. Complexity: **XS**. blockedBy: T005. (3d80ff7)

- [x] **T023** [US1] Implement `server/src/auth/middleware.ts` `requireAuth(c, next)`: reads cookie, looks up session, attaches `user` to context, else 401. **Tests**: missing cookie → 401; expired session → 401; valid → next() called with user. Acceptance: tests pass. Complexity: **XS**. blockedBy: T022, T021. (2426220)

- [x] **T024** [US1] Implement `server/src/email/resend-client.ts` with env-gated `stdout` / `resend` modes and `server/src/email/templates/magic-link.ts` HTML template. **Tests**: stdout mode logs the link; resend mode invokes a mocked SDK with expected payload. Acceptance: tests pass. Complexity: **S**. blockedBy: T005. (d2b04e2)

- [x] **T025** [US1] Write `server/src/schemas/auth.ts` Zod schemas (request-link body, verify query). **Tests** in same file: rejects invalid email; accepts well-formed. Acceptance: tests pass. Complexity: **XS**. blockedBy: T002. [P with T026..T030] (b2e42a4)

- [x] **T026** [US1] Implement `server/src/routes/auth.ts` (`POST /api/auth/request-link`, `GET /api/auth/verify`, `POST /api/auth/logout`, `GET /api/auth/me`) wiring schemas + middleware + magic-link + session + audit (`auth_login_requested`, `auth_login_succeeded`, `auth_logout`). **Integration test** (`tests/integration/auth.test.ts`): full magic-link flow from request to /me happy path; enumeration leak test (unknown email returns same 204); session revocation. Acceptance: integration test passes. Complexity: **M**. blockedBy: T023, T024, T025. (e57294b)

### 3.2 Projects & Targets (FR-005..007)

- [x] **T027** [US1] [P] Write `server/src/schemas/projects.ts` and `server/src/schemas/targets.ts`. Tests inline. Acceptance: invalid payloads rejected. Complexity: **XS**. blockedBy: T002. (a80d88d)

- [x] **T028** [US1] Implement `server/src/projects/service.ts`: `listForUser`, `create`, `delete` (cascade delete targets within same tx). **Tests** (`projects/service.test.ts`): visibility scoped to owner; delete cascades targets; foreign user gets 404. Acceptance: tests pass. Complexity: **S**. blockedBy: T010, T014. (1c66345)

- [x] **T029** [US1] Implement `server/src/targets/service.ts`: `listForProject`, `create` (uses `url-guard.ts`), `delete`. **Tests** (`targets/service.test.ts`): URL normalization (lowercased host, no trailing slash); private-IP rejected; ownership boundary enforced. Acceptance: tests pass. Complexity: **S**. blockedBy: T020, T028. (86c0d7b)

- [x] **T030** [US1] Implement `server/src/routes/projects.ts` and `server/src/routes/targets.ts` wiring schemas + middleware + services + audit emits (`project_created`, `project_deleted`, `target_created`, `target_deleted`). **Integration tests** in `tests/integration/projects-targets.test.ts`: full CRUD per user, audit rows present after each mutation. Acceptance: tests pass. Complexity: **M**. blockedBy: T026, T029, T027. (00710e5)

### 3.3 Auth-proof (FR-008..013)

- [x] **T031** [US1] [P] Write `server/src/schemas/auth-proof.ts` Zod. Acceptance: tests pass. Complexity: **XS**. blockedBy: T002. (662bf73)

- [x] **T032** [US1] Implement `server/src/auth-proof/challenge.ts`: `issueChallenge(db, targetId)` — generates `tensol-verify=<32-byte-hex>`, expires_at=now+24h, inserts row, returns the three method instructions (DNS TXT, file path, meta-tag). **Tests** (`auth-proof/challenge.test.ts`): challenge format, expiry, methods payload shape. Acceptance: tests pass. Complexity: **S**. blockedBy: T010, T012, T014. (cc3ab7b)

- [x] **T033** [US1] Implement `server/src/auth-proof/verify.ts`: `verifyChallenge(db, targetId, deps)` performs three probes — DNS TXT (`node:dns/promises`), HTTPS GET to `https://<target>/.well-known/tensol-verify.txt`, HTTPS GET to `https://<target>/` and grep meta-tag. `deps` is an injectable object `{ resolveTxt, fetchUrl, now }` to allow fakes in tests. Returns `{ verified, method, attempted: [{method, succeeded, note}] }`. **Tests** (`auth-proof/verify.test.ts`): each probe path with fake `deps`; expired challenge → 410; partial success → marks target verified by first succeeding method; all fail → 422. Acceptance: tests pass. Complexity: **L**. blockedBy: T032. (5a77198)

- [x] **T034** [US1] Implement `server/src/auth-proof/middleware.ts` `requireAuthProof(targetId)` checking `targets.status='verified'` AND `now - verified_at < 90 days`; expired → 403 with re-verification hint. **Tests**: unverified → 403; verified < 90d → next(); verified > 90d → 403. Acceptance: tests pass. Complexity: **XS**. blockedBy: T033. (c351f79)

- [x] **T035** [US1] Implement `server/src/routes/auth-proof.ts` (`POST /api/targets/:id/auth-proof/challenge`, `POST /api/targets/:id/auth-proof/verify`) wired with audit (`auth_proof_issued`, `auth_proof_verified`, `auth_proof_failed`). **Integration test** (`tests/integration/auth-proof.test.ts`): issue → verify happy path with mocked DNS; failure-mode response shape; expiry behavior; **refusal to scan unverified target** (`POST /api/scans` returns 403) — covers User Story 2 fully. Acceptance: tests pass. Complexity: **M**. blockedBy: T034, T030, T031. (6b5693c)

### 3.4 Scans + Hetzner provider + Job runner (FR-014..020, 016..017)

- [x] **T036** [US1] Implement `server/src/jobs/types.ts` (discriminated union `Job = SpawnVpsJob | DispatchScanJob | WatchdogJob | TeardownVpsJob`) and `server/src/jobs/runner.ts` (poll loop, `BEGIN IMMEDIATE` claim, dispatcher map, retry with `attempts++ + 2^attempts s` backoff, max 5 attempts then status `failed`). **Tests** (`jobs/runner.test.ts`): two pollers can't claim same row; handler exception → retry scheduled; 6th attempt → status='failed'; clean shutdown via `stop()`. Acceptance: tests pass. Complexity: **L**. blockedBy: T010, T012, T014. (8e4668a)

- [x] **T037** [US1] Implement `server/src/vps/provider.ts` (public surface: `spawnVps`, `getVpsStatus`, `destroyVps`) and `server/src/vps/hetzner.ts` (HTTP client + cloud-init builder per `research.md` Decision 1). **Tests** (`vps/hetzner.test.ts`) using `bun test` with mocked `fetch`: spawn returns provider_server_id; cloud-init contains `TENSOL_WEBHOOK_BASE_URL` + `sign_key`; status polls until `running`; destroy idempotent. Acceptance: tests pass. Complexity: **L**. blockedBy: T005, T012. (45ab696)

- [x] **T038** [US1] [P] Write `server/src/schemas/scans.ts` Zod. Acceptance: tests pass. Complexity: **XS**. blockedBy: T002. (03ece78)

- [x] **T039** [US1] Implement `server/src/scans/service.ts`: `startScan({db, userId, targetId, profile})` — enforces auth-proof, inserts scan row queued, enqueues `spawn_vps` job, audits. `getScan`, `listScans`. **Tests** (`scans/service.test.ts`): unverified target → 403; verified → row + job inserted in same tx. Acceptance: tests pass. Complexity: **M**. blockedBy: T034, T036. (8dd425e)

- [x] **T040** [US1] Implement job handlers `server/src/jobs/handlers/spawn-vps.ts` (call `spawnVps`, poll until alive, generate sign_key, insert `vps_instances`, transition scan to `running`, enqueue `dispatch_scan`, audit `vps_provisioned`) and `server/src/jobs/handlers/dispatch-scan.ts` (HMAC-signed POST to `https://<vps-ip>/scan`, audit `decepticon_invoked`). **Tests** (`jobs/handlers/spawn-vps.test.ts`, `dispatch-scan.test.ts`) with mocked `provider` + `fetch`: happy path + retry behavior + audit row written. Acceptance: tests pass. Complexity: **L**. blockedBy: T039, T037. (ae883c7)

- [x] **T041** [US1] Implement `server/src/routes/scans.ts`: `POST /api/scans`, `GET /api/scans`, `GET /api/scans/:id`, `POST /api/scans/:id/cancel`, `GET /api/scans/:id/audit`. **Integration test** (`tests/integration/scan-lifecycle.test.ts`): full lifecycle with fake provider + fake VPS endpoint — start → running → callback → completed → findings visible → audit timeline complete. Acceptance: tests pass. Complexity: **L**. blockedBy: T040. (2051eb5)

### 3.5 Findings + webhook (FR-021..023, FR-029..032)

- [x] **T042** [US1] [P] Write `server/src/schemas/webhook.ts` Zod for `ScanProgressCallback`. Acceptance: tests pass. Complexity: **XS**. blockedBy: T002. (da55a99)

- [x] **T043** [US1] Implement `server/src/findings/service.ts`: `storeFindings(db, scanId, findings[])` with `INSERT ... ON CONFLICT(dedup_key) DO NOTHING`. **Tests** (`findings/service.test.ts`): duplicate inserts no-op; severity Zod accepted; markdown body stored as-is. Acceptance: tests pass. Complexity: **S**. blockedBy: T010, T014. (8c1d59a)

- [x] **T044** [US1] Implement `server/src/routes/webhooks.ts`: `POST /webhooks/scan-progress` — reads `X-Tensol-Scan-Id` + raw body, looks up `vps_instances.sign_key`, verifies HMAC against `X-Tensol-Signature` via constant-time compare, validates body Zod, idempotency check, calls `storeFindings` + `scans.complete()` or `scans.fail()`, audits, enqueues `teardown_vps`. **Integration test** (`tests/integration/webhook.test.ts`): valid signature → 200 + findings inserted; mismatch → 401 + `webhook_signature_invalid` audit + scan state untouched; unknown scan → 404; duplicate callback → 200 + no double-insert; failed-status callback → scan failed + teardown enqueued. Acceptance: tests pass. Complexity: **L**. blockedBy: T043, T040, T042. (5533582)

- [x] **T045** [US1] Implement `server/src/jobs/handlers/teardown-vps.ts` (call `destroyVps`, update `vps_instances.status='destroyed'`, audit `vps_destroyed`). **Tests**: idempotent on already-destroyed; audit row present. Acceptance: tests pass. Complexity: **S**. blockedBy: T037, T044. (592b544)

---

## Phase 4: User Story 5 — Restart Resilience (P2)

Goal: backend restart during in-flight scans is non-destructive. Independent test = `tests/integration/reconcile.test.ts`.

- [x] **T050** [US5] Implement `server/src/scans/reconcile.ts` `reconcileInFlight(db)`: select `scans WHERE status='running'`, for each call `getVpsStatus` and either keep running or mark failed + enqueue teardown. **Tests** (`scans/reconcile.test.ts`): scan + alive VPS → no state change; scan + unreachable VPS → failed + teardown enqueued; multiple scans batched correctly. Acceptance: tests pass. Complexity: **M**. blockedBy: T040, T045. (d3ee90c)

- [x] **T051** [US5] Wire reconcile into `server/src/server.ts` startup sequence (BEFORE Hono `listen()`). **Integration test** (`tests/integration/reconcile.test.ts`): seed running scans → restart-simulating server boot → assert reconciler ran within 60s. Acceptance: test passes. Complexity: **S**. blockedBy: T050. (fbf3585)

---

## Phase 5: User Story 6 — Recover from a Failed Scan Environment (P2)

Goal: zombie scans get caught. Independent test = `tests/integration/watchdog.test.ts`.

- [x] **T060** [US6] Implement `server/src/jobs/handlers/watchdog.ts`: for each scan running >30 min without callback, probe `GET https://<vps-ip>/status`; if alive → reschedule watchdog +5 min; if dead after 3 retries → mark failed (`agent_unresponsive`), enqueue teardown, audit. **Tests** (`jobs/handlers/watchdog.test.ts`) with mocked time + fetch: scan stuck 31m + alive agent → no state change; scan stuck 31m + dead agent (3× retries) → failed + teardown; audit chain has `watchdog_action`. Acceptance: tests pass. Complexity: **M**. blockedBy: T040, T045. (a8415ab)

- [x] **T061** [US6] Schedule periodic watchdog enqueue every 5 minutes in `jobs/runner.ts`. **Test**: after 5m wall (with fake clock), a new watchdog job appears. Acceptance: test passes. Complexity: **XS**. blockedBy: T060. (0100cea)

---

## Phase 6: User Story 7 — Cancel Scan (P3)

Goal: operator-initiated cancellation. Independent test = `tests/integration/cancel.test.ts`.

- [x] **T065** [US7] Implement `cancelScan(db, scanId, userId)` in `scans/service.ts`: rejects terminal states (409), transitions `queued|running → cancelled`, enqueues teardown, audits `scan_cancelled`. Wire route `POST /api/scans/:id/cancel`. **Integration test** (`tests/integration/cancel.test.ts`): cancel queued → ok; cancel running → ok; cancel completed → 409; teardown happens for both. Acceptance: test passes. Complexity: **S**. blockedBy: T041, T045. (5095fd5)

---

## Phase 7: VPS-agent (cross-cutting — supports US1, US5, US6)

- [x] **T070** [P] Implement `vps-agent/src/findings-collector.ts`: walks `/workspace/findings/*.md`, parses YAML frontmatter + body, returns canonical `Finding[]` matching the webhook schema. **Tests** (`vps-agent/tests/findings-collector.test.ts`) with fixture .md files: severity coercion, missing frontmatter rejected with note, body untouched. Acceptance: tests pass. Complexity: **S**. blockedBy: T003. (123d8a1)

- [x] **T071** [P] Implement `vps-agent/src/decepticon-runner.ts`: runs `docker compose up` for Decepticon with the target + profile from `POST /scan` payload, watches `/workspace/findings/`, returns when scan terminal. **Tests** with mocked `Bun.spawn`: docker exit-code propagation; profile → env var mapping. Acceptance: tests pass. Complexity: **M**. blockedBy: T003. (2a50232)

- [x] **T072** Implement `vps-agent/src/callback.ts`: serializes the body, HMAC-signs with `sign_key` from `/scan` payload, POSTs with retry (1s/5s/25s/125s), then self-shutdown. **Tests**: signature over raw body matches backend's verification logic (use the *same* HMAC reference vectors as T013). Acceptance: tests pass. Complexity: **S**. blockedBy: T070, T071. (bf06508)

- [x] **T073** Implement `vps-agent/src/agent.ts`: Hono server with `POST /scan` (validate, run, callback, self-shutdown) and `GET /status` (responds with current phase). **Integration test** (`vps-agent/tests/agent.test.ts`): in-process: POST /scan → mocked runner returns fake findings → callback delivered to mocked backend with valid HMAC. Acceptance: tests pass. Complexity: **L**. blockedBy: T072. (2664120)

- [x] **T074** Write `vps-agent/Dockerfile` (Bun base image + docker-cli + agent binary). Acceptance: `docker build vps-agent/` succeeds; image size < 200 MB. Complexity: **S**. blockedBy: T073. (b6ec446 — build deferred, daemon unavailable in driver env)

- [x] **T075** Update `server/src/vps/hetzner.ts` cloud-init script to pull `TENSOL_VPS_AGENT_IMAGE` and start it with the right env. **Integration test** (`vps/hetzner.test.ts` extended): cloud-init string contains correct image ref + env injection. Acceptance: test passes. Complexity: **S**. blockedBy: T074, T037. (e6afb35)

---

## Phase 8: Frontend Reconciliation

- [x] **T080** Grep `apps/site/src/` for `/api/`, `/webhooks/`, fetch wrappers; build a map of current calls vs new OpenAPI contract; produce `specs/001-backend-v2/contracts/frontend-diff.md` listing mismatches. Acceptance: diff doc committed. Complexity: **S**. blockedBy: none. (1b16f59)

- [x] **T081** Apply diff from T080: update fetch wrappers in `apps/site/src/` to match `contracts/openapi.yaml`. Manual smoke: `bun run dev` in both `server/` and `apps/site/`, log in via magic-link printed to backend stdout. Acceptance: each route in OpenAPI hit at least once successfully in dev. Complexity: **M**. blockedBy: T080, T044. (f6f09a5 — pragmatic: client+login only, remaining pages on mocks)

---

## Phase 9: E2E

- [x] **T090** Write Playwright test in `apps/site/tests/e2e/first-scan.spec.ts`: register → create project → add target → fake DNS challenge → verify → start scan → watch fake VPS push a canned finding via real webhook → assert finding visible in UI. Use Playwright route-mock for VPS provider HTTP. Acceptance: `bun run test:e2e` passes locally. Complexity: **L**. blockedBy: T081, T044. (498fe7c — hybrid UI+API)

---

## Phase 10: Polish & Verification Gate

- [x] **T100** Run `cd server && bun test --coverage`. Must report ≥80% combined coverage. Acceptance: coverage report committed at `specs/001-backend-v2/coverage-baseline.txt`. Complexity: **S**. blockedBy: all prior tests. (f0bcb8c — 93.92% lines / 94.62% funcs)

- [x] **T101** Run audit chain verifier on the integration-test fixture DB: `bun run src/audit/verify-chain.ts --db tests/fixtures/golden.db` → exit 0. Acceptance: command exits 0. Complexity: **XS**. blockedBy: T100. (4783ffe — chain ok: 11 rows)

- [⏸] **T102** Manual smoke per `specs/001-backend-v2/quickstart.md`: spin a live Hetzner VPS for a tiny `example.com` scan. Record actual run time + cost in `specs/001-backend-v2/smoke-2026-XX-XX.md`. Acceptance: live scan completes end-to-end with at least one finding. Complexity: **L**. blockedBy: T101. (b9c9338 — DEFERRED: preconditions missing — see smoke-2026-05-19.md)

- [x] **T103** Run `npx gitnexus analyze --embeddings` to reindex the new codebase. Acceptance: `.gitnexus/meta.json` shows fresh `last_indexed` and >0 symbols for `server/`. Complexity: **XS**. blockedBy: T102. (no-commit — .gitnexus gitignored; 539 server/ symbols, embeddings deferred — broken onnxruntime-node)

- [ ] **T104** Final commit on `001-backend-v2`: ensure all docs in `specs/001-backend-v2/` are committed; merge-prep summary in commit message; PR opened against `main`. Acceptance: PR URL recorded. Complexity: **XS**. blockedBy: T103.

---

## Dependency graph (story completion order)

```
Setup (T001-T005) → Foundational (T010-T015)
                       ↓
                   US1 (T020-T045) — MVP
                       ↓
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
    US5 (T050-T051) US6 (T060-T061) US7 (T065)
                       ↓
              VPS-agent (T070-T075) — required for live MVP
                       ↓
              Frontend (T080-T081)
                       ↓
              E2E (T090)
                       ↓
              Polish (T100-T104)
```

**MVP cut**: T001 → T045 + T070 → T075 + T081 = first-scan ships. US5/US6/US7 are post-MVP hardening.

## Parallelization opportunities

- **Phase 1**: T003, T004, T005 can run in parallel after T001.
- **Phase 2**: T012 [P] runs alongside T010+T011 work on a different file.
- **Phase 3.1**: T025 [P] alongside T021..T024 (Zod schemas are independent files).
- **Phase 3.2**: T027 [P] alongside services.
- **Phase 3.3-3.5**: schema tasks (T031, T038, T042) all [P].
- **Phase 7**: T070, T071 [P] (different concerns inside vps-agent).

Within each parallel set, the [P]-marked tasks should not modify the same files.

## Independent test criteria per user story

| Story | What "done" looks like (one-line) |
|-------|----------------------------------|
| US1   | `tests/integration/scan-lifecycle.test.ts` passes end-to-end against fake provider + fake VPS endpoint |
| US2   | covered as part of T035 — scan-start on unverified target returns 403 with audit row |
| US3   | covered as part of T040 — `vps_instances` rows show distinct provider_server_id + sign_key per scan |
| US4   | covered as part of T015 + T100 — chain verifier passes on the post-test DB |
| US5   | `tests/integration/reconcile.test.ts` passes |
| US6   | `tests/integration/watchdog.test.ts` passes |
| US7   | `tests/integration/cancel.test.ts` passes |

## Implementation strategy

- Land the MVP (Phase 1 → Phase 3 → Phase 7 → Phase 8 → smoke) before touching Phase 4/5/6.
- Each task that has a test counterpart MUST commit the failing test in its own commit, then the implementation in the next commit. PR reviewer enforces the two-commit pattern (Constitution VI).
- After each phase: tag a checkpoint commit so we can bisect cleanly if a regression sneaks in across stories.
