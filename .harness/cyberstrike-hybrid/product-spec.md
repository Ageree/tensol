# Product Spec — CyberStrike Hybrid (First Implementation Slice)

> Authoring agent: Planner
> Project: cyberstrike-hybrid
> Source plan: `.omx/plans/implementation-cyberstrike-hybrid.md` (read-only)
> Source spec: `PROJECT-SPECS-cyberstrike-hybrid.md` (read-only)
> Source stack: `STACK-cyberstrike-hybrid.md` (read-only)
> Audience: Generator + Evaluator agents in the 3-agent harness.

---

## 1. Executive Summary

CyberStrike Hybrid is a multi-tenant SaaS / private-cloud platform for authorized autonomous pentest and adversary emulation in owned or explicitly authorized environments. The platform combines:

- **Decepticon** (autonomous pentest core, 16 specialist agents, kill chain, OPPLAN/RoE/ConOps, Neo4j attack graph, Offensive Vaccine loop) as the engine,
- a custom product layer providing **tenancy, auth, projects, targets, assessments, scope enforcement, queue orchestration, deterministic validation, findings, evidence, reporting, audit and compliance**,
- **browser-first** signal via Playwright as primary signal for web assessments,
- **HTTP probing** and **CyberStrike-curated MCP tools** as supplementary signal,
- **deterministic validators** as a mandatory gate before any finding is published,
- **hybrid LLM routing** (Opus 4.7 for reasoning, DeepSeek V4 for cost, Kimi K2.6 for verifier diversity) via LiteLLM,
- **Yandex Cloud** as the deployment substrate.

This spec defines the **first implementation slice** (plan §25) — a narrow vertical slice covering Sprints 1–12. It exercises the core product promise end-to-end (scope-first, browser-first, validation-only, evidence-first) **without** depending on real Decepticon, real CyberStrike runners, AD tooling, C2 frameworks, or external LLM providers. Real engine integration begins in Phase 2 of the broader plan and is **out of scope here**.

### 1.1. Hard invariants (plan §2 — non-negotiable across all sprints)

1. **Scope-first execution.** Every action passes scope enforcement; deny overrides allow; out-of-scope actions are not retried automatically.
2. **Findings only after deterministic validation.** Candidate findings exist, but only confirmed findings reach UI/reports.
3. **Browser-first for web assessments.** Browser-worker is the primary signal source; HTTP supplements but does not replace browser evidence.
4. **Ownership-verified high-impact tools.** Sliver/C2/reverse-shell/webshell/credential-audit/AD flows require authenticated user + verified ownership + active approved assessment + in-scope target + allowed time window + tool policy + audit log.
5. **Cost caps never block an assessment.**
6. **Auditability.** Every security-relevant decision is reconstructible (who/what/when/why/evidence/validator/model).

### 1.2. Architectural decisions

- **Bun workspaces monorepo** (one `package.json` at repo root with `workspaces` declaring `apps/*`, `services/*`, `packages/*`); TypeScript strict mode everywhere.
- **Layered packages** carry business logic; services are thin adapters that wire packages to transport (HTTP, queue, browser).
- **Immutability** throughout: every domain operation returns a new object; no in-place mutation of inputs.
- **Scope-engine as standalone package** (`packages/scope-engine`) with no I/O dependencies — pure function `decide(input) -> decision`. Imported by API, coordinator, workers, validator, report builder.
- **Append-only audit and LLM audit tables** enforced at repository layer (no `update` / `delete` exposed).
- **Queue abstraction with local adapter** (file/in-memory based, single-process safe) used in dev and tests; Yandex MQ adapter stub deferred. Same envelope for both.
- **Fake Decepticon adapter** in Sprint 8 is a deterministic in-process stand-in: produces a fixed candidate finding stream from a recorded fixture so Sprints 9–12 can run end-to-end without a real engine.
- **Vulnerable lab fixture** for XSS lives under `tests/lab/xss-fixture/` — a tiny standalone Hono app with a reflected XSS sink; never reachable from production builds.
- **No production deploy targets** in this slice. Local Docker Compose only (Postgres + object-storage emulator + queue emulator).

### 1.3. Repo layout (plan §3.1)

```
apps/
  web/                       React + Vite SPA
  api/                       Hono + Bun product API
services/
  coordinator/               assessment lifecycle + dispatch
  browser-worker/            Playwright-driven browser signal
  validator-worker/          deterministic validators (XSS first)
  report-builder/            PDF/HTML/JSON + evidence ZIP
  # http-worker, cyberstrike-worker, llm-gateway: scaffold dirs only — out of slice
packages/
  config/                    typed config loader (zod), fail-fast
  contracts/                 zod DTOs, queue envelopes, event schemas
  db/                        kysely migrations + repositories
  authz/                     RBAC matrix, tenant guard, ownership check
  scope-engine/              normalization + allow/deny decision
  audit/                     append-only audit writer
  object-storage/            S3-compatible adapter + local FS adapter
  queue/                     queue abstraction + local adapter
  telemetry/                 OTel + Sentry init (stubbed in slice)
  validators/                shared validator primitives
  reports/                   report domain models + templates
  # skill-library, decepticon-adapter, cyberstrike-runner: deferred
infra/
  docker/                    docker-compose.local.yml
tests/
  fixtures/
  integration/
  e2e/
  lab/
    xss-fixture/             vulnerable Hono app for validator e2e
docs/
  adr/
  runbooks/
```

### 1.4. Non-goals for the first slice

- No real Decepticon engine, no Kubernetes, no Yandex Cloud deployment, no per-assessment namespaces.
- No real LLM calls (production or test); LLM gateway scaffolded but unused.
- No HTTP-worker, no cyberstrike-worker, no MCP, no Nuclei, no OOB / Interactsh service.
- No SSRF/file-read/RCE validators; only **XSS validator** (browser replay, no OOB needed).
- No skill library import, no framework mappings, no tool catalog UI.
- No AD, no cloud scanning, no C2, no post-exploit, no high-impact tooling.
- No SSO; only email/password + bcrypt + session cookies.
- No PDF rendering pipeline beyond a basic HTML→PDF (Puppeteer headless) producing one report type (technical pentest report).
- No production observability stack; local console + Sentry stubs only.

### 1.5. Cross-sprint conventions

- **TDD mandatory** — RED before GREEN; 80%+ coverage for every package and service touched.
- **Sprint contract first.** Generator drafts `sprint-N-contract.md` listing testable acceptance criteria; Evaluator approves before code lands.
- **Sprint PASS = lint + typecheck + unit tests + integration tests (where applicable) + tenant-isolation tests + scope/IDOR/audit security tests.** A sprint that adds a new layer must also pass **all earlier sprint suites**.
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`).
- **No hardcoded secrets.** All config via env vars validated at startup with zod; missing required secret aborts boot in non-`local` env.
- **Files <800 lines, target 200–400.** Many small files > few large files.
- **Immutability enforced** — no `Array.prototype.push` on shared state, no in-place spread mutation; prefer `readonly` on DTO types, structural copies.
- **Every security-relevant decision audited.** State change without an audit event is a bug.

---

## 2. Sprint Breakdown

> Each sprint declares: **Goal**, **Deliverables**, **Files/dirs touched**, **Acceptance criteria**, **Dependencies**, **Test strategy**, **Edge cases**.
> Sprint contracts (`.harness/cyberstrike-hybrid/sprint-N-contract.md`) are written by Generator and reviewed by Evaluator before each sprint starts.

---

### Sprint 1 — Repo bootstrap, monorepo workspace, lint/typecheck/test scaffolding

(Plan §4.1)

**Goal.** Empty-but-bootable monorepo where every later sprint plugs into a working CI gate.

**Deliverables.**
- Root `package.json` declaring Bun workspaces (`apps/*`, `services/*`, `packages/*`).
- Root `tsconfig.base.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`. Per-package `tsconfig.json` extends base and sets `composite: true`.
- Root `bunfig.toml` pinning Bun runtime version.
- Linting via Biome (`biome.json`) — single tool for lint + format. Justification: zero-config, fast on Bun, no ESLint plugin churn.
- Test runner: `bun test` for unit, with a `vitest`-compatible assertion style. Coverage via `bun test --coverage` with thresholds in `bunfig.toml` (80/80/80/80).
- Pre-existing dirs scaffolded as **empty workspaces with `package.json` + placeholder `index.ts`**: `apps/web`, `apps/api`, `services/coordinator`, `services/browser-worker`, `services/validator-worker`, `services/report-builder`, plus all `packages/*` listed in §1.3. Stub workspaces compile and export nothing.
- Root scripts: `bun run lint`, `bun run typecheck`, `bun test`, `bun run build`.
- `infra/docker/docker-compose.local.yml` with Postgres 16 (named container `cs-postgres`) on `localhost:5433`, MinIO (S3 emulator) on `localhost:9000/9001`, and a placeholder `queue-emulator` service (just a healthchecked tiny image) — service definitions only, real adapters land in later sprints.
- `packages/config` with zod-validated config loader (`loadConfig(schema, env=process.env)`); fails fast if required secrets missing in non-`local` `APP_ENV`.
- GitHub Actions CI: jobs `lint`, `typecheck`, `unit-tests` (matrix per workspace), `migration-check` (placeholder, expands in Sprint 2), `image-build` (placeholder).
- Root `README.md` and `docs/adr/0001-monorepo-bun-workspaces.md`.

**Files/dirs touched.** Whole repo skeleton from scratch.

**Acceptance criteria.**
- `bun install` succeeds from clean clone.
- `bun run lint`, `bun run typecheck`, `bun test` all green.
- Each workspace builds independently.
- `packages/config` rejects boot when `APP_ENV=staging` and required keys missing — covered by unit test.
- `docker compose -f infra/docker/docker-compose.local.yml up -d` brings up Postgres + MinIO healthy.
- CI workflow runs all four jobs on push to a feature branch.

**Dependencies.** None.

**Test strategy.** Unit tests for `packages/config` only (other packages still placeholders). Smoke test ensuring every workspace exports its placeholder `index.ts` without error.

**Edge cases.** Missing env in `local` is allowed (defaults applied); missing env in `dev|staging|production|internal-lab` aborts boot. Bun version mismatch fails CI early.

---

### Sprint 2 — DB schema, migrations, tenant-aware repositories

(Plan §4.2)

**Goal.** Postgres schema with tenant isolation enforced at the repository layer.

**Deliverables.**
- DB driver: **Kysely** + `pg` for queries; **node-pg-migrate** (or kysely's built-in migrator) for migrations. Justification: type-safe SQL, Bun-compatible, mature.
- Migration files in `packages/db/migrations/` for **only the tables this slice needs**:
  - `tenants`, `users`, `user_sessions`, `mfa_secrets` (Sprint 3 uses these).
  - `projects`, `targets`, `assessments`, `assessment_scope_rules`, `assessment_artifacts` (Sprint 5 + 6).
  - `jobs` (Sprint 7).
  - `decepticon_sessions` (minimal — Sprint 8).
  - `observations_browser` (Sprint 9).
  - `candidate_findings`, `findings`, `finding_evidence` (Sprint 10–11).
  - `audit_events`, `llm_audit_events` (Sprint 4 / scaffolded here).
  - `reports` (Sprint 12).
  - **Deferred** (no migrations in this slice): `observations_http`, `observations_cyberstrike`, `observations_decepticon`, `oob_events`, `skill_library`, `framework_mappings`, `tool_catalog`.
- Schema rules enforced:
  - Every tenant-owned table has `tenant_id UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL`, `updated_at TIMESTAMPTZ NOT NULL`, partial index on `(tenant_id, …)`, unique constraints scoped by `tenant_id`.
  - Append-only tables (`audit_events`, `llm_audit_events`, `finding_evidence`, `assessment_artifacts`) — no `updated_at`; repository exposes only `insert` and `findBy*`. No `update` / `delete` methods.
  - Status enums implemented via Postgres `CHECK` constraints (string columns) for portability with Yandex managed PG.
  - Optimistic version columns on `assessments`, `targets`, `assessment_scope_rules`.
  - Large payloads stored as `(object_storage_key TEXT, sha256 CHAR(64), size_bytes BIGINT)` — **no inline blobs**.
- `packages/db` exports:
  - Typed Kysely instance factory.
  - Repository per aggregate (e.g. `projectRepository`, `assessmentRepository`) with **mandatory tenant context argument**.
  - `runInTenant(tenantId, fn)` helper that sets a per-query `WHERE tenant_id = $1` guard.
  - Tests asserting that calling a repository without tenant context throws.
- Migration helper script in CI: `bun run db:migrate:check` applies migrations to a fresh ephemeral PG container, then rolls forward — fails CI if any migration is non-deterministic.

**Files/dirs touched.** `packages/db/{src,migrations}`, `infra/docker/docker-compose.local.yml` (already up), CI workflow.

**Acceptance criteria.**
- All migrations apply cleanly to empty DB; rollback for the latest migration works.
- Repository contract tests: passing wrong `tenantId` to a query returns zero rows; omitting `tenantId` raises a typed error (`MissingTenantContextError`).
- Append-only repositories expose no mutation method; attempting to call a non-existent `update` is a TypeScript compile error (verified with a tsd test).
- 80%+ coverage on `packages/db`.

**Dependencies.** Sprint 1.

**Test strategy.** Unit tests for repository wiring (with sqlite-in-memory or pg-mem fallback only when behaviour is portable; otherwise spin a Testcontainers PG). Integration tests against the docker-compose Postgres.

**Edge cases.** Cross-tenant query attempts (must return 0 rows). Concurrent updates without version increment must fail (optimistic-lock test). Migration failure mid-batch must roll back atomically.

---

### Sprint 3 — Auth, RBAC, tenancy middleware

(Plan §4.3)

**Goal.** Hono API can authenticate users, resolve tenant, and gate every request through RBAC.

**Deliverables.**
- `apps/api` Hono server with routes:
  - `POST /auth/register` (platform_admin-bootstrap only in this slice — see §1.4).
  - `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
  - `POST /auth/mfa/enable`, `POST /auth/mfa/verify` (TOTP, optional in slice but flow exists).
  - `POST /auth/password/reset/request`, `POST /auth/password/reset/confirm` (token to `audit_events`, no email send in slice).
- `packages/authz`:
  - Role enum: `platform_admin`, `tenant_admin`, `security_lead`, `operator`, `developer`, `auditor`, `viewer`.
  - RBAC matrix as a static, immutable map keyed by `(role, resource, action)`.
  - `assertCan(actor, action, resource)` returns `Decision` (allow/deny + reason) — pure function, no I/O.
  - `tenantGuard` Hono middleware: extracts session, resolves tenant, attaches `{actor, tenantId}` to context. Rejects with 401 if no session, 403 if cross-tenant access detected.
  - Ownership-check helper: `assertOwnership(tenantId, resource)` — guards every CRUD route.
- Session storage in `user_sessions` (httpOnly secure cookie, 1h sliding TTL, server-side store). Bcrypt for passwords (cost 12).
- MFA TOTP via `otplib`, secret stored in `mfa_secrets`.
- Test fixtures: seed two tenants × two users each, all roles represented.

**Files/dirs touched.** `apps/api/src/{routes,middleware}`, `packages/authz/src`, `packages/db` (read-only).

**Acceptance criteria.**
- Login → cookie → `GET /auth/me` returns actor + tenant.
- IDOR test: user A in tenant T1 cannot read/write resources in tenant T2 (checked across `/projects`, `/targets`, `/assessments` once Sprint 5 lands; for Sprint 3, asserted on a fixture endpoint `/_test/resource/:id`).
- Auditor role: read-only access proven via RBAC matrix tests; cannot mutate.
- Developer role: cannot edit scope or tool policy (asserted via matrix test, not yet through real endpoint).
- Login/logout/MFA-enable produce `audit_events`.
- 80%+ coverage on `packages/authz` and `apps/api/src/routes/auth`.

**Dependencies.** Sprints 1–2.

**Test strategy.** Unit tests for RBAC matrix. Integration tests for auth routes against docker-compose Postgres. Tenant-isolation suite uses two seeded tenants, runs every privileged route with a cross-tenant session, asserts 403/empty.

**Edge cases.** Session reuse after logout. MFA replay (TOTP step window must reject reused codes). Password reset token reuse (single-use, audited).

---

### Sprint 4 — Audit subsystem

(Plan §4.4)

**Goal.** Append-only audit pipeline with a typed event envelope and middleware that captures every state-changing API call.

**Deliverables.**
- `packages/audit`:
  - `AuditEvent` zod schema (in `packages/contracts`): `id`, `actor` (`{type: 'user'|'service', id, name}`), `tenantId`, `projectId?`, `assessmentId?`, `action`, `resourceType`, `resourceId?`, `before?` (JSON metadata, secrets redacted), `after?`, `ip?`, `userAgent?`, `traceId`, `occurredAt`.
  - `auditWriter.append(event)` — only insert path; uses `audit_events` repository.
  - `auditMiddleware(actionResolver)` Hono middleware that wraps a route handler, captures `before`/`after` from the response, redacts known sensitive keys (`password`, `token`, `secret`, `cookie`).
  - `denyAudit(actor, action, reason, context)` helper used by scope engine and tool policy in later sprints.
  - Service actor model for coordinator/workers (Sprint 7+) — pre-seeded service actor IDs.
- Sentry breadcrumb integration stub (`packages/telemetry`) — disabled by default, configured via env.

**Files/dirs touched.** `packages/audit`, `packages/contracts`, `packages/telemetry`, `apps/api` (wire middleware into auth + future CRUD routes).

**Acceptance criteria.**
- `audit_events` insert from auth endpoints (login/logout/MFA enable/MFA verify/password reset).
- Repository test asserts `update` and `delete` are absent (compile-time); runtime test asserts attempting raw SQL `UPDATE audit_events` fails (Postgres trigger-based safeguard recommended).
- Secret redaction unit test covers nested objects and arrays.
- 80%+ coverage.

**Dependencies.** Sprints 1–3.

**Test strategy.** Unit tests for redaction, envelope shape, append-only constraint. Integration tests against the API verify audit insert per route.

**Edge cases.** Logging while DB is read-only must not throw a 500 — degrade gracefully with structured stderr log. Redaction of objects with circular refs must not loop forever.

---

### Sprint 5 — Projects, Targets, Assessments CRUD + state machine

(Plan §4.5)

**Goal.** Three primary aggregates with REST endpoints, full RBAC + tenant gating + audit, and assessment state machine enforced at the use-case layer.

**Deliverables.**
- Endpoints (all under `/api/v1`):
  - **Projects.** `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id`, `GET /projects/:id/summary`.
  - **Targets.** `GET/POST /projects/:projectId/targets`, `GET/PATCH/DELETE /targets/:id`, `POST /targets/:id/ownership-proof` (records claim + audit; verification path stubbed — sets `ownership_status='unverified'|'pending'|'verified'`), `GET /targets/:id/observations` (returns empty list this slice; populated by browser-worker in Sprint 9).
  - **Assessments.** `GET/POST /projects/:projectId/assessments`, `GET/PATCH /assessments/:id`, `POST /assessments/:id/submit`, `POST /assessments/:id/approve`, `POST /assessments/:id/start`, `POST /assessments/:id/pause`, `POST /assessments/:id/resume`, `POST /assessments/:id/cancel`, `GET /assessments/:id/status`, `GET /assessments/:id/timeline`, `GET /assessments/:id/artifacts`.
- Assessment state machine in `packages/contracts/src/assessment-state.ts` as a pure function `transition(current, command) -> next | StateError`. States: `draft`, `submitted`, `approved`, `running`, `paused`, `cancelled`, `completed`, `failed`. Transitions enforced exactly as specified in plan §4.5.
- **Idempotency keys** on `start|pause|resume|cancel` (`Idempotency-Key` header → stored in `assessment_artifacts` keyed table; replay returns the prior result).
- High-impact category guard (stub): if assessment requests `c2|post_exploit|ad|credential_audit`, target must have `ownership_status='verified'` for **all** included targets — otherwise 422 with typed error. Verification flow itself remains stubbed in this slice (no actual ownership challenge).

**Files/dirs touched.** `apps/api/src/routes/{projects,targets,assessments}`, `packages/db/src/repositories`, `packages/contracts/src`, `packages/audit` integration.

**Acceptance criteria.**
- IDOR: tenant T1 user cannot list/read/mutate T2's projects/targets/assessments.
- Invalid state transition (e.g. `start` from `draft`) returns 409 with typed error.
- Replayed `Idempotency-Key` returns the stable prior result without duplicating side effects.
- Assessment with high-impact category and unverified target returns 422.
- Audit events emitted for: create/update/delete on each aggregate, submit/approve/start/pause/resume/cancel.
- 80%+ coverage.

**Dependencies.** Sprints 1–4.

**Test strategy.** Unit tests for the state machine (table-driven). Integration tests for every endpoint × every role × tenant-isolation matrix. Idempotency replay test.

**Edge cases.** Concurrent `approve` calls on the same assessment (optimistic version conflict — exactly one wins). Approving an assessment with an empty target list is rejected. Cancelling a `completed` assessment is a no-op with a typed error.

---

### Sprint 6 — Scope engine: effective scope, normalization, enforcement integration points

(Plan §5)

**Goal.** Pure scope-decision package shared across API, coordinator, workers, validator, and report builder; integrated as the *single source of truth* for allow/deny.

**Deliverables.**
- `packages/scope-engine`:
  - **Inputs:** `{tenantPolicy, platformPolicy, projectTargets, assessmentTargets, allowRules, denyRules, toolCatalog, assessmentFlags, timeWindow}`.
  - **Outputs:** `EffectiveScope` (normalized rule set) and `decide(action) -> Decision`. `Decision = {allowed: boolean, reason: string, matchedAllowRuleIds: string[], matchedDenyRuleIds: string[], normalizedTarget?, toolPolicyResult?, timeWindowResult?}`.
  - **Rule types** (plan §5.1): `domain`, `subdomain`, `url_prefix`, `ip`, `cidr`, `port`, `protocol`, `cloud_account`, `kubernetes_namespace`, `repository`, `time_window`, `rate_limit`, `tool_category`, `tool_name`, `http_method`, `path_pattern`. **All implemented in this slice** (URL/IP/domain primarily exercised; cloud/k8s/repository tested with synthetic fixtures).
  - **URL/DNS/IP normalization** (plan §5.2): scheme lowercase, punycode hostname, trailing-dot strip, default-port elision, path traversal segment collapse, IPv4/IPv6 canonicalization, DNS resolution before network execution, **block** loopback / link-local / metadata IP / private IP unless explicitly authorized.
  - **Deny overrides allow.** Documented invariant in code comment + tested with conflicting rule fixtures.
- **Enforcement integration points** (plan §5.3) — wired in this sprint:
  - API `POST /api/v1/assessments/:id/scope/validate` — returns the engine decision for a candidate action.
  - Pre-enqueue guard in coordinator (Sprint 7) — `decide` called before any job is dispatched.
  - Worker pre-execution guard (Sprint 9 onwards) — `decide` called before every network/browser request.
  - Validator replay guard (Sprint 10) — `decide` called before replay.
  - Report publication guard (Sprint 12) — refuses to include a finding whose target falls outside effective scope.
- Audit hook: every `denied` decision emits a `denyAudit` event with `matchedDenyRuleIds`, normalized target, and reason.

**Files/dirs touched.** `packages/scope-engine` (new), `packages/contracts`, `apps/api/src/routes/assessments` (scope/validate endpoint).

**Acceptance criteria.**
- Unit suite covers: normalization (URL/IP/domain), allow/deny precedence, time window matching, rate limit accounting, tool category flags, cloud/AD/post-exploit/C2 flags.
- SSRF-style probe (e.g. `http://169.254.169.254/...`) is blocked unless explicitly in scope.
- Cross-scope redirect destination is blocked + audited.
- Domain target resolving via DNS to private IP is blocked unless private IP/CIDR explicitly authorized.
- E2E test: `POST /scope/validate` returns expected decision for a representative allow + deny rule set.
- 80%+ coverage; engine has zero I/O imports (DNS resolution injected via interface, not a hard `dns` import).

**Dependencies.** Sprints 1–5.

**Test strategy.** Pure-function unit tests (large fixture matrix). Integration tests for the API endpoint. Property-based tests for URL/IP normalization (using `fast-check`).

**Edge cases.** Punycode/Unicode IDN homograph attacks (must canonicalize). IPv6 zone identifiers. Overlapping CIDRs with conflicting allow/deny (deny wins). Time-window edge: assessment running when window expires must trigger deny on *next* action, not retroactively.

---

### Sprint 7 — Queue + `assessment.start` envelope

(Plan §8)

**Goal.** Job queue abstraction with a local adapter, common envelope, and the `assessment.start` flow proven end-to-end (API enqueues, coordinator consumes, scope-validates, dispatches a no-op worker job).

**Deliverables.**
- `packages/queue`:
  - `QueueAdapter` interface: `publish(envelope)`, `subscribe(queueName, handler)`, `ack(envelopeId)`, `nack(envelopeId, reason)`.
  - `LocalQueueAdapter` — file-backed FIFO (one JSON-line file per queue under `./.queue-local/`) safe for single-process dev/test. Atomic writes via `fs.rename`.
  - **Envelope schema** (plan §8): `{ jobId, tenantId, projectId, assessmentId, kind, idempotencyKey, createdAt, notBefore?, attempt, maxAttempts, traceId, payload }`. Zod-validated on publish + on subscribe.
  - Retry classifier: transient (network, timeout, 5xx) → retry with exponential backoff; **terminal** (scope denial, denied tool, invalid RoE, missing approval, destructive unsafe validation) → no retry, audit event, mark job `failed_terminal`.
  - `jobs` table mirror: every publish inserts a row with `pending`; subscribe transitions to `running`; ack→`succeeded`; nack→`failed_transient` or `failed_terminal`. Visible via `GET /api/v1/assessments/:id/jobs`.
- **Coordinator service** scaffolded (`services/coordinator`): subscribes to `assessment.start`. On message: (a) load assessment + scope, (b) call scope-engine for *each declared target*, (c) any deny → terminal failure + audit, (d) success → publish per-target child jobs (Sprint 9 will read these). For Sprint 7, child queue is a no-op `recon.browser.placeholder` consumer that just acks.
- API `POST /assessments/:id/start` enqueues `assessment.start` (state machine transitions `approved → running` only after enqueue succeeds — wrapped in a DB transaction with outbox pattern for at-least-once delivery).

**Files/dirs touched.** `packages/queue` (new), `services/coordinator` (new), `apps/api/src/routes/assessments` (enqueue), `packages/db/migrations` (jobs table — already added Sprint 2 placeholder; finalize columns here).

**Acceptance criteria.**
- Trace context (`traceId`) propagates from API request → queue envelope → coordinator → child job.
- Tenant-context test: a published envelope from tenant T1 is never delivered to a subscriber bound to T2.
- Idempotent commands remain idempotent under duplicate delivery (envelope `idempotencyKey` deduped at consumer via `jobs` table unique constraint).
- Publishing an out-of-scope `assessment.start` payload terminates with `failed_terminal` + audit event; assessment moves to `failed`.
- 80%+ coverage on `packages/queue` and `services/coordinator`.

**Dependencies.** Sprints 1–6.

**Test strategy.** Unit tests for envelope, retry classifier, local adapter (FIFO + crash recovery via reload). Integration test: API enqueues → coordinator consumes → child placeholder acks. Tenant-isolation test on the queue.

**Edge cases.** Adapter crash mid-publish (file half-written) — replay must pick up after restart without duplicates. Concurrent subscribers on the local adapter — exactly-once semantics (file lock). Envelope `notBefore` honoured (job remains pending until clock passes).

---

### Sprint 8 — Fake Decepticon adapter

(Plan §9.1 fallback path)

**Goal.** Deterministic in-process Decepticon stand-in producing a fixed candidate-finding stream from a recorded fixture, so Sprints 9–12 can exercise the full pipeline without a real engine.

**Deliverables.**
- `packages/decepticon-adapter` (new) with two implementations behind a single interface `DecepticonAdapter`:
  - `start(opplan) -> Promise<SessionHandle>`
  - `streamStatus(sessionId) -> AsyncIterable<StatusEvent>`
  - `streamCandidates(sessionId) -> AsyncIterable<CandidateFinding>`
  - `pause | resume | stop(sessionId)`
  - `exportArtifacts(sessionId) -> Promise<Artifact[]>`
- **`FakeDecepticonAdapter`** — reads fixtures from `tests/fixtures/decepticon/<scenario>.json`. The XSS scenario fixture emits one `candidate_finding` of type `xss_reflected` referencing the lab XSS fixture URL (Sprint 9). Status stream emits `started → planning → recon → exploit → reporting → completed` with realistic timing (configurable, default fast).
- **`RealDecepticonAdapter`** — interface-only stub that throws `NotImplemented`. Will be filled in Phase 2 of the broader plan.
- Adapter is selected via env (`DECEPTICON_ADAPTER=fake|real`, default `fake` in this slice).
- Coordinator wires the adapter into `assessment.start` flow: after scope-validation passes, coordinator starts a Decepticon session, multiplexes the candidate stream into `decepticon.findings` queue messages, and persists `decepticon_sessions` rows.
- OPPLAN payload (plan §9.2) — generated minimally: `{assessmentId, targets, authorizedScope, exclusions, testingWindow, allowedTools, unavailableTools, engagementProfile, foothold:false, postExploit:false, c2:false, ad:false}`. Stored as artifact (sha256 + object key) in `assessment_artifacts`.

**Files/dirs touched.** `packages/decepticon-adapter` (new), `services/coordinator/src`, `tests/fixtures/decepticon/`, `packages/db` (decepticon_sessions repo).

**Acceptance criteria.**
- Starting an approved assessment with `DECEPTICON_ADAPTER=fake` produces:
  - One `decepticon_sessions` row, one OPPLAN artifact (with sha256), one `candidate_finding` row.
- The candidate is **never** visible as a confirmed finding (validator gate in Sprint 10 enforces this).
- Status stream is observable via `GET /assessments/:id/timeline`.
- `RealDecepticonAdapter` import path compiles but throws `NotImplemented` at runtime (typed sentinel).
- 80%+ coverage on `packages/decepticon-adapter` and the coordinator wiring.

**Dependencies.** Sprints 1–7.

**Test strategy.** Unit tests for adapter interface + fake fixture playback. Integration test: API start → coordinator → fake adapter → candidate persisted → timeline shows it.

**Edge cases.** Adapter session crash mid-stream (coordinator must mark assessment `failed`, audit, cleanup). OPPLAN payload too large (chunk to object storage, never inline). Two assessments running in parallel — sessions isolated, no cross-talk in fixtures.

---

### Sprint 9 — Browser-worker against lab XSS fixture

(Plan §10 minimal)

**Goal.** Playwright worker that crawls the lab XSS fixture, captures evidence (screenshot, HAR, trace), and persists `observations_browser` rows. Scope-enforced on every navigation.

**Deliverables.**
- `tests/lab/xss-fixture/`: standalone Hono app on `http://localhost:5081`, single endpoint `GET /search?q=<reflected>` with a vulnerable reflected XSS sink (`<div>${q}</div>` rendered raw). Started by `bun run lab:xss` and by integration tests. **Never bundled into production.**
- `services/browser-worker`:
  - Subscribes to `recon.browser` queue (replaces the Sprint 7 placeholder).
  - For each job, launches a Playwright Chromium context, navigates, runs a basic crawl (depth 1 from the start URL), captures: screenshot (PNG), HAR, Playwright trace (`.zip`), DOM snapshot, console messages.
  - Every navigation/request is **first** validated by `scope-engine.decide` — out-of-scope URLs result in a denied audit event, no fetch.
  - Artifacts written to object storage (MinIO local) with `tenant/<tenantId>/assessment/<assessmentId>/...` key prefix; rows in `observations_browser` reference the object key + sha256 + size.
  - Session cookies redacted in HAR before persisting.
- Coordinator (Sprint 8) — when the fake Decepticon adapter emits a `recon_request` for the XSS fixture URL, coordinator publishes a `recon.browser` job. (For first slice we can skip Decepticon→browser plumbing and have coordinator publish the browser job directly on assessment start — record this simplification in `docs/adr/0002-direct-browser-dispatch.md`.)

**Files/dirs touched.** `tests/lab/xss-fixture` (new), `services/browser-worker` (new), `packages/object-storage` (S3 + local FS adapters), `packages/db` (observations_browser repo).

**Acceptance criteria.**
- Authenticated crawl is **not** required for this slice (fixture is anonymous); flow exists and is unit-tested but skipped on the fixture.
- Screenshot, HAR, and trace stored with correct sha256 metadata.
- Browser observation appears in `GET /assessments/:id/timeline`.
- Out-of-scope navigation attempt (e.g. fixture redirects to `https://evil.example/`) is blocked + audited; the browser context aborts the navigation.
- Browser scope enforcement covered by unit + integration tests.
- 80%+ coverage on `services/browser-worker`.

**Dependencies.** Sprints 1–8.

**Test strategy.** Unit tests for scope wiring on the Playwright route handler. Integration test against the lab fixture: launch fixture → start assessment → assert observations + artifacts.

**Edge cases.** Playwright timeout (job retried up to `maxAttempts`, then terminal). Storage write failure (job nacked, transient). Cookie leak in HAR (redaction asserted in test).

---

### Sprint 10 — XSS validator + OOB-less browser replay path

(Plan §13.2 + §13.3)

**Goal.** Deterministic XSS validator that consumes a candidate finding, replays in a fresh browser context, and confirms only when execution proves the candidate. No OOB infra required.

**Deliverables.**
- `packages/validators` shared contract: `Validator.validate(input) -> ValidationResult`. `ValidationResult.status ∈ {confirmed, rejected, inconclusive, needs_human_review, out_of_scope}`. Includes `confidence`, `proofType`, `requestReplayable`, `sideEffectRisk`, `evidenceIds`, `reason`, `validatedAt`.
- `services/validator-worker`:
  - Subscribes to `validate.finding` queue.
  - Loads candidate, enforces scope (deny → `out_of_scope`).
  - Routes to validator by candidate `type`. For Sprint 10, only `xss_reflected` is wired.
- **XSS validator** (`packages/validators/src/xss.ts`):
  - Generates a unique nonce per replay attempt.
  - Launches Playwright, navigates to the candidate URL with the payload, listens for: DOM mutation introducing the nonce-bearing node, `dialog` events (alert), `console` messages tagged with the nonce, network requests originating from the injected script.
  - Confirms when (a) the payload executes in the browser context, (b) execution is tied to the tested sink/parameter (nonce echoes back in DOM/script), and (c) replay is reproducible (run twice, same outcome).
  - Falls back to `inconclusive` if alert intercepted but no DOM nonce match (weak proof).
  - Captures screenshot + trace as evidence; stores in object storage; references via `finding_evidence`.
- Hard rule: confirmed `findings` rows are **only** created via this validator success path. Direct insert is forbidden by the repository (insert path on `findings` requires `validatedBy: ValidationResult` parameter; raw insert helper is removed).
- Coordinator dispatches `validate.finding` after the fake Decepticon emits a candidate (Sprint 8 flow).

**Files/dirs touched.** `packages/validators` (XSS impl + contract), `services/validator-worker` (new), `packages/db` (findings + finding_evidence repos).

**Acceptance criteria.**
- A candidate from the lab XSS fixture is replayed and produces a `confirmed` `findings` row tied to the candidate (`created_from_candidate_id` populated).
- A candidate referencing a non-vulnerable URL is `rejected` (no `findings` row created).
- An out-of-scope candidate yields `out_of_scope` and is not retried.
- Evidence package (screenshot + trace) stored with sha256; viewable via the API.
- 80%+ coverage on `packages/validators` and `services/validator-worker`.

**Dependencies.** Sprints 1–9.

**Test strategy.** Unit tests for validator decision logic (DOM + console + alert combinations). Integration test against the lab fixture: full pipeline from `assessment.start` to confirmed finding. Negative test against a non-vulnerable URL.

**Edge cases.** Browser hangs during replay (timeout → `inconclusive`). Two parallel replays of the same candidate (idempotent: only one `findings` row created — unique constraint on `created_from_candidate_id`). Payload that confirms via alert only (weak fallback → `inconclusive`, not confirmed).

---

### Sprint 11 — Confirmed finding UI

(Plan §14.1 minimal)

**Goal.** React + Vite SPA showing the confirmed finding for an assessment, gated by RBAC, with an evidence viewer and the assessment status timeline.

**Deliverables.**
- `apps/web` (React 19 + Vite 6 + TanStack Router + TanStack Query + Tailwind + shadcn/ui where appropriate).
- Routes:
  - `/login` — email/password + MFA challenge.
  - `/projects` — list, create.
  - `/projects/:id` — project detail with target list and assessment history.
  - `/assessments/:id` — live assessment view: status, timeline (events from coordinator + browser-worker + validator-worker), candidate count, confirmed count, pause/resume/cancel.
  - `/findings/:id` — finding detail: severity, confidence, status, affected asset/endpoint, reproduction, evidence (screenshot + HAR summary + trace link), validation log, status workflow (`open`, `triaged`, `accepted_risk`, `false_positive`, `fixed`, `retested`, `closed`).
  - `/evidence/:id` — evidence viewer (screenshot inline, HAR JSON summary, trace download via signed URL).
- API endpoints added to `apps/api`:
  - `GET /assessments/:id/findings` (confirmed only).
  - `GET /findings/:id`, `PATCH /findings/:id/status`.
  - `GET /evidence/:id` — signed URL or stream from object storage; cross-tenant denied with audit.
- RBAC visibility: `auditor` can read but cannot mutate; `developer` can view assigned findings but cannot change scope/tool policy (asserted in tests). Mutation buttons hidden + server-side enforced.
- Optimistic UI **only** for non-critical metadata (e.g. status notes); all security-relevant actions await server confirmation.

**Files/dirs touched.** `apps/web` (new), `apps/api/src/routes/{findings,evidence}`.

**Acceptance criteria.**
- Confirmed finding from Sprint 10 is visible in UI for the owning tenant; **not** visible from a second tenant's session (asserted in Playwright e2e).
- Status change emits an audit event.
- Cross-tenant artifact access denied with 403 + audit.
- Artifact sha256 displayed in evidence viewer; matches object storage content (asserted in e2e).
- UI tests cover critical workflows (login → projects → assessment → finding) and RBAC visibility (auditor sees no mutate buttons).
- 80%+ coverage on `apps/web` (component + integration tests via Playwright).

**Dependencies.** Sprints 1–10.

**Test strategy.** Component tests for forms and tables. Playwright e2e: login → run assessment → confirmed finding visible → status change audited.

**Edge cases.** Stale finding cache after status change (TanStack Query invalidation). Signed-URL expiry. Long-running assessment timeline rendering (virtualized list).

---

### Sprint 12 — Minimal report builder

(Plan §14.3 minimal)

**Goal.** Report builder produces an immutable `technical pentest report` from confirmed findings only, in HTML and JSON, with an evidence ZIP archive.

**Deliverables.**
- `services/report-builder`:
  - Subscribes to `report.build` queue.
  - Loads assessment, RoE summary, scope, exclusions, testing window, methodology stub, OPPLAN summary (from Sprint 8 artifact), confirmed findings, per-finding evidence, audit metadata.
  - **Scope guard at publication:** every finding's affected target re-validated through `scope-engine.decide`; out-of-scope finding is excluded from report + audited.
  - Renders **HTML** (handlebars or eta template), **JSON** (structured payload), and **ZIP evidence archive** (HTML + screenshots + HAR + traces + JSON). PDF rendering uses Playwright's `page.pdf()` headless on the HTML output (defer separate PDF templating).
  - Report snapshot is **immutable**: `reports` row stores object key + sha256; regeneration creates a new row with a new id, never overwrites.
- API: `POST /assessments/:id/reports` (enqueues build), `GET /reports/:id` (status + signed download URL).
- Report content rules:
  - Confirmed findings only.
  - Secrets redacted (re-uses audit redaction).
  - Artifact hashes shown.
  - Mapping source/confidence omitted in this slice (skill library deferred); columns reserved.
- Russian template, GOST/FSTEC appendices, attack-graph export, retest report — **deferred** (production-readiness phase).

**Files/dirs touched.** `services/report-builder` (new), `packages/reports` (templates + domain models), `apps/api/src/routes/reports`, `packages/db` (reports repo).

**Acceptance criteria.**
- Report generated end-to-end from the Sprint 10 confirmed XSS finding.
- Evidence archive ZIP contains the finding HTML, screenshot, HAR, trace, JSON.
- Report snapshot cannot be mutated; second `POST /assessments/:id/reports` creates a *new* report row with a new sha256.
- Out-of-scope finding (synthetic) is excluded with an audit event.
- 80%+ coverage.

**Dependencies.** Sprints 1–11.

**Test strategy.** Unit tests for template rendering + redaction. Integration test: full pipeline from assessment start → confirmed finding → report generated → ZIP contents verified by sha256.

**Edge cases.** Build failure mid-stream (job nacked transient, retried; partial artifacts garbage-collected). Concurrent build requests for the same assessment (each produces a distinct snapshot, both immutable). Empty confirmed-findings list (report still generated with explicit "no confirmed findings" section).

---

## 3. Cross-Cutting Topics

### 3.1. Data flow — `assessment.start` end-to-end

```
[ User (Security Lead) ]
       │ POST /assessments/:id/start  (Idempotency-Key)
       ▼
[ apps/api ]
       │ assertCan(user, 'start', assessment)
       │ tenantGuard
       │ stateMachine.transition(approved → running)  ← within DB tx (outbox)
       │ auditWriter.append('assessment.start')
       │ queue.publish('assessment.start', envelope)
       ▼
[ services/coordinator ]
       │ envelope.tenantId === actor.tenantId   (queue tenant guard)
       │ scopeEngine.decide(every target)       ← deny → terminal failure
       │ decepticonAdapter.start(opplan)        ← FakeDecepticonAdapter
       │ persist decepticon_sessions row
       │ persist OPPLAN artifact (object storage)
       │ for each recon target:
       │   queue.publish('recon.browser', envelope)
       │
       ├──► [ services/browser-worker ]
       │      │ scopeEngine.decide(every nav)   ← deny → audit
       │      │ Playwright crawl, capture artifacts
       │      │ persist observations_browser
       │      │ store screenshot/HAR/trace in object storage
       │      │ ack
       │
       │ for each candidate from decepticonAdapter.streamCandidates:
       │   persist candidate_findings
       │   queue.publish('validate.finding', envelope)
       │
       └──► [ services/validator-worker ]
              │ scopeEngine.decide(replay target)
              │ XSS validator: Playwright replay with nonce
              │ on confirmed: insert findings (created_from_candidate_id)
              │ persist finding_evidence (screenshot, trace)
              │ ack
       ▼
[ apps/web ]
       │ GET /assessments/:id/findings (confirmed only)
       │ GET /findings/:id, GET /evidence/:id
       ▼
[ User triggers report ]
       │ POST /assessments/:id/reports
       ▼
[ services/report-builder ]
       │ scopeEngine.decide(each finding)       ← exclude out-of-scope
       │ render HTML + JSON + ZIP
       │ persist reports (immutable, sha256)
```

### 3.2. Audit event coverage matrix

| Event                                    | Source                | Sprint |
|------------------------------------------|-----------------------|--------|
| login / logout                           | apps/api              | 3      |
| MFA enable / verify                      | apps/api              | 3      |
| password reset request / confirm         | apps/api              | 3      |
| project create / update / delete         | apps/api              | 5      |
| target create / update / delete / proof  | apps/api              | 5      |
| assessment submit / approve / start /    |                       |        |
|   pause / resume / cancel                | apps/api + coordinator| 5, 7   |
| scope deny (any layer)                   | scope-engine consumer | 6      |
| queue terminal failure                   | coordinator           | 7      |
| Decepticon session start / stop / fail   | coordinator           | 8      |
| browser navigation deny                  | browser-worker        | 9      |
| validator deny / out-of-scope            | validator-worker      | 10     |
| finding status change                    | apps/api              | 11     |
| report build / publish / scope exclusion | report-builder        | 12     |

### 3.3. Configuration matrix (env vars)

| Var                       | Required in          | Notes                                           |
|---------------------------|----------------------|-------------------------------------------------|
| `APP_ENV`                 | always               | `local|dev|staging|production|internal-lab`    |
| `DATABASE_URL`            | non-`local`          | local default = compose Postgres                |
| `OBJECT_STORAGE_*`        | non-`local`          | local default = MinIO compose                   |
| `QUEUE_ADAPTER`           | always               | `local` for slice                               |
| `DECEPTICON_ADAPTER`      | always               | `fake` for slice                                |
| `SESSION_SECRET`          | always               | aborts boot if absent in non-`local`            |
| `SENTRY_DSN`              | optional             | telemetry stub                                  |

### 3.4. Edge cases catalogued across the slice

- IDN homograph in scope rules (Sprint 6).
- IPv6 zone identifier in target rules (Sprint 6).
- Redirect chain crossing scope boundary mid-flight (Sprint 6 + 9).
- Concurrent assessment approval (Sprint 5).
- Idempotency replay across the full chain (Sprint 5 + 7).
- Crash recovery for the local queue adapter (Sprint 7).
- Adapter session crash mid-stream (Sprint 8).
- Cookie leak in HAR (Sprint 9).
- Validator alert-only weak proof (Sprint 10).
- Cross-tenant artifact URL request (Sprint 11).
- Concurrent report builds (Sprint 12).
- Out-of-scope finding at publication time (Sprint 12).

### 3.5. Definitions

- **Candidate finding** — unverified output from any agent/scanner/LLM; lives in `candidate_findings`; never visible as confirmed.
- **Confirmed finding** — produced **only** through a validator's `confirmed` status; lives in `findings` with `created_from_candidate_id`.
- **OPPLAN artifact** — JSON document with operations plan, stored in object storage with sha256 reference in `assessment_artifacts`.
- **Effective scope** — output of `scope-engine.computeEffective(inputs)`; immutable per assessment snapshot.
- **Service actor** — synthetic actor (`coordinator`, `browser-worker`, `validator-worker`, `report-builder`) used in audit events when state changes originate from a service rather than a user.

---

## 4. What is intentionally not in this slice

(See §1.4 for the short list. Expanded reasoning here.)

- **Real Decepticon, real CyberStrike runner, real LLM gateway.** Plan §20 ADRs (Decepticon control surface, CyberStrike verified catalog, LLM model mapping validation) are still open; locking them in before Sprint 12 would destabilise contracts. Fake adapters preserve every interface so swap-in is mechanical in Phase 2.
- **OOB / Interactsh service.** XSS validator does not need OOB; SSRF/file-read/RCE validators do, and they are out of slice.
- **Skill library + framework mappings + tool catalog UI.** No skill or framework data influences a confirmed finding in this slice, so introducing them adds surface area without product benefit.
- **AD, cloud, post-exploit, C2, credential audit.** All require ownership-verified high-impact authorization (plan §2.4). Not in slice.
- **PDF templating beyond `page.pdf()` of the HTML output.** Russian/GOST/FSTEC templates are production-readiness work.
- **Yandex Cloud deploy, K8s manifests, Terraform/Pulumi.** Local Docker Compose only.
- **Frontend marketing surface.** UI is operational console only.

---

## 5. Workflow per sprint (recap)

1. **Generator** drafts `.harness/cyberstrike-hybrid/sprint-N-contract.md` with concrete testable criteria → sends to **Evaluator** for approval.
2. **Generator** implements TDD (RED → GREEN → REFACTOR), keeping files <800 lines and using immutable patterns.
3. **Evaluator** verifies: lint, typecheck, unit tests, integration tests where applicable, plus the **security suite** (tenant isolation, IDOR, scope denial, audit append-only). Earlier sprints' suites must continue to pass.
4. **PASS** → Lead runs `/codex:adversarial-review`, fixes any bugs surfaced, then advances to the next sprint.
5. **FAIL** → up to 3 Generator↔Evaluator iterations, then escalate to Lead.

End of spec.
