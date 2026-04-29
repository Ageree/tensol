# Sprint 9 Contract — Browser Worker against Lab XSS Fixture

> **Author:** generator-s9
> **Sprint:** 9 — `services/browser-worker` + `tests/lab/xss-fixture` + scope-guarded crawl
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` lines 414-444
> **Baseline:** HEAD post Sprint 8 commit (1046/0 PG, 861/0 no-DB; 33 audit actions; 3 envelope kinds)
> **Mandate:** PRAGMATIC SHIP. Single-iter target. Re-use Sprint 6/7/8 patterns. Minimum viable.
> **Acceptance IDs:** 21 total (A-BR-Run, A-BR-Auth, A-BR-Artifacts, A-BR-Timeline, A-BR-Scope, A-BR-Cookie, A-BR-Coverage, A-BR-LintTC, A-BR-Tests, A-BR-Lab, A-BR-FixtureReset, A-BR-Audit-Card, A-BR-Driver-Select, A-BR-NotImpl, A-BR-Reg-1, A-BR-Reg-2, A-BR-Reg-3, A-BR-Pitfall-JSONB, A-BR-ADR, **A-BR-NavBeforeFetch**, **A-BR-RetryPolicy**) — last two added in v2 per evaluator R1+R2.
> **Revision:** v2 (2026-04-29) — adds A-BR-NavBeforeFetch (TOCTOU no-fetch probe) + A-BR-RetryPolicy (BrowserTimeoutError/storage-fault binary retry binds + IT).

---

## 1. Goal

Land the browser-recon vertical slice:

1. `tests/lab/xss-fixture` (NEW) — standalone Hono app on `http://localhost:5081`. Single endpoint `GET /search?q=<reflected>` returning `<div>${q}</div>` (raw, vulnerable). Plus `GET /redirect-evil` that 302s to `https://evil.example/` for the deny-on-redirect probe. Lifecycle exposed as `startXssLab()` + `stopXssLab()` for IT. NEVER bundled into production.
2. `services/browser-worker` (NEW guts; replaces Sprint 7 placeholder) — `BrowserDriver` interface + `FakeBrowserDriver` (deterministic, fetch-backed, no Playwright binary) + `RealBrowserDriver` (Playwright stub that throws `NotImplementedError`). Worker subscribes to `recon.browser` envelope, runs scope-guarded crawl (depth 1 from `startUrl`), captures screenshot/HAR/trace/DOM/console, persists `observations_browser` row + 3 artifacts to object storage.
3. Scope-first: every navigation/request first runs through `scope-engine.decide`. Any deny → `recon.browser.denied` audit row, no fetch, browser context aborts. Same module path as Sprint 7 coordinator (purity preserved — no edits under `packages/scope-engine/src/*`).
4. New envelope kind `recon.browser` (replaces `recon.browser.placeholder`). Coordinator publishes one `recon.browser` envelope per allow-path target after Sprint 8's decepticon session completes (or in parallel — see ADR-0002 simplification). Sprint 7 placeholder consumer is removed; placeholder envelope kind retained for back-compat in this sprint (deprecated comment, no new publishers).
5. HAR cookie-redaction: every `Cookie` request header AND every `Set-Cookie` response header value replaced with `[REDACTED]` before bytes hit object storage. Asserted in unit + IT.
6. ADR-0002 — `docs/adr/0002-direct-browser-dispatch.md` — captures the simplification (coordinator publishes `recon.browser` directly on assessment start; full Decepticon→browser plumbing deferred to a later sprint).

**Not delivered (carry-forward):** real Playwright Chromium driver (`RealBrowserDriver` is NotImplementedError stub — Phase 2), MinIO/S3 object storage (LocalObjectStorage from Sprint 8 is reused), authenticated crawl flow (interface + unit-tested skip; fixture is anonymous), validator gating (Sprint 10), report rendering (Sprint 12).

---

## 2. Hard invariants (carry from prior sprints — non-negotiable)

1. **Scope-first.** Every browser navigation/request is preceded by `decide(scope, action)`. Deny → `recon.browser.denied` audit + worker aborts that URL (NOT the whole job — depth-1 crawl continues for sibling URLs). Initial `startUrl` deny → entire job nacked terminally.
2. **Findings only after validation.** Sprint 9 NEVER inserts into `findings` or `candidate_findings`. Only `observations_browser` rows.
3. **Browser-first for web.** This sprint operationalises invariant #3 from product-spec. Web payload → browser context, never raw HTTP fetch from worker output path. (Test-only fetch inside the FakeBrowserDriver is acceptable — it simulates the Chromium network stack.)
4. **Tenant isolation.** Two assessments running in parallel in different tenants → separate browser contexts (separate `BrowserSession` ids), separate object-storage key namespaces, no cookie cross-talk.
5. **Auditability.** Every state change (job.started, navigation.allowed, navigation.denied, observation.persisted, job.completed, job.failed) emits exactly one audit row. Total +5 audit actions vs Sprint 8 floor of 33.
6. **JSONB pitfall (P1):** `observations_browser.console_messages` insert MUST `JSON.stringify(arr)` wrap.
7. **Test fixture isolation (P27):** every IT file MUST `await resetAuthState(fx.db)` in `beforeEach`. `resetAuthState` MUST DELETE `observations_browser` BEFORE `assessments` (FK order). Mirror P28 trigger DISABLE/ENABLE if any new append-only constraint is added (none in this sprint).
8. **`DATABASE_URL` runbook:** ITs run via `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`. Single PG run only (R3 from Sprint 7 — no parallel measurement-divergence).
9. **No engine purity violation:** `packages/scope-engine/src/*` not touched.
10. **Lab fixture isolation:** the Hono lab app MUST NOT be importable from production code paths. Enforced by living under `tests/lab/`; `apps/api/src/index.ts` does not reference it; `bun run lab:xss` is the only allowed external entry point.

---

## 3. Carry-forwards from prior sprints

| #     | Carry-forward                                                                                                                  | Where it lands         |
|-------|--------------------------------------------------------------------------------------------------------------------------------|------------------------|
| CF-1  | DB schema `observations_browser` already exists (mig 008). NO new migration.                                                   | A-BR-DB-1              |
| CF-2  | `audit()` helper from Sprint 4. Sprint 9 adds 5 new actions (see §6).                                                          | A-BR-Audit-1           |
| CF-3  | Sprint 8 `LocalObjectStorage` reused; no S3 SDK pulled in. Base dir injected by IT/coordinator.                                | A-BR-Artifacts         |
| CF-4  | New envelope kind `recon.browser` added to `ENVELOPE_KINDS` in `packages/queue/src/types.ts`. Defence-in-depth payload schema in `services/coordinator/src/payloads.ts`. Sprint 7's `recon.browser.placeholder` retained but deprecated. | A-BR-Queue-1           |
| CF-5  | RBAC unchanged. Timeline RBAC already covers reading new audit rows (uses existing `assessment.timeline.read` permission).     | (no change)            |
| CF-6  | Test fixture pattern from Sprint 7/8: `beforeEach(resetAuthState)` mandatory. Browser ITs included.                            | §9                     |
| CF-7  | Object-storage key shape: `tenant/<tenantId>/assessment/<assessmentId>/browser/<sessionId>/<artifact>-<sha>.<ext>`. SAFE_KEY regex from Sprint 8 covers it. | A-BR-Artifacts         |
| CF-8  | Decepticon orchestration runner (Sprint 8) still wires the assessment.start → session → completion path. Sprint 9 publishes `recon.browser` envelopes IN ADDITION to running the decepticon session — both happen on the allow path. ADR-0002 documents this. | §4 — coordinator delta |

---

## 4. Files / dirs touched (allowlist)

Generator may add or modify files under:

### NEW
- `tests/lab/xss-fixture/`:
  - `index.ts` — Hono app factory `createXssLabApp()` + `startXssLab(port)` + `stopXssLab(server)`. Endpoints: `GET /search?q=...` (reflected XSS), `GET /redirect-evil` (302 → `https://evil.example/`), `GET /healthz`.
  - `index.test.ts` — unit smoke (no PG, no IT helpers): boot on ephemeral port, assert reflection + redirect.
  - `package.json` — workspace package `@cyberstrike/lab-xss-fixture` (private; not in `apps/api` or `services/*` deps).
  - `tsconfig.json` — extends root.
  - `bin/run.ts` — `bun run lab:xss` entrypoint, listens on port 5081, logs only on start/stop.
- `services/browser-worker/src/`:
  - `types.ts` — `BrowserDriver` interface, `BrowserSession`, `NavigationRequest`, `NavigationOutcome`, `BrowserArtifacts`, `ConsoleMessage`, `NotImplementedError` (typed sentinel).
  - `scope-guard.ts` — pure: takes `(scope, url, deps) → DecisionResult`. Wraps `scope-engine.decide` with the http_request action + dns/clock/rateLimit deps. Exported for unit tests.
  - `har-redactor.ts` — pure: `redactCookies(har) → har'`. Strips `Cookie` request header + `Set-Cookie` response header. Idempotent.
  - `artifact-writer.ts` — pure-ish: `writeArtifacts(objectStorage, deps) → {screenshot, har, trace, ...}` returning per-artifact `{key, sha256, sizeBytes}`. Each artifact one `put()` call.
  - `fake-driver.ts` — `FakeBrowserDriver` class. Per-session in-memory state. Uses `globalThis.fetch` against `startUrl` to materialise a deterministic HTML body, generates a synthetic HAR (with cookie headers in BOTH directions to exercise redaction), generates a 1×1 PNG screenshot stub, generates a tiny zip-shaped trace stub. Crawl walks any `<a href>` found in the body (depth 1 cap). All capture is in-memory; bytes flow through `artifact-writer.ts` to object storage.
  - `real-driver.ts` — `RealBrowserDriver` class. Every method throws `NotImplementedError`. Future Playwright slot.
  - `select.ts` — `selectBrowserDriver(env)` reads `BROWSER_DRIVER` env, defaults `fake`. Same shape as `decepticon-adapter/src/select.ts`.
  - `worker.ts` — `handleReconBrowser(deps, envelope) → HandlerOutcome` consumer. Loads scope, validates startUrl, runs depth-1 crawl, persists artifacts + observations_browser row, emits audits, returns ack/nack. Single function, ≤200 lines.
  - `index.ts` — public re-exports.
  - `*.test.ts` — co-located unit tests (scope-guard, har-redactor, artifact-writer, fake-driver, real-driver, select, worker — worker uses an in-memory ObjectStorage stub + sqlite-mem-style fake DB so the unit suite stays no-DB).
  - `package.json` — workspace deps: `@cyberstrike/audit`, `@cyberstrike/contracts`, `@cyberstrike/db`, `@cyberstrike/object-storage`, `@cyberstrike/queue`, `@cyberstrike/scope-engine`, `zod`.
- `packages/db/src/repos/observations-browser.ts` — minimal repo: `insertObservation({db, row}) → Promise<{id}>` and `listByAssessment({db, tenantId, assessmentId})`. Encapsulates the JSONB stringify wrap so the worker calls a single typed function.
- `packages/db/src/repos/observations-browser.test.ts` — no-DB unit tests for the JSONB wrap shape.
- `tests/integration/browser/`:
  - `helpers.ts` — `withXssLab(port, cb)` lifecycle helper, `seedApprovedAssessmentForLab(fx, port)` builder, `setBrowserEnv(driver, cb)`.
  - `crawl-fixture.test.ts` — boot lab → start assessment → assert observations_browser row + 3 artifacts on disk + correct sha256 + audit lifecycle present in timeline.
  - `scope-deny-redirect.test.ts` — boot lab → start assessment with `/redirect-evil` as startUrl → assert deny audit + no observations row + browser context aborted.
  - `har-redaction.test.ts` — boot lab → start assessment with explicit `Cookie` header → fetch HAR from object storage → assert NO raw cookie value and NO `Set-Cookie` raw value.
  - `timeline.test.ts` — boot lab → assessment → `GET /assessments/:id/timeline` returns `recon.browser.job.started` + `recon.browser.observation.persisted` + `recon.browser.job.completed` audit rows.
- `docs/adr/0002-direct-browser-dispatch.md` — short ADR (≤2 KB) documenting the simplification.

### MODIFY
- `package.json` — add `tests/lab/xss-fixture` to workspaces; replace `lab:xss` placeholder script with `bun tests/lab/xss-fixture/bin/run.ts`.
- `tsconfig.json` (root project refs) — add `tests/lab/xss-fixture` and bump `services/browser-worker` if its tsconfig changes.
- `packages/queue/src/types.ts` — add `'recon.browser'` to `ENVELOPE_KINDS` (Sprint 7 `recon.browser.placeholder` retained, deprecated comment).
- `packages/queue/src/index.test.ts` — assert `ENVELOPE_KINDS.length === 4`.
- `packages/contracts/src/queue-envelope.ts` — mirror.
- `packages/contracts/src/queue-envelope.test.ts` — mirror cardinality assertion.
- `services/coordinator/src/payloads.ts` — add `reconBrowserPayloadSchema` (`assessmentId`, `targetId`, `startUrl`, `tenantId`, `traceId`).
- `services/coordinator/src/start-handler.ts` — after Sprint 8 decepticon-runner success, publish ONE `recon.browser` envelope per target (chained idempotency key from parent envelope). When `decepticonRunner` is absent, still publish the browser envelope (so Sprint 9 ITs work without a runner injected).
- `services/coordinator/src/index.ts` — re-export `reconBrowserPayloadSchema` + type.
- `apps/api/src/routes/assessments/timeline.ts` (or wherever timeline reads audit_events) — add the 5 new audit actions to the displayed-action allowlist if such allowlist exists. (TBD by inspection — if no allowlist, no edit needed.)
- `packages/contracts/src/audit.ts` — add 5 new actions; `audit.test.ts` cardinality bumped 33 → 38.
- `packages/contracts/src/audit.test.ts` — cardinality assertion + exhaustive-list assertion.
- `tests/integration/auth/helpers/auth-fixture.ts` — `resetAuthState` adds `DELETE FROM observations_browser` BEFORE `DELETE FROM assessments` (FK order). No new trigger DISABLE/ENABLE needed (observations_browser is NOT append-only).

### Excluded (NOT touched)
- `packages/scope-engine/src/*` — purity preserved.
- Sprint 1-8 migrations.
- `packages/audit/src/*` — only contracts updated.
- `services/validator-worker/`, `services/report-builder/` — Sprint 10/12.
- `findings`, `finding_evidence`, `candidate_findings` tables — Sprint 10.
- `packages/decepticon-adapter/src/*` — Sprint 8 surface frozen.

---

## 5. Acceptance criteria (A-BR-* IDs)

| ID                  | Criterion |
|---------------------|-----------|
| **A-BR-Run**        | Booting the lab fixture + starting an approved assessment with `BROWSER_DRIVER=fake` produces: exactly ONE `observations_browser` row per declared startUrl with `tenant_id` + `assessment_id`, sha256 hashes for screenshot/HAR/trace are 64-char lowercase hex, `console_messages` JSONB round-trips a non-empty array. |
| **A-BR-Auth**       | `BrowserDriver` interface accepts `authCookies?: ReadonlyArray<{name, value, domain, path}>`. `FakeBrowserDriver` honours them (echoes them in HAR before redaction). `crawl-fixture.test.ts` exercises an authenticated path via the optional cookies, but the lab XSS fixture itself is anonymous so the auth code-path is unit-tested only. (Skip-decorator pattern: IT marks one auth case as `it.skip` with reason 'fixture is anonymous'.) |
| **A-BR-Artifacts**  | Every observations_browser row references 3 object-storage keys (screenshot/har/trace). For each, `objectStorage.get(key)` returns bytes whose sha256 matches the persisted column AND sizeBytes matches `Buffer.byteLength`. |
| **A-BR-Timeline**   | `GET /assessments/:id/timeline` returns rows including `recon.browser.job.started`, `recon.browser.observation.persisted`, and `recon.browser.job.completed` audit actions. (Read path piggy-backs on Sprint 5's timeline route — no route changes required if the route already streams all audit_events for the assessment.) |
| **A-BR-Scope**      | `scope-deny-redirect.test.ts`: lab `/redirect-evil` returns 302 to `https://evil.example/`. Worker fetches the redirect destination URL through the scope-guard BEFORE issuing the follow-up request → deny → `recon.browser.navigation.denied` audit row written, NO observations_browser row created for `https://evil.example/`, browser session marked `aborted`. (Initial startUrl is in-scope; the redirect target is out-of-scope.) |
| **A-BR-Cookie**     | `har-redaction.test.ts`: HAR bytes pulled from object storage contain NO match for the literal cookie value sent (e.g., `super-secret-token`) AND no match for any `Set-Cookie` response value. Unit test on `redactCookies()` asserts the same. |
| **A-BR-Coverage**   | ≥80% line coverage on `services/browser-worker/src/**` (excluding `real-driver.ts` which is a NotImplementedError stub — surface-area carve-out, mirrors Sprint 8 carve-out for `RealDecepticonAdapter`). Real-driver itself: 100% coverage of the throw paths via unit test. |
| **A-BR-LintTC**     | `bun run lint` clean (0 errors). `bun run typecheck` clean. |
| **A-BR-Tests**      | `bun test` (no DB) 0 fail. `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` 0 engine fail (3 known pre-existing flakes acceptable: A-Proj-1 pagination, C29 audit-emission, B14 append-only). Single PG run only — R3 discipline. |
| **A-BR-Lab**        | `bun run lab:xss` boots the Hono app on `http://localhost:5081` and `GET /search?q=<svg/onload=alert(1)>` reflects the raw payload back inside `<div>...</div>`. Lab fixture is in `tests/lab/`, NOT in any `apps/*` or `services/*` runtime entrypoint. `grep -rn 'tests/lab' apps/api/src services/*/src` returns 0 results. |
| **A-BR-FixtureReset** | `resetAuthState` deletes `observations_browser` BEFORE `assessments` (verified by FK-violation test — attempting reset with an orphaned observations_browser row succeeds). Every new IT under `tests/integration/browser/` calls `await resetAuthState(fx.db)` in `beforeEach` (grep ≥2/file). |
| **A-BR-Audit-Card** | `AUDIT_ACTIONS` length transitions 33 → 38 (+5 new). `audit.test.ts` cardinality assertion updated. Exhaustive-list assertion updated. |
| **A-BR-Driver-Select** | `BROWSER_DRIVER=real` env causes `selectBrowserDriver()` to return `RealBrowserDriver`; default and `fake` return `FakeBrowserDriver`; unknown value throws. Tested. |
| **A-BR-NotImpl**    | `import { RealBrowserDriver } from '@cyberstrike/browser-worker'; new RealBrowserDriver().launch({...})` rejects with `NotImplementedError` (typed `instanceof` + `.name === 'NotImplementedError'`). |
| **A-BR-Reg-1**      | No regression: full PG suite ≥1046 pass / 0 engine fail (vs Sprint 8 floor). |
| **A-BR-Reg-2**      | Scope engine purity preserved (NO edits to `packages/scope-engine/src/`). |
| **A-BR-Reg-3**      | Decepticon-adapter surface preserved (NO edits to `packages/decepticon-adapter/src/`). |
| **A-BR-Pitfall-JSONB** | `observations_browser.console_messages` insert wraps via `JSON.stringify(arr)`. IT round-trip asserts a non-empty array (≥1 ConsoleMessage). |
| **A-BR-ADR**        | `docs/adr/0002-direct-browser-dispatch.md` exists, ≤2 KB, captures: (a) the simplification (coordinator publishes `recon.browser` directly, not via Decepticon `recon_request`), (b) why (Sprint 8 didn't wire a recon_request stream), (c) follow-up (Phase 2 will route via Decepticon when the real adapter lands). |
| **A-BR-NavBeforeFetch** | TOCTOU-closure probe. Unit test on `worker.handleReconBrowser` injects (a) a stubbed scope-engine that returns `{allowed: false}` for the startUrl AND (b) a recording `fetch` deps stub. After handler runs: `expect(fetchStub.mock.calls).toHaveLength(0)` AND `recon.browser.navigation.denied` audit row emitted AND zero `observations_browser` rows persisted. Same probe repeated in `scope-deny-redirect.test.ts` IT for the redirect-target deny path: a recording fetch stub injected into `FakeBrowserDriver` asserts the `https://evil.example/` URL was NEVER fetched (the lab `/redirect-evil` endpoint hit-counter stays at exactly 1). Binds the no-fetch invariant against future refactors. |
| **A-BR-RetryPolicy**| Binary retry classification. Unit tests: (a) `FakeBrowserDriver` throws `BrowserTimeoutError` (typed sentinel exported from `services/browser-worker/src/types.ts`) → `worker.handleReconBrowser` returns `HandlerOutcome` of kind `nack` carrying a NON-`__terminal` error (transient classification — queue retry-classifier retries up to `maxAttempts`); (b) `objectStorage.put` throws a generic `Error` → handler returns `nack` with NON-`__terminal` error (transient). IT — `retry-transient.test.ts`: inject a one-shot fault on the FIRST FakeBrowserDriver `launch` call (succeed on second), boot lab + start assessment, assert the corresponding `jobs` row eventually shows `attempts >= 2` AND ends in `status='succeeded'`. Terminal classification: scope-deny on startUrl → handler returns `nack` carrying `ScopeDenyError` (already `__terminal:true` from Sprint 7) → `jobs.status='failed_terminal'` after exactly 1 attempt. Storage-failure-after-maxAttempts terminal escalation is queue-classifier responsibility (Sprint 7 surface) and is NOT re-asserted here — Sprint 9 only binds the per-error-shape mapping. |

---

## 6. New audit actions (33 → 38)

Sprint 9 adds:
- `recon.browser.job.started`
- `recon.browser.job.completed`
- `recon.browser.job.failed`
- `recon.browser.navigation.denied`
- `recon.browser.observation.persisted`

`AUDIT_ACTIONS` cardinality assertion updates `expect(...).toBe(33)` → `expect(...).toBe(38)`.

`audit.test.ts` exhaustive list assertion: append the 5 new actions in the same order.

Each action emits exactly one row (CF-2 invariant). Outcomes:
- `recon.browser.job.started` → `success`
- `recon.browser.job.completed` → `success`
- `recon.browser.job.failed` → `failure`
- `recon.browser.navigation.denied` → `denied`
- `recon.browser.observation.persisted` → `success`

---

## 7. New ENVELOPE_KINDS (3 → 4)

Sprint 8 floor: 3 kinds (`assessment.start`, `recon.browser.placeholder`, `decepticon.findings`).

Sprint 9 adds: `recon.browser`.

- `packages/queue/src/types.ts`
- `packages/contracts/src/queue-envelope.ts`
- both test files updated to assert exact 4-element list.

`services/coordinator/src/payloads.ts` adds `reconBrowserPayloadSchema`:

```
{
  tenantId: uuid,
  projectId: uuid | null,
  assessmentId: uuid,
  targetId: uuid,
  startUrl: string (URL, http/https),
  authCookies?: array of {name, value, domain, path},
  traceId: 32-hex,
}
```

The Sprint 7 `recon.browser.placeholder` envelope kind is **retained** but marked deprecated in a JSDoc comment. No new publishers. Sprint 7 placeholder consumer is removed (the subscribe call in `coordinator/src/index.ts` now wires `recon.browser` instead).

---

## 8. Coordinator delta

`services/coordinator/src/start-handler.ts`:

```
// after the existing decepticonRunner block (Sprint 8) on the allow path:
for (const target of targets) {
  await deps.adapter.publish({
    ...envelope-shape...
    kind: 'recon.browser',
    idempotencyKey: `${envelope.idempotencyKey}:browser:${target.target_id}`,
    payload: {
      tenantId, projectId, assessmentId, targetId, startUrl, traceId
    }
  });
}
// publishReconChildJobs (Sprint 7's placeholder publisher) is replaced.
```

`services/coordinator/src/index.ts`:
- the `subscribe('recon.browser.placeholder', reconPlaceholderHandler, ...)` call is removed.
- a NEW subscribe path for `recon.browser` is wired only if `deps.browserHandler` is provided (test seam — the Sprint 9 ITs inject `handleReconBrowser` from `services/browser-worker`). Default-off keeps Sprint 8 ITs working unchanged.

---

## 9. Test plan

### Unit (no DB)
- `services/browser-worker/src/scope-guard.test.ts` — allow path, deny path, DNS-fail-closed, redirect target evaluated independently.
- `services/browser-worker/src/har-redactor.test.ts` — `Cookie` request header redacted; `Set-Cookie` response header redacted; idempotent on already-redacted HAR; nested entries don't crash.
- `services/browser-worker/src/artifact-writer.test.ts` — 3 puts per call, sha256/size correct, key shape obeys SAFE_KEY regex, path traversal rejected.
- `services/browser-worker/src/fake-driver.test.ts` — start/navigate/abort, depth-1 crawl, console-message buffering, redirect surface, mock fetch through a stubbed `fetch`.
- `services/browser-worker/src/real-driver.test.ts` — every method rejects with `NotImplementedError`.
- `services/browser-worker/src/select.test.ts` — env values: `fake` / `real` / unset / unknown.
- `services/browser-worker/src/worker.test.ts` — handler with in-memory DB stub; allow→ack, deny-startUrl→nack terminal, mid-crawl-deny→ack but no observation, driver crash→nack transient. **A-BR-NavBeforeFetch probe**: scope-deny + recording-fetch stub → 0 fetch calls + audit row + 0 observations rows. **A-BR-RetryPolicy probes**: BrowserTimeoutError → nack non-terminal; ObjectStorage put throws → nack non-terminal; ScopeDenyError → nack terminal.
- `tests/lab/xss-fixture/index.test.ts` — boot on ephemeral port, reflected XSS, redirect-evil 302.
- `packages/contracts/src/audit.test.ts` — +5 actions cardinality + list.
- `packages/queue/src/index.test.ts` — +1 envelope kind cardinality.
- `packages/db/src/repos/observations-browser.test.ts` — JSONB stringify wrap.

### Integration (PG)
Every IT under `tests/integration/browser/` MUST call `await resetAuthState(fx.db)` in `beforeEach` (P27). Lab fixture started in `beforeAll`, stopped in `afterAll`. Single sequential PG run (R3).

- `crawl-fixture.test.ts`
- `scope-deny-redirect.test.ts` — also asserts the recording-fetch stub on FakeBrowserDriver shows zero hits to `https://evil.example/` (A-BR-NavBeforeFetch IT half).
- `har-redaction.test.ts`
- `timeline.test.ts`
- `retry-transient.test.ts` — A-BR-RetryPolicy IT: one-shot launch fault → second attempt succeeds → `jobs.attempts >= 2` + `jobs.status='succeeded'`.

---

## 10. Risks (R1..R6)

| R# | Risk | Mitigation |
|----|------|------------|
| **R1** | **Playwright binary not in CI / heavy install footprint.** | `RealBrowserDriver` is NotImplementedError stub. Sprint 9 ships with FakeBrowserDriver only; Playwright binaries never installed. Phase 2 fills `RealBrowserDriver`. ITs use Fake — same fixture-driven pattern as Sprint 8. |
| **R2** | **Lab fixture leaks into prod build.** | (a) Lives under `tests/lab/`; (b) `apps/api` workspace has zero deps on `tests/lab`; (c) `grep` assertion in A-BR-Lab; (d) the `tests/lab` dir is excluded from any tsc project ref that compiles to `apps/api/dist`. |
| **R3** | **Single PG run discipline (Sprint 7 measurement-divergence lesson).** | `bun test` PG run executed exactly ONCE during verification. No retry-loop, no parallel runs. If a known flake hits (A-Proj-1, C29, B14), it's accepted; only NEW failures count. |
| **R4** | **Cookie redaction false-negative (sensitive value leaks into HAR despite redactor).** | Unit test asserts both directions (Cookie + Set-Cookie); IT assertion grep's the persisted HAR bytes for the literal token. Redactor is a single function with comprehensive test (no per-callsite copies). |
| **R5** | **Out-of-scope redirect bypasses scope-guard.** | Worker calls scope-guard for the redirect destination URL BEFORE issuing the follow-up fetch. Test `scope-deny-redirect.test.ts` exercises exactly this. Mirror of Sprint 6 round-2 P1 fix (redirect destinations evaluated independently). |
| **R6** | **JSONB pitfall recurrence on `console_messages`.** | Repo function `insertObservation()` is the ONLY writer; it wraps with `JSON.stringify(arr)`. IT round-trips a non-empty array. Mirrors P1 catalog entry. |

---

## 11. File-size discipline (R3 carry from Sprint 8)

- `services/coordinator/src/start-handler.ts` already at ~300 lines; Sprint 9 delta ≤30 lines (publish loop). Stays well under 800.
- `services/browser-worker/src/worker.ts` ≤200 lines.
- `tests/lab/xss-fixture/index.ts` ≤150 lines.

---

## 12. Out of scope (deferred)

- Real Playwright Chromium driver — `RealBrowserDriver` stub only.
- MinIO/S3 object storage — `LocalObjectStorage` reused.
- Authenticated crawl on the fixture — interface honoured, fixture is anonymous.
- Decepticon `recon_request` → coordinator → browser plumbing — ADR-0002 records the simplification.
- `findings` / `candidate_findings` writes — Sprint 10.
- Observations browser repo `findById`, pagination, etc. — only `insertObservation` + `listByAssessment` ship.
- Trace replay / `.trace.zip` validation — bytes are stored opaquely; Sprint 10 validator may inspect.

End of contract.
