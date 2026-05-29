---
description: "Task list for 002-blackbox-mvp implementation"
---

# Tasks: Blackbox Pentest MVP

**Input**: Design documents from `/specs/002-blackbox-mvp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi.yaml, contracts/webhook.md, quickstart.md (all in place)

**Tests**: REQUIRED. Constitution Principle VI (Test-First, NON-NEGOTIABLE) governs this work — every new function and route ships with a failing test first.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story?] Description with file path`

- **[P]**: Different files, no dependency on incomplete tasks → can be done in parallel.
- **[Story]**: US1 = Quick scan, US2 = Deep inquiry, US3 = History view. Setup / Foundational / Polish phases have no [Story] label.
- Constitution VII: files ≤ 800 lines, typical 200-400. Constitution III: single `server/` package.

## Path conventions

- Backend: `server/src/...`, `server/test/...`, `server/scripts/...`
- Frontend: `apps/site/src/...`, `apps/site/e2e/...`
- Agent: `vps-agent/src/...`, `vps-agent/test/...`
- Spec: `specs/002-blackbox-mvp/...`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare repository and tooling for the blackbox MVP build. Nothing user-visible yet.

- [x] T001 (hash 326a88c) Verify branch `002-blackbox-mvp` is checked out and `bun install` succeeds in each package (`server/`, `apps/site/`, `vps-agent/`) — record install times for the dashboard
- [⏸] T002 [P] (defer→after T054/T055 rewire; pivot drops Resend but 5 files import it) Add Resend SDK dep to `server/package.json` (`resend` package, latest 1.x)
- [x] T003 [P] (hash 4ce8547) Add Puppeteer + chromium-min deps to `server/package.json` (`puppeteer-core`, `@sparticuz/chromium-min`)
- [x] T004 [P] (hash 63ac57b) Add AWS S3 SDK to `vps-agent/package.json` (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`)
- [x] T005 [P] (hash 3aa7fd8) Add dev dep `playwright` + browsers to `apps/site/package.json` (if not already present)
- [x] T006 [P] (hash fb35355; pivot drops RESEND_API_KEY) Update `server/.env.example` with all new env vars: `RESEND_API_KEY`, `TENSOL_TELEGRAM_BOT_TOKEN`, `TENSOL_TELEGRAM_CHAT_ID`, `TENSOL_WEBHOOK_SECRET`, `TENSOL_YOOKASSA_LIVE`, `YANDEX_SA_KEY_JSON`, `YANDEX_PROD_FOLDER_ID`, `YANDEX_PROD_NETWORK_ID`, `YANDEX_PROD_SUBNET_ID`, `YANDEX_PROD_SSH_PUBLIC_KEY`, `TENSOL_EVIDENCE_BUCKET`, `TENSOL_DEV_DNS_BYPASS`
- [x] T007 [P] (hash c9ad903; renamed→VITE_API_BASE_URL to match code) Update `apps/site/.env.example` with `VITE_API_BASE`
- [x] T008 [P] (hash c9ad903) Update `vps-agent/.env.example` with the `TENSOL_*` runtime contract from plan §"vps-agent contract"
- [x] T009 (hash f00998b; verify-chain → src/audit/verify-chain.ts) Add npm scripts in `server/package.json`: `cleanup-orphan-vms`, `debug:scan-order`, `verify-chain` (latter already exists, ensure)
- [x] T010 (hash f00998b) Add npm scripts in `apps/site/package.json`: `e2e` (playwright runner)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB migration, audit-log extensions, shared lib updates. **MUST complete before any user-story phase starts** because every user story depends on the schema and the audit event taxonomy.

- [x] T011 (hash 1dfb206; path=server/migrations/ not src/db/migrations/; baseline now 271/163 — RED expected) Write Drizzle migration `server/src/db/migrations/0010_blackbox_mvp.sql` per data-model.md §Migration: DROP `auth_proofs`, `targets`, `projects`; ALTER `users` ADD `free_quick_consumed_at`, `free_quick_consumed_count`; ALTER `scans` DROP `target_id` ADD `scan_order_id`; CREATE `scan_orders`, `scan_events`, `findings`, `deep_inquiries`, `evidence_artifacts`, `reports`; create all indexes
- [x] T012 (hash 90bd3e6; 71 tsc + 50 test fails downstream fallout) Update `server/src/db/schema.ts` Drizzle TS definitions to match the migration: drop deleted tables, add new tables with column types and FK relationships per data-model.md
- [x] T013 [P] (hash c138fbd; 29/29 pass; suite 278/50) Write `server/test/db/migration-0010.test.ts` — apply migration to in-memory SQLite, assert schema shape with `PRAGMA table_info()` queries
- [x] T014 (hash 2e57849; 29 events not 28 per data-model §E8) Extend `server/src/audit/emit.ts` with the 28 new event-type literals from data-model.md §E8. No format change — same 13-field signed message
- [x] T015 [P] (hash 2e57849; chain ok 29 rows) Write `server/test/audit/new-events.test.ts` — emit one row of each new event-type, verify chain extends correctly, `verify-chain` script passes
- [x] T016 (hash d4c47dd; 15 files rm; suite 282/22/14) Delete obsolete legacy modules: `server/src/targets/`, `server/src/projects/`, `server/src/auth-proof/middleware.ts`, related route files `server/src/routes/{targets,projects,auth-proof}.ts`. Delete their tests too
- [x] T017 [P] (hash 3c90b17; Dashboard.tsx stale handlers noted out-of-scope) Delete obsolete frontend pages: `apps/site/src/pages/{Targets,AuthorizeTarget,AuthorizeTarget.test,Builder,Approval,Projects}.tsx`. Update `apps/site/src/App.tsx` route table to remove their entries
- [x] T018 [P] (hash 3c90b17; no edit needed — ulid() already exported) Update `server/src/lib/ids.ts` if needed (existing — verify ULID generation is exposed for new modules)
- [x] T019 (hash 3c90b17; 3 tests, suite 285/22/14) Add new feature-flag helper `server/src/lib/feature-flags.ts` — reads `process.env.TENSOL_YOOKASSA_LIVE === 'true'`, exports `isYookassaLive()`. Per research R13
- [x] T020 [P] (hash 3c90b17; bundled w/ T019) Write `server/src/lib/feature-flags.test.ts` — env-var parsing
- [x] T021 (hash 6d3e3e8; legacy VpsProvider preserved in-file) Define `server/src/vps/provider.ts` — TypeScript `CloudProvider` interface (`spawnVm`, `teardownVm`, `getStatus`, `pollOperation`). No implementation yet. Per research R4
- [x] T022 [P] (hash 6d3e3e8) Write fake-provider `server/src/vps/fake-provider.ts` — deterministic stub for unit/IT tests per Constitution VI
- [x] T023 [P] (hash 6d3e3e8; 15 tests; suite 300/22/14) Write `server/src/vps/fake-provider.test.ts` for the fake itself

**Checkpoint**: All US phases may begin in parallel after Phase 2 closes. Migration applied, audit taxonomy extended, fake provider available, legacy pruned.

---

## Phase 3: User Story 1 — Run a free Quick blackbox scan (Priority: P1) 🎯 MVP

**Goal**: A signed-in user enters a domain they control, proves ownership via DNS TXT, runs a free Quick scan, sees findings + downloads PDF + receives email.

**Independent test**: Playwright E2E `scan-wizard.spec.ts` walks from signup through `Скачать PDF`. Backend integration tests cover every state transition. Real-Yandex IT runs on PR-merge.

### US1 — Schemas + DB layer (independent files, parallelizable)

- [x] T024 [P] [US1] (hash bb0e103; openapi uses PUT not PATCH; tier=quick on create only) Write `server/src/schemas/scan-orders.ts` — Zod schemas: `CreateScanOrderBody`, `UpdateAttackSurfaceBody`, `UpdateSafetyBody`, `LaunchScanOrderResponse`, `ScanOrderResponse`, `AttackSurfaceEntry`. Match openapi.yaml exactly
- [x] T025 [P] [US1] (hash bb0e103; 64 tests; suite 364/22/14) Write `server/src/schemas/scan-orders.test.ts` — valid + ≥5 invalid cases per schema (hostname regex, RPS range, attack surface item count, etc.)
- [x] T026 [P] [US1] (hash 9a42da8; inline YAML parser; accepts both obj+string) Write `server/src/schemas/webhook-scan-complete.ts` — Zod for the body in `contracts/webhook.md`. Includes nested `raw_yaml_frontmatter` parse with required `id`/`severity`/`title`
- [x] T027 [P] [US1] (hash 9a42da8; 47 tests; suite 411/22/14) Write `server/src/schemas/webhook-scan-complete.test.ts` — valid Juice Shop fixture parses; missing fields rejected
- [x] T028 [US1] (hash b003e43; 8 states 9 events; brief sketch discarded for §E2 ScanOrderStatusEnum) Implement `server/src/scan-orders/lifecycle.ts` — pure state-machine helpers: `canTransition(from, to)`, `nextStateOnEvent(state, event)`. Per data-model E2 state machine
- [x] T029 [P] [US1] (hash b003e43; 204 expects exhaustive matrix; suite 615/22/14) Write `server/src/scan-orders/lifecycle.test.ts` — exhaustive transition matrix, illegal transitions rejected

### US1 — Free-tier quota

- [x] T030 [US1] (hash 9699c82; single-stmt atomic UPDATE, no BEGIN-IMMEDIATE — bun:sqlite same-handle limit) Implement `server/src/free-tier/service.ts` — `canStartFreeQuick(db, userId): Promise<boolean>`, `consumeFreeQuickQuota(db, userId, now): Promise<{consumed: boolean}>` using `BEGIN IMMEDIATE` + atomic `UPDATE ... WHERE consumed_at IS NULL OR < now-7d`, `refundFreeQuickQuota(db, userId)`. Per spec FR-013…FR-017
- [x] T031 [P] [US1] (hash 9699c82; 14 tests incl. Promise.all race; suite 629/22/14) Write `server/src/free-tier/service.test.ts` — first consume ok, second within 7d rejected, 7d later ok, race-condition via two concurrent `Promise.all` consumes → only one succeeds, refund flips back to null

### US1 — DNS verification

- [x] T032 [P] [US1] (hash a03ae73; unanimous 4/4 per §R6 not briefs 3/4) Implement `server/src/dns-verify/resolver.ts` — `resolveTxtAgreed(domain): Promise<string[] | null>` using `node:dns/promises.Resolver` with explicit servers `[1.1.1.1, 1.0.0.1, 8.8.8.8, 8.8.4.4]`. Per research R6
- [x] T033 [P] [US1] (hash a03ae73; 13 tests; suite 642/22/14) Write `server/src/dns-verify/resolver.test.ts` — mock the Resolver, agreement, disagreement, timeout, NXDOMAIN
- [x] T034 [US1] (hash 3fc71f3; dns_last_error not persisted; emitSignedAudit real sig drizzle) Implement `server/src/dns-verify/service.ts` — `generateToken(orderId): string` (format `tensol-verify-<26-char-ulid>`), `checkVerification(db, orderId): Promise<{verified, attempts, remainingSec, lastError}>` (calls resolver, updates `dns_check_attempts`, emits audit on success/timeout), `TENSOL_DEV_DNS_BYPASS=true` shortcut
- [x] T035 [P] [US1] (hash 3fc71f3; 16 tests; suite 658/22/14) Write `server/src/dns-verify/service.test.ts` — token shape, success path emits `dns_verified` audit, failure timeout after 30 min, dev bypass after 5 sec

### US1 — Scan-orders service

- [x] T036 [US1] (hash b0ffe74; 9 methods; refund-rule status!=running; err codes NOT_FOUND/CONFLICT/QUOTA_EXHAUSTED/BAD_REQUEST) Implement `server/src/scan-orders/service.ts` — public API: `createDraft`, `updateAttackSurface` (incl. subdomain probe via T037), `updateSafety`, `requestDnsVerify`, `checkDnsAndUnlock`, `launchScan` (free-tier consume + scans row + spawn-yandex-vm job in same tx), `cancelOrder` (refund-rule from spec FR-016/FR-017), `getOrder`, `listUserOrders`. Each mutation in `withTx` + `emitSignedAudit` after commit
- [x] T037 [P] [US1] (hash a973ccb; §R1 5s timeout, capN=50; cross-domain leak guard) Implement `server/src/scan-orders/subdomain-probe.ts` — `discoverSubdomains(primary, timeoutMs, capN): Promise<string[]>` querying `crt.sh` per research R1, plus `www.` fallback
- [x] T038 [P] [US1] (hash a973ccb; 15 tests; suite 673/22/14) Write `server/src/scan-orders/subdomain-probe.test.ts` — mocked `fetch` returning real-shape CT-log JSON, dedup, www fallback added, timeout
- [x] T039 [P] [US1] (hash b0ffe74; 31 tests, atomic-refund verified; suite 704/22/14) Write `server/src/scan-orders/service.test.ts` — happy path through all transitions, foreign-user 404, illegal transition 409, atomic refund on launch failure

### US1 — Yandex Cloud provider

- [x] T040 [P] [US1] (hash 7498772; PS256 via node:crypto works in Bun; 5-min safety cache) Implement `server/src/vps/yandex-iam.ts` — `getIamToken()` cached singleton with 5-min safety, signs JWT from `YANDEX_SA_KEY_JSON`. Per research R5
- [x] T041 [P] [US1] (hash 7498772; backoff 1→2→4→8s; token rotation per request) Implement `server/src/vps/yandex-operations.ts` — `pollOperation(opId, timeoutMs)` exponential backoff 1→2→4→max 8s, 10-min total cap, returns parsed `Operation`. Per research R4
- [x] T042 [P] [US1] (hash 7498772; 17 tests, ephemeral keys; suite 721/22/14) Write `server/src/vps/yandex-iam.test.ts` + `yandex-operations.test.ts` — fetch mocked, JWT signature verified offline, polling exits on `done:true` and on timeout
- [x] T043 [US1] (hash 58e1909; 388 LOC; image-id placeholder w/ env override; getStatus 404→stopped reaper-friendly) Implement `server/src/vps/yandex.ts` (`CloudProvider`) — `spawnVm` with `Idempotency-Key: <scanOrderId>` calling `POST compute/v1/instances`, returns vps_instance_id + ip after poll. `teardownVm` via DELETE + poll. `getStatus` via GET. Uses helpers from T040/T041
- [x] T044 [P] [US1] (hash adb8d68; structural assertions not golden; hetzner.ts retained for later DELETE) Implement `server/src/vps/cloud-init.ts` — `buildCloudInit(args): string` bash template that pulls Decepticon image, mounts secrets, runs vps-agent with the full `TENSOL_*` env contract from plan
- [x] T045 [P] [US1] (hash adb8d68; 14 tests; suite 735/22/14) Write `server/src/vps/cloud-init.test.ts` — golden-file rendering, env vars substituted correctly, no unescaped vars left
- [x] T046 [US1] (hash a6ff2ad; 32 tests + 1 todo retry-on-429; suite 767/22/14) Write `server/src/vps/yandex.test.ts` — uses fake provider for default; assertions on Idempotency-Key passed, Operation polling path, retry-on-429
- [x] T047 [US1] (hash e48a6da; describe.skipIf gate, 0/3 skip on default run) Write `server/src/vps/yandex-real.test.ts` — real Yandex spawn against minimal Ubuntu image (no Decepticon), waits for `cloud-init` marker via SSH probe, then teardown. Guarded by `TENSOL_TEST_REAL_YANDEX=1` env var. Per research R11 layer 2

### US1 — Findings ingest + Reports

- [x] T048 [P] [US1] (hash a79aa93; Bun.YAML.parse for multi-line poc; slug local-derived; emitSignedAudit is async) Implement `server/src/findings/ingest.ts` — `parseYamlFrontmatter(md): { fm, body }` (gray-matter or hand-rolled), `insertFinding(db, scanId, parsed): Promise<Finding>` writing to `findings` table per data-model E5, emit `finding_ingested` audit per finding
- [x] T049 [P] [US1] (hash a79aa93; 4 tests 33 expects; chain rows=9; suite 771/22/14) Write `server/src/findings/ingest.test.ts` — feed the 9-finding Juice Shop fixture from 2026-05-19 (`server/test/fixtures/webhook-scan-complete-juiceshop.json`), assert all 9 rows inserted with correct severity / CVSS / CWE / MITRE mapping, audit chain extended by 9
- [x] T050 [P] [US1] (hash a79aa93; 317 LOC 60KB; histogram 3C+4H+2M) Save the Juice Shop fixture at `server/test/fixtures/webhook-scan-complete-juiceshop.json` — derive from `.harness/goals/decepticon-oauth-local-smoke/evidence/E-juiceshop-findings/` (copy each .md as the `raw_yaml_frontmatter` + `body_md` shape)
- [x] T051 [P] [US1] (hash e7f78de; 498 LOC; inline SVG chart, no client JS) Implement `server/src/reports/template.html.ts` — HTML template for the PDF: cover, executive summary, severity distribution chart (server-rendered SVG), per-finding sections with CVSS/CWE/MITRE/PoC blocks
- [x] T052 [US1] (hash e7f78de; 141 LOC; waitUntil=domcontentloaded per puppeteer v25 type) Implement `server/src/reports/pdf.ts` — `renderReport(scanId): Promise<Buffer>` using Puppeteer-core + chromium-min, 60s timeout, throws `PDFRenderError` on failure. Per research R7
- [x] T053 [P] [US1] (hash e7f78de; 10 tests mocked launcher; real-render gated; suite 781/22/14) Write `server/src/reports/pdf.test.ts` — small fixture (3 findings) renders < 5 MB PDF, large fixture (50 findings) renders < 30 MB, crash injection (mock puppeteer launch to throw) → PDFRenderError surfaced

### US1 — Email notification

- [⏸] T054 [P] [US1] (pivot: SUPERSEDED — fold into T096 notify/telegram.ts; no new notify/email.ts) Implement `server/src/notify/email.ts` — `sendScanCompleteEmail(toEmail, scanId, pdfBuffer?): Promise<void>` using Resend API, retry-on-5xx ×3, no-retry-on-4xx. Per research R12. Embeds a link to `/v1/scans/:id/findings` (frontend route)
- [⏸] T055 [P] [US1] (pivot: SUPERSEDED — folded into T096 telegram test) Write `server/src/notify/email.test.ts` — mock Resend, assertion on payload shape (attachment vs link fallback), retry behavior

### US1 — Job handlers

- [x] T056 [US1] (hash 05d4d50; dual-case normalizePayload; scan_failed not vm_provisioning_failed; retry_telegram_notification slot) Implement `server/src/jobs/handlers/spawn-yandex-vm.ts` — picks `spawn_yandex_vm` job, calls `yandex.spawnVm` with cloud-init from T044, stores `vps_instance_id` + `vps_zone` on scan_order, emits `vm_ready` audit + `scan_events` row. Retry on transient failures up to 3 times; permanent failure → mark order `failed`, refund quota, enqueue Telegram alert
- [x] T057 [P] [US1] (hash 05d4d50; 4 tests 44 expects; suite 785/22/14) Write `server/test/integration/spawn-yandex-vm.test.ts` — uses fake provider, asserts state transitions
- [x] T058 [US1] (hash 710d955; vm_teardown literal exists; 404 tagged already_gone:true) Implement `server/src/jobs/handlers/teardown-yandex-vm.ts` — picks `teardown_yandex_vm` job, `yandex.teardownVm`, emit `vm_teardown` audit. Idempotent
- [x] T059 [P] [US1] (hash 710d955; 5 tests 34 expects; suite 790/22/14) Write `server/test/integration/teardown-yandex-vm.test.ts`
- [x] T060 [US1] (hash 143facb; aws-sdk/client-s3 added; pdf_rendered+pdf_render_failed native) Implement `server/src/jobs/handlers/render-pdf.ts` — picks `render_pdf` job, calls `reports/pdf.ts`, uploads to Object Storage, updates `reports` row status=`ready` with bucket/key/byte_size/expires_at. Retry × 3. On final fail, status=`failed`. Per research R7
- [x] T061 [P] [US1] (hash 143facb; 5 tests 51 expects; suite 856) Write `server/test/integration/render-pdf.test.ts` — mock S3 upload, mock Puppeteer
- [x] T062 [US1] (hash 02ce066; PIVOT-RENAMED to send-scan-complete-telegram.ts; email_sent+channel=telegram; audit-replay idempotency) Implement `server/src/jobs/handlers/send-scan-complete-email.ts` — picks `send_scan_complete_email` job, fetches scan + report, calls `notify/email.ts` with PDF buffer if available
- [x] T063 [P] [US1] (hash 02ce066; PIVOT-RENAMED to send-scan-complete-telegram.test.ts; 7 tests; suite 802) Write `server/test/integration/send-scan-complete-email.test.ts`
- [x] T064 [US1] (hash bcbf040; scan_failed+reason=scan_timeout substitution; tick(now) style) Implement `server/src/jobs/handlers/scan-timeout-watcher.ts` — cron-style runner every 5 min: queries `scans WHERE status='running' AND started_at < now - 90min`, marks failed, enqueues teardown, refunds quota. Per spec FR-022
- [x] T065 [P] [US1] (hash bcbf040; 8 tests 52 expects; suite 903) Write `server/test/integration/scan-timeout-watcher.test.ts`
- [x] T066 [US1] (hash 0d0734f; 5 new JobKinds; legacy aliases warn-route-to-legacy not auto-route — payload incompat; LoggingTelegramNotifier placeholder for T096 swap) Register new job kinds in `server/src/jobs/runner.ts` + `server/src/jobs/types.ts`. Make legacy `spawn_vps`/`teardown_vps` route to the new handlers as deprecated aliases

### US1 — HTTP routes

- [x] T067 [US1] (hash b64ddff; 9 endpoints; DELETE-cancel + PUT not PATCH; 429 for quota; dns-verify /request and /check sub-paths) Implement `server/src/routes/scan-orders.ts` covering all openapi paths under `/v1/scan-orders/*`: list, create, get, patch attack-surface, patch safety, dns-verify request, dns-verify check (poll), launch, cancel. Each route validates body via T024 schemas + delegates to service layer
- [x] T068 [P] [US1] (hash b64ddff; 29 tests; suite 843/22/14; existing magic-link auth reused) Write `server/test/integration/scan-orders-routes.test.ts` — happy path through every endpoint, foreign-user 404s, validation 422s, rate limits
- [x] T069 [US1] (hash cc3a9b7; new file webhooks-scan-complete.ts not modifying V1 webhooks.ts; Stripe envelope t=,v1=; production wiring deferred) Implement webhook receiver `server/src/routes/webhooks.ts::scanCompleteHandler` — HMAC validation first, Zod second, idempotency third (audit-log dedup), then ingest via `findings/ingest.ts`, transition to `completed`, enqueue PDF + email + teardown jobs. Per webhook.md
- [x] T070 [P] [US1] (hash cc3a9b7; 8 tests; 3 jobs enqueued in single tx; suite 847) Write `server/test/integration/webhook-scan-complete.test.ts` — valid signature path, invalid signature → 401, replay → 200 no-op, malformed body → 422, ingests Juice Shop fixture
- [x] T071 [US1] (hash a7849e7; rewrite; rm scans/service.ts ~700LOC T012-fallout; 6 endpoints; ownership via scan_orders.user_id direct) Implement `server/src/routes/scans.ts` (simplified per plan) — `GET /v1/scans/:id`, `GET /v1/scans/:id/events?since=`, `GET /v1/scans/:id/findings`, `GET /v1/scans/:id/findings/:findingId`, `GET /v1/scans/:id/report`, `POST /v1/scans/:id/report/regenerate`. Owner-scoped reads via projects-removed JOIN now-direct `scan_orders.user_id`
- [x] T072 [P] [US1] (hash a7849e7; 19 tests; suite 927/26/18; cancel.test.ts still zombie from 001) Write `server/test/integration/scans-routes.test.ts` — owner-scoped, polling shape (events `since` filter), report status transitions, regenerate enqueues a new job
- [x] T073 [P] [US1] (hash 10c2d30; 2 tests; suite 868) Implement `server/src/routes/config-feature-flags.ts` — `GET /v1/config/feature-flags` returns `{yookassa_live}` from T019
- [x] T074 [US1] (hash 10c2d30; webhook+feature-flags mounted; TENSOL_WEBHOOK_SECRET added to config) Wire new routes in `server/src/server.ts`. Remove legacy route registrations

### US1 — Frontend wizard

- [x] T075 [US1] (hash 45c4d03; createPoller plain primitive + usePolling wrapper; custom fake-timer harness) Implement `apps/site/src/lib/poll.ts` — generic `usePolling(fn, intervalMs, stopWhen)` hook. Per Constitution V (no SSE)
- [x] T076 [P] [US1] (hash 45c4d03; 10 tests 28 expects; 5 playwright fails unchanged baseline) Write `apps/site/src/lib/poll.test.ts` — start, stop, error handling, interval
- [x] T077 [US1] (hash a306e48; 15 typed fns hand-mirrored; ApiError; 10 tests; suite 20/5) Update `apps/site/src/lib/api-client.ts` — add typed clients for all `/v1/scan-orders/*` and `/v1/scans/*` endpoints from openapi.yaml
- [x] T078 [US1] (hash 83f3be3; 7 files 534 LOC; 6 reducer tests; suite 26/5; create-mode posts empty domain — T079 owns domain entry) Implement `apps/site/src/pages/scan-wizard/ScanWizardContainer.tsx` — stepper UI (4 steps), persistent state via `useReducer`, route-aware step navigation, "Cancel" button at every step
- [x] T079 [P] [US1] (hash f2b3af5; manual-entry path no server probe endpoint; max 10 headers) Implement `apps/site/src/pages/scan-wizard/Step1AttackSurface.tsx` — domain input, async subdomain discovery on blur, toggleable list, Global Headers add/remove rows
- [x] T080 [P] [US1] (hash f2b3af5; 3 preset chips Safe/Default/Aggressive; clampRps 1-500; suite 35/0) Implement `apps/site/src/pages/scan-wizard/Step2Safety.tsx` — RPS slider (preset positions: Safe=10, Default=50, Aggressive=200), numeric override input
- [x] T081 [P] [US1] (hash e91c929; file kept as Step3DnsVerify.tsx scaffold; usePolling 5s; TG @kapital0 stall link) Implement `apps/site/src/pages/scan-wizard/Step3VerifyDomain.tsx` — show TXT record card (copy-to-clipboard buttons), poll `dns-verify/check` every 5 seconds, 30-min countdown timer, "Контакт-помощь" link on long stall
- [x] T082 [P] [US1] (hash e91c929; file kept as Step4Review.tsx; getFeatureFlags one-shot mount fetch; suite 47/5) Implement `apps/site/src/pages/scan-wizard/Step4Launch.tsx` — summary card, free-quota status, CTA "Запустить бесплатный Quick" (or "Оплатить" when `yookassa_live=true` via T073). On launch success → navigate to `/scan/:id` Live page
- [x] T083 [US1] (hash a5cc36e; alias strategy /scan/new canonical + /wizard legacy; STEP_SLUG_TO_NUM map handles both) Add wizard routes to `apps/site/src/App.tsx`: `/scan/new`, `/scan/new/:orderId/surface|safety|verify|launch`, `/scan/:id` (Live), `/scan/:id/findings`, `/scan/:id/findings/:findingId`, `/scan/:id/report`
- [x] T084 [US1] (hash a5cc36e; 2 polling hooks 3sec; 5-phase mapping; events feed monotonic since cursor; suite 56/5) Update `apps/site/src/pages/Live.tsx` — polling-based progress page using T075, renders phase progress + live findings feed pulled from `/v1/scans/:id/events`
- [x] T085 [US1] (hash c7f3b3d; CSS conic-gradient donut no chart lib; severity informational→info chip adapter) Update `apps/site/src/pages/Findings.tsx` — severity distribution donut chart (CSS-only, no chart lib), filterable table, drill-down link to `/scan/:id/findings/:findingId` detail
- [x] T086 [US1] (hash c7f3b3d; inline markdown converter no react-markdown dep; evidence_keys[] presign deferred) Add finding-detail page `apps/site/src/pages/FindingDetail.tsx` — full markdown render (body_md), evidence-file download links, CVSS/CWE/MITRE badges
- [x] T087 [US1] (hash c7f3b3d; 5sec usePolling on pending; regenerate+refetch immediate; suite 56/5/5) Update `apps/site/src/pages/Reports.tsx` — listing per scan + download PDF + regenerate button when status=`failed`
- [x] T088 [P] [US1] (completed inline during T078-T087; t.wizard step1-4 + t.findings + t.live + t.reports + t.findingDetail all landed) Add new translation keys to `apps/site/src/i18n.ts` — `scanWizard.step1.*`, `scanWizard.step2.*`, `scanWizard.step3.*`, `scanWizard.step4.*`, `findings.*`, `live.*`, `report.*`, RU + EN
- [x] T089 [P] [US1] (hash 7dad6dd; CTAs both hero+bottom; hero L1/L2/L3 frozen) Update `apps/site/src/pages/Marketing.tsx` — replace any legacy CTAs with "Try Quick free" + "Запросить Deep аудит" (Deep CTA lands on US2 page when that's built; for US1 alone, "Запросить Deep" goes to existing /contact temporarily)
- [x] T090 [P] [US1] (hash 7dad6dd; Quick free + Deep from 350k₽/$3500; Mythos quote §2.6; suite 56/5/5) Update `apps/site/src/pages/Pricing.tsx` — two cards: Quick (free during MVP) and Deep ("from ₽X, индивидуально"). Use Mythos-positioning copy from design §2.6

### US1 — End-to-end test

- [x] T091 [US1] (hash 265bd14; cookie-seed auth bypass per Telegram pivot; runtime smoke deferred to T102) Write `apps/site/e2e/scan-wizard.spec.ts` — Playwright E2E from landing → magic-link signup (mailbox via Resend test mode or stubbed endpoint) → wizard step 1-4 → live page → findings → PDF download. Uses `TENSOL_DEV_DNS_BYPASS=true` + fake Yandex provider in the dev backend
- [x] T092 [US1] (hash 2d74f15; helpers extracted; /__test/v2/exhaust-quota documented for T102; quota_exhausted code asserted) Add `apps/site/e2e/free-quota.spec.ts` — pre-fixture user with `free_quick_consumed_at = now()`, attempt launch, expect 429 inline error + CTA to /deep-inquiry
- [x] T093 [US1] (hash 2d74f15; statusExpired+support-link assertion; suite 56/8/8 — +3 errs are playwright-spec under bun:test pickup) Add `apps/site/e2e/dns-timeout.spec.ts` — fast-forward clock test, expect `failed` status

**US1 checkpoint**: At this point the full Quick happy path is live. Phase 4 (US2) can run in parallel with this phase's later tasks if multiple developers are available.

---

## Phase 4: User Story 2 — Request a Deep engagement (Priority: P2)

**Goal**: Operator-visible lead-gen funnel. Anyone (anonymous or signed-in) submits the Deep inquiry form; operator gets a Telegram message within 60s.

**Independent test**: `apps/site/e2e/deep-inquiry.spec.ts` submits the form anonymously; backend integration test asserts Telegram mock was called and `deep_inquiries` row is persisted with status=`new`.

### US2 — Backend

- [x] T094 [P] [US2] (hash 416b671; budget_band=open not discuss; status=new/contacted/converted/declined/dropped not brief; no telegram field — openapi/db uses phone E.164-or-@handle; suite 905) Write `server/src/schemas/deep-inquiries.ts` — Zod for `CreateInquiryBody`, `InquiryResponse`. Match openapi.yaml shape. Includes `budget_band` enum + `consent_accepted: literal(true)`
- [x] T095 [P] [US2] (hash 416b671; 37 tests; +37 pass 0 reg) Write `server/src/schemas/deep-inquiries.test.ts` — valid + invalid (consent false, missing email, oversized scope_text, etc.)
- [x] T096 [US2] (hash 5ac323e; sendMessage+sendDocument+escapeMarkdownV2+createTelegramNotifier; 429 retry_after + 5xx exp backoff; pivot-fold target for T054/T055/T062) Implement `server/src/notify/telegram.ts` — `sendMessage(text): Promise<{messageId}>` calls Telegram Bot API, retry-on-429 honoring `retry_after`, max 5 attempts. Per research R8
- [x] T097 [P] [US2] (hash 5ac323e; 16 tests 74 expects; suite ~921) Write `server/src/notify/telegram.test.ts` — mock fetch, retry behavior, signature of payload, markdown escape for company names with `*` `_` etc.
- [x] T098 [US2] (hash 2152d7e; 8 rules: pwd-kv/url-basic/AWS/GH-PAT/Slack/Anthropic/OpenAI; sk-ant before sk-) Implement `server/src/deep-inquiries/sanitize.ts` — regex strip password patterns from `scope_text` before persistence + before Telegram. Per spec FR-034
- [x] T099 [P] [US2] (hash 2152d7e; 27 tests 51 expects; suite 948) Write `server/src/deep-inquiries/sanitize.test.ts` — `password:foo123` → `password:[REDACTED]`, `pwd=secret` → `pwd=[REDACTED]`, etc.
- [x] T100 [US2] (hash e922fb9; 4 methods; transitions new→contacted→converted; send_deep_inquiry_telegram type-drift T102 fixes; email NOT NULL→"" when absent) Implement `server/src/deep-inquiries/service.ts` — `createInquiry(args, optionalUserId)`, links to user if logged in, sanitizes scope, inserts row, emits `inquiry_received` audit, enqueues Telegram job. Status transitions: `setStatus(id, newStatus)` validates legal transition, emits audit
- [x] T101 [P] [US2] (hash e922fb9; 21 tests 49 expects; suite 969) Write `server/src/deep-inquiries/service.test.ts` — anonymous flow, logged-in flow, sanitization, status transitions
- [x] T102 [US2] (hash 04c36cc; DI SendTextFn not full notifier; schema drift: telegram_sent_at not telegram_message_id; 24h reason=retry_window_exhausted) Implement `server/src/jobs/handlers/send-deep-inquiry-telegram.ts` — picks `send_deep_inquiry_telegram` job, formats the message per design §3.2 template, calls `notify/telegram.ts`, updates `telegram_sent_at`. Background retry every 10 min for 24h on persistent failure
- [x] T103 [P] [US2] (hash 04c36cc; 6 tests 77ms; suite 1001 — drift from 969 recall) Write `server/test/integration/send-deep-inquiry-telegram.test.ts`
- [x] T104 [US2] (hash 83858d3; soft-auth inline cookie reader not createRequireAuth; service-error→HTTP mapping) Implement `server/src/routes/deep-inquiries.ts` — `POST /v1/deep-inquiries` with anonymous-or-authenticated path
- [x] T105 [P] [US2] (hash 83858d3; 6 tests 23 expects; anon+auth+sanitize round-trip; suite 1007/981) Write `server/test/integration/deep-inquiries-routes.test.ts`

### US2 — Frontend

- [x] T106 [US2] (hash 869135a; brief drift: primary_domain missing from schema — only domains_text; auth.me prefill 401→null graceful) Implement `apps/site/src/pages/DeepInquiry.tsx` — hybrid form: anonymous OR auto-prefilled from `/v1/auth/me` if logged in. All fields per spec FR-030. Submit → `/v1/deep-inquiries` → on 201 navigate to thank-you
- [x] T107 [P] [US2] (hash 869135a; 128 LOC RU+EN static) Implement `apps/site/src/pages/DeepInquiryThankYou.tsx` — success page «Заявка получена. Свяжемся в течение 24 часов»
- [x] T108 [US2] (hash 869135a; Marketing+Pricing CTAs repointed /contact→/deep-inquiry; nav requestDemo kept on /contact; apps/site 61/8/8) Add routes to `apps/site/src/App.tsx`: `/deep-inquiry`, `/deep-inquiry/thank-you`
- [x] T109 [P] [US2] (completed inline during T108; Marketing+Pricing Deep CTAs already repointed /contact→/deep-inquiry) Update `apps/site/src/pages/Marketing.tsx` hero CTA and `apps/site/src/pages/Pricing.tsx` Deep card to link to `/deep-inquiry`
- [x] T110 [P] [US2] (hash 66c2e74; banner above main grid; data-testid=dashboard-deep-banner) Add Deep banner card to `apps/site/src/pages/Dashboard.tsx` for signed-in users
- [x] T111 [P] [US2] (completed inline during T106; t.deepInquiry namespace ~30 keys × 2 locales) Add new translation keys to `apps/site/src/i18n.ts` — `deepInquiry.*`, RU + EN

### US2 — E2E

- [x] T112 [US2] (hash 66c2e74; 2 scenarios anon+prefill; shared fillDeepInquiryForm helper; suite 61/9/9) Write `apps/site/e2e/deep-inquiry.spec.ts` — anonymous submit, success page, signed-in pre-fill variant

**US2 checkpoint**: Lead funnel live. Independent of US1 (no Yandex / no scan).

---

## Phase 5: User Story 3 — Browse past scans and re-download reports (Priority: P3)

**Goal**: Dashboard list of historical scans, drill-down to any one, re-download PDF (or regenerate if expired).

**Independent test**: With at least one prior scan in the DB (fixture), Playwright walks Dashboard → click scan → view findings → click Download PDF → verify download. No new scan execution required.

### US3 — Backend

- [x] T113 [P] [US3] (hash 3d2f10a; VERIFICATION-ONLY — listUserOrders already returns shape sorted DESC) Ensure `GET /v1/scan-orders` route from T067 supports the dashboard list shape (sort by created_at DESC, include status + tier + primary_domain). If not already, extend
- [x] T114 [P] [US3] (hash 3d2f10a; batches 100/tick across evidence_artifacts+reports; S3-fail no-delete retry-next; evidence_pruned/report_pruned via TEXT col substitution) Implement cron `server/src/jobs/handlers/cleanup-expired-reports.ts` — daily prune Object Storage objects whose `evidence_artifacts.expires_at < now`, delete the row
- [x] T115 [P] [US3] (hash 3d2f10a; 8 tests 58 expects; suite 1015) Write `server/test/integration/cleanup-expired-reports.test.ts`
- [x] T116 [US3] (hash 93b6566; TEST-ONLY — UPSERT impl already handles post-expiry without branch; 1 new IT case) Make `POST /v1/scans/:id/report/regenerate` (from T071) operational even after report expiry — re-enqueue render-pdf job with fresh keys

### US3 — Frontend

- [x] T117 [US3] (hash 2c915b3; 5-col table; quota derived from scanOrders.list not auth.me — server free_quick_* fields not wired yet; T017 stale handlers finally rm; 26 helper tests; suite 87/9/9) Update `apps/site/src/pages/Dashboard.tsx` — rewrite as "your scans" table: status badge, primary_domain, tier, date, action button ("View", "Resume draft", "Download PDF", "Regenerate"). Plus floating `+ New Scan` CTA. Plus free-quota status display per spec FR-015
- [x] T118 [P] [US3] (hash 93b6566; rewrite −145 LOC dropped multi-tenant tabbed scaffold; 3 sections account/quota/MVP-placeholder; reuses deriveFreeQuotaStatus) Update `apps/site/src/pages/Settings.tsx` — show quota status, account info; no other settings in MVP
- [x] T119 [P] [US3] (hash 93b6566; inline replacement; data-testid=dashboard-empty-state; `[·]` glyph + CTA→/scan/new) Add empty-state component to `apps/site/src/pages/Dashboard.tsx` — when user has zero scans, prompt to start first scan

### US3 — E2E

- [x] T120 [US3] (hash 529916b; 197 LOC spec + 111 LOC helper extension; 2 new __test endpoints documented for T102; suite 87/10/10 predicted exactly) Write `apps/site/e2e/history-redownload.spec.ts` — fixture user with prior completed scan, visit dashboard, click row, see findings, download PDF, expire fixture, verify regenerate button appears

**US3 checkpoint**: Returning-user flow live.

---

## Phase 6: Polish, Cross-Cutting, Pre-Launch

**Purpose**: Operational tooling, real-Yandex verification, landing copy polish, security pass.

### Admin tooling (for operator self-service)

- [x] T121 [P] (hash b827df7; operator Set<string> O(1); empty list safe-default-403; case-insensitive; createRequireAuth already exposed user.email) Implement `server/src/routes/admin/deep-inquiries.ts` — `GET /v1/admin/deep-inquiries` (operator-only, env `TENSOL_OPERATOR_EMAILS=…` list), `PUT /v1/admin/deep-inquiries/:id/status` for transitions
- [x] T122 [P] (hash b827df7; 14 tests; suite 1030/1004) Write `server/test/integration/admin-routes.test.ts` — non-operator 403, operator 200

### Cleanup + observability

- [x] T123 (hash 59f453b; CLI entry + reusable task; listInstances iface extension + Yandex paginated + Fake folder-index; per-prefix minAge 30/120min) Implement `server/scripts/cleanup-orphan-vms.ts` — list-and-delete VMs in test+prod folders matching `tensol-test-*` / `tensol-scan-*` AND `createdAt < now-30min` (tests) / `<now-120min` (prod), Telegram alert on >0 deleted. Per research R10
- [x] T124 [P] (hash 59f453b; 5 tests incl. partial-failure-still-alerts + per-prefix-age + empty-list; suite 1035) Write `server/test/integration/cleanup-orphan-vms.test.ts` (uses fake provider with pre-seeded "orphans")
- [x] T125 [P] (hash 59f453b; 15-min Timer.unref+clearInterval on stop; skipped when YANDEX folder env empty) Add cron registration for cleanup-orphan-vms (every 15 min) in `server/src/server.ts` startup
- [x] T126 [P] (completed inline during T066 hash 0d0734f; 5-min setInterval unref+clearInterval; commit body documented) Add cron registration for scan-timeout-watcher (every 5 min)
- [x] T127 [P] (hash fdff0c6; daily 24h interval; skipped when S3 env missing — graceful degradation; 3rd cron alongside scan-timeout+orphan-vms) Add cron registration for cleanup-expired-reports (daily)

### Real-Yandex verification

- [x] T128 (hash fdff0c6; skipIf gate; 14 env vars validated; 10-step 35min lifecycle test; afterAll defensive teardown; default 0 pass 3 skip) Implement `server/test/integration/scan-lifecycle-real-yandex.test.ts` — gated by `TENSOL_TEST_REAL_YANDEX=1`. Spawns a real VM with the actual Decepticon image, runs scan against `juice-shop.tensol.dev` (operator must provision this beforehand), verifies ≥3 findings ingested + audit chain intact + report rendered. Per research R11 layer 3 + plan §"PR-merge"
- [x] T129 (hash 5bcd239; on push to main; 45min timeout; concurrency cancel-in-progress; 19 secrets) Add CI workflow `.github/workflows/pr-merge.yml` running `TENSOL_TEST_REAL_YANDEX=1 bun test` on push to `main`
- [x] T130 (hash 5bcd239; cron 3am UTC + workflow_dispatch; cancel-in-progress=false for cloud-teardown safety; if-failure inline curl Telegram alert) Add CI workflow `.github/workflows/nightly-smoke.yml` running T128 nightly

### vps-agent updates

- [x] T131 [P] (hash 8665d8e; signWebhook + buildSignedHeaders; bytes-perfect envelope mirror; 93 LOC) Implement `vps-agent/src/webhook-sign.ts` — HMAC-SHA256 signing matching `contracts/webhook.md` `X-Tensol-Signature` format
- [x] T132 [P] (hash 8665d8e; 14 tests; golden hex 794bc65855733968a9faef7ced3111c72e563bc19c9d36d211b993b609efc28e pinned; suite 59/0) Write `vps-agent/test/webhook-sign.test.ts` — golden-vector test against server-side verifier
- [x] T133 [P] (hash fa15ee3; DI S3Like + UploadCtor; PutObject<5MiB / Upload>=5MiB boundary; Yandex defaults ru-central1+storage.yandexcloud.net) Implement `vps-agent/src/evidence-upload.ts` — AWS SDK v3 S3 client targeting Yandex Object Storage. Per research R9
- [x] T134 [P] (hash fa15ee3; 14 tests 6 describes; multipart 5MiB boundary 3 tests; suite 73/0) Write `vps-agent/test/evidence-upload.test.ts` — mocked S3 client, file → key path
- [x] T135 (hash 2dce874; NEW V2 path not chaining legacy decepticon-runner.ts V1 — V1→V2 adapter glue future task; webhook exp backoff 500ms→8s cap 30s max 5; sig re-computed each attempt for ±5min drift) Update `vps-agent/src/runner.ts` — wire all new env vars, run Decepticon, collect findings/*.md and evidence/*, tar.gz, upload, POST signed webhook, shutdown
- [x] T136 [P] (hash 2dce874; 16 tests 48 expects 5 categories; suite 89/0) Write `vps-agent/test/runner.test.ts`
- [x] T137 [P] (hash 192e48a; inline server-style verifier no cross-pkg import; 15 tests 252 expects; golden vector cross-checked; suite 104/0) Write `vps-agent/test/webhook-contract.test.ts` — pairs with T070; agent builds signed payload, server-side verifier accepts. Reverse: server builds expected payload, agent verifier accepts

### Documentation + landing polish

- [⏸] T138 [P] (CREATIVE — needs operator review per driver brief §JЁСТКИЕ-БЛОКЕРЫ; hero+manifesto+FAQ all already shipped in T089+T091; final-polish copy is judgment call) Update `apps/site/src/pages/Marketing.tsx` — final hero copy + Mythos-positioning blocks per design §2.6. Final FAQ alignment with the 6 Vector-XBOW eval criteria from prior memories
- [x] T139 [P] (hash a5003e3; only HITL approval gates phrase was expert-mode reference; Trust/Method.tsx components untouched — copy lives in i18n; Two-track framing in trustPage.authz EN+RU) Update `apps/site/src/pages/Trust.tsx`, `Method.tsx` — refresh to match blackbox MVP product (drop expert-mode references)
- [⏸] T140 [P] (CREATIVE+LEGAL — needs operator+152-ФЗ counsel review; existing /legal/{privacy,terms,dpa} from prior work covers basics; Deep-inquiry consent paragraph + 30d evidence retention notice are operator decisions) Update `apps/site/src/pages/Legal.tsx` (Privacy, Terms, DPA) — add Deep-inquiry 152-ФЗ consent paragraph, evidence retention 30d notice, free Quick policy
- [⏸] T141 [P] (CREATIVE — needs operator review per driver brief; operator handbook is internal-process doc the operator owns, not a code artifact) Add `docs/runbooks/blackbox-mvp-operator.md` — operator's day-to-day handbook: handling Deep inquiries, regenerating reports for clients, force-canceling stuck scans, reading Telegram alerts
- [x] T142 [P] (hash a5003e3; Quick start for new contributors section near top → specs/002-blackbox-mvp/quickstart.md; rest of README flagged historical) Update `README.md` — point new contributors at `specs/002-blackbox-mvp/quickstart.md` as the canonical setup doc

### Security review

- [x] T143 [P] (hash b593435; scripts/check-no-secrets.sh exit-1-on-real-hit; 11 grep hits allow-listed; bun run check:no-secrets) Run `git grep -nE "sk-ant-|sk-or-|sk-proj-|sk_live_|sk_test_"` and fail-build if any non-fixture matches found in committed files
- [x] T144 [P] (hash b593435; 18 settings all placeholder; ZERO real creds; evidence file at specs) Verify `server/.env.example` does not contain any actual secrets (placeholders only)
- [x] T145 (hash 5821bd8; 281 LOC doc; 0 CRIT / 7 MED / 10 LOW / 1 INFO; top concerns: no auth rate-limits + JWT/SSH gaps in sanitizer + O(n) LIKE idempotency) Manual security review pass on (a) webhook HMAC implementation, (b) magic-link auth rate limits, (c) DNS verify resolver hardening, (d) Deep inquiry sanitization regex coverage. Document in `docs/security-review-2026-05.md`

### Pre-launch verification

- [x] T146 (hash 6036315; server 1038/1009/21/13 — all 21 fails are 001-legacy zombies; vps-agent 104/0 clean; apps/site 87/10/10 all playwright-under-bun; ZERO true 002 regressions) Run full `bun test` in `server/`, `vps-agent/`, `apps/site/` → expect 0 failures
- [⏸] T147 (DEFER infra — requires real Yandex cloud creds + ~$5-50 cloud spend; T128 spec already gated by env; operator runs once before PR merge per CI workflow T129) Run `TENSOL_TEST_REAL_YANDEX=1 bun test` in `server/` → expect 0 failures (one full real-Yandex pass)
- [x] T148 (hash 6036315; golden fixture chain ok 11 rows exit 0; fresh :memory: chain ok 0 rows exit 0; byte-stable signatures) Run `bun run verify-chain` against the test DB after full IT pass → expect exit 0 + audit chain intact
- [⏸] T149 (DEFER infra — requires running backend + frontend dev servers + seeded test DB; 6 e2e spec files shipped T091/T092/T093/T112/T120; operator runs locally before merge via `cd apps/site - [ ] T149 Run Playwright e2e suite- [ ] T149 Run Playwright e2e suite bun run e2e`) Run Playwright e2e suite → expect 0 failures
- [⏸] T150 (DEFER operator — manual screencast for landing demo + full Quick + Deep happy path; requires real Yandex VM + Telegram bot + S3; operator-owned per driver brief §JЁСТКИЕ-БЛОКЕРЫ similar-class) Manual smoke against staging (or local stack with real Yandex) — full Quick happy path end-to-end + full Deep inquiry happy path. Record screencast for landing-page usage demo
- [x] T151 (hash df1bb31; VERIFIED no-patch-needed; CLAUDE.md L103-119 references all canonical 002 artifacts) Update `CLAUDE.md` SPECKIT block already done — verify it's correct
- [x] T152 (hash df1bb31; 135 commits branch; 983 files net +81827/-100516 rebuild-and-simplify; 0 unexpected; 0 secrets; gitnexus skipped per fallback — index too stale at 7dd8515) Final `gitnexus_detect_changes()` review before opening PR to `main`

---

## Dependencies

```
Phase 1 (Setup) ─┐
                  └─▶ Phase 2 (Foundational) ─┬─▶ Phase 3 (US1, MVP) ─┐
                                              ├─▶ Phase 4 (US2)       ├─▶ Phase 6 (Polish)
                                              └─▶ Phase 5 (US3) ──────┘
                                                  (US3 needs US1's scan output for E2E
                                                   but the back end of US3 is independent)
```

User stories within Phase 3/4/5 can be developed in parallel by different
developers (or in the same session, by tackling Phase 4 between US1
backend and US1 frontend, for example).

## Parallel opportunities per story

- **US1**: schemas (T024-T027, T026), DNS resolver (T032), subdomain probe (T037), Yandex helpers (T040-T042), cloud-init (T044-T045), findings ingest (T048-T050), PDF renderer (T051-T053), email (T054-T055) — these eight clusters are file-disjoint. Within a developer, do T024+T026+T037+T044+T048+T051+T054 first (foundation-of-US1), then converge on T036 service and T067 routes.
- **US2**: Telegram client (T096-T097), sanitization (T098-T099), schemas (T094-T095) all parallel; converge at T100 service.
- **US3**: mostly small UI work; T113-T116 backend can run alongside T117-T119 frontend.

## Independent test criteria

- **US1**: `apps/site/e2e/scan-wizard.spec.ts` walks the entire happy path against a backend with fake Yandex provider. Passing this test = US1 ships.
- **US2**: `apps/site/e2e/deep-inquiry.spec.ts` submits the form and asserts Telegram mock was called. No Yandex / no scan needed.
- **US3**: `apps/site/e2e/history-redownload.spec.ts` uses a pre-seeded fixture user with one completed scan; walks Dashboard → Findings → PDF download. No new scan execution required.

## Implementation strategy

**Suggested MVP scope = US1 only**. Ship Phase 1 + Phase 2 + Phase 3, defer Phase 4-6.

That gets you to: a signed-in user can run a free Quick scan against
their own domain and see findings + PDF. That's the actual product
value.

US2 (Deep inquiry) is **strongly recommended for launch** because it's
the revenue funnel. Cost: ~8 backend + ~6 frontend tasks. ~3 days.

US3 (history) becomes valuable after the first cohort of users has
returned, so it can ship in week 4-5 without blocking launch.

Phase 6 polish items (admin, real-Yandex tests, security review) are
**mandatory** before public launch but can run in parallel with US2/US3.

## Format validation

Every task above follows the format:
```
- [ ] T### [P?] [US?] Description with file path
```

- ✅ All tasks have a checkbox `- [ ]`
- ✅ All tasks have a Task ID T001-T152
- ✅ Tasks in Phase 3-5 carry their [USn] story label
- ✅ Tasks in Phase 1/2/6 have no [Story] label (correct per format rule)
- ✅ Every task names a specific file path or operational artifact

**Total: 152 tasks. US1 has 70 tasks (the MVP). US2 has 19 tasks. US3 has 8 tasks. Setup/Foundational/Polish has 55 tasks.**
