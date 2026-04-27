# Sprint 2 Contract — DB Schema, Migrations, Tenant-Aware Repositories

> Status: REVISED v2 (awaiting evaluator approval)
> Author: Generator
> Reviewer: Evaluator (R1–R9 + 2 optional tightenings folded in)
> Source: product-spec.md §1.1 / §1.5 / §2 Sprint 2; plan §4.2
> Repo root: `/Users/saveliy/Documents/пентест ИИ`
> Sprint 1 baseline: commits `c6ce978` (sprint 1) + `1cfe910` (codex fixes)

## Revision log

- **v2** (current): folded evaluator R1–R9 + 2 optionals.
  - R1: `TenantContextMismatchError` + B17b precedence rule (explicit arg always wins; mismatch throws).
  - R2: B19b cross-tenant attempt audit hook (`onCrossTenantAttempt`).
  - R3: trigger covers TRUNCATE; new B14b. Trigger emits `TG_TABLE_NAME` + `TG_OP` in exception (optional accepted).
  - R4: B7 uses `pg_dump --schema-only` diff; postgres image pinned by digest in both compose + CI.
  - R5: B25 grep guard extended to `path.dirname(import.meta.url)` and bare `__dirname`.
  - R6: ADR 0002 §Decision locks Kysely's built-in migrator before code lands.
  - R7: B23 JSONB `COMMENT ON COLUMN` paper trail accepted.
  - R8: B18b — list/count/aggregate cross-tenant tests added.
  - R9: `schema-tsd.test.ts` uses strict `never` assignment pattern; runtime probe (B15b) preserved as second layer.
  - Optional accepted: deliberately-broken migration fixture concrete spec in §6.
- v1: initial proposal.

---

## 1. Goal

Stand up the Postgres schema, kysely-based query layer, append-only-aware repositories, and a CI-enforced migration check. The schema must satisfy the spec's tenant-isolation, append-only, and audit invariants from day one. No HTTP routes, no auth, no business logic — only data layer + tests.

## 2. Carry-forwards from Sprint 1 (durable decisions)

These were flagged by evaluator at Sprint 1 PASS and the codex-fixes PASS. I'm encoding them here so they survive into Sprint 2 implementation:

- **(C1) Cumulative test set.** §11.2 of the Sprint 1 contract said: "Sprint 1 is the baseline; from Sprint 2 onward every PASS must run all prior sprint suites." Sprint 2 verification §5 explicitly enumerates the cumulative test set (Sprint 1 + Sprint 2). CI's `unit-tests-root` job already runs `bun test` from the repo root and therefore will pick up the new Sprint 2 suites automatically.
- **(C2) Per-workspace coverage gates.** With real code landing in `packages/db`, the global aggregate threshold is no longer a sufficient safety net. Sprint 2 introduces the **per-workspace coverage gate** as a wrapper around the existing `scripts/coverage-gate-lib.ts` (see §2.3 below). Every package with real code from now on declares its own gate.
- **(C3) F2 statement-aliases-line decision is durable.** The decision lives in three places already: the comment block at the top of `scripts/coverage-gate.ts`, the `bunfig.toml` header comment, and now this contract §1.5 sub-bullet for visibility. A future Bun version emitting JSON statement coverage will let us swap source without breaking the API.
- **(C4) Cyrillic path / `fileURLToPath` rule.** Any new path-handling script in Sprint 2 (migration runner, fixture loader, testcontainers wiring) MUST use `fileURLToPath(new URL(...))` rather than `URL.pathname` directly. Encoded as a sentinel test in §4.7.
- **(C5) gitnexus is indexed.** I will use `mcp__gitnexus__impact` before editing any existing `packages/config` or workspace tsconfig file to confirm blast radius.

### 2.1. Sprint 1 commit baseline

CI must run all Sprint 1 suites unchanged. The Sprint 2 verification command sequence (§5) re-runs them and asserts no regression. Commit hashes for reference: `c6ce978` (baseline), `1cfe910` (codex fixes).

### 2.2. F2 statement-aliases-line — restated for durability (C3)

LCOV's `DA` records (and `LF`/`LH` totals) are the statement-level execution markers. V8/c8 derive their "statement" coverage from the same instrumentation. We therefore alias `statement = line` in the gate. Comment block lives at the top of `scripts/coverage-gate.ts`. If Bun adds a `--coverage-reporter=json` exposing a separate statement count, the lib's `aggregateRatios` function gets a new branch; tests already cover the aliasing.

### 2.3. Per-workspace coverage gate (new)

`scripts/coverage-gate.ts` currently aggregates all files in `coverage/lcov.info`. Sprint 2 adds a flag:

```sh
bun scripts/coverage-gate.ts --threshold=0.80 --workspace=packages/db
```

When `--workspace=` is set, the gate filters lcov records by `SF:` path prefix and only considers files under that workspace. Each package can therefore independently fail the gate. Tests in §4 below.

---

## 3. Scope (files / dirs to be created or modified)

### 3.1. New code

```
packages/db/
  package.json                      kysely + pg deps; migrator = Kysely's built-in (see ADR 0002)
  tsconfig.json                     existing (unchanged)
  src/
    index.ts                        public exports (overrides Sprint 1 placeholder)
    name.ts                         re-exports `name = 'packages/db'` per A18 (preserve Sprint 1 invariant)
    errors.ts                       MissingTenantContextError, OptimisticLockError, AppendOnlyViolationError
    schema.ts                       kysely Database type + table interfaces
    db.ts                           createDatabase(config) factory
    tenant-context.ts               runInTenant + assertTenantContext
    repos/
      append-only.ts                AppendOnlyRepository<T> generic insert-only base
      mutable.ts                    MutableRepository<T> generic with optimistic version
      tenant.repository.ts          tenants (platform-level, no tenant_id column)
      user.repository.ts
      session.repository.ts         user_sessions
      mfa.repository.ts             mfa_secrets
      project.repository.ts
      target.repository.ts
      assessment.repository.ts
      scope-rule.repository.ts      assessment_scope_rules
      job.repository.ts
      decepticon-session.repository.ts
      observation-browser.repository.ts
      candidate-finding.repository.ts
      finding.repository.ts
      report.repository.ts
      audit.repository.ts           audit_events (append-only)
      llm-audit.repository.ts       llm_audit_events (append-only)
      assessment-artifact.repository.ts  (append-only)
      finding-evidence.repository.ts     (append-only)
    types.ts                        DTO zod schemas (re-exports from packages/contracts where applicable)
  migrations/
    001_tenants.ts
    002_users_sessions_mfa.ts
    003_projects_targets.ts
    004_assessments_scope_rules.ts
    005_assessment_artifacts.ts     (append-only)
    006_jobs.ts
    007_decepticon_sessions.ts
    008_observations_browser.ts
    009_candidate_findings.ts
    010_findings_evidence.ts        findings + finding_evidence (append-only)
    011_audit_events.ts             audit_events (append-only) + trigger
    012_llm_audit_events.ts         llm_audit_events (append-only) + trigger
    013_reports.ts
  scripts/
    migrate.ts                       run all pending migrations
    rollback.ts                      rollback latest
    redo.ts                          rollback then re-apply (CI determinism check)
```

### 3.2. Tests

```
packages/db/src/
  tenant-context.test.ts
  repos/append-only.test.ts
  repos/mutable.test.ts
  errors.test.ts

tests/integration/db/
  migrations.test.ts                up / down / redo against ephemeral PG
  tenant-isolation.test.ts          cross-tenant queries return [] / throw
  append-only.test.ts               compile-time + runtime guard
  optimistic-lock.test.ts           version conflict rejected
  schema-shape.test.ts              every table has tenant_id (or is platform-level), created_at, etc.
  schema-tsd.test.ts                tsd-style type assertions: AuditEventRepo has no `update`/`delete`
```

### 3.3. Infra

- `infra/docker/docker-compose.local.yml` already runs `cs-postgres` on port 5433 — unchanged, but Sprint 2 tests connect to it (via env or `.env.test`).
- New file `infra/docker/docker-compose.ci.yml` — minimal Postgres-only compose for CI. Distinguishes the test PG from the dev PG so CI doesn't depend on the dev MinIO.

### 3.4. CI updates

- Promote `migration-check` from placeholder echo to a real job: spin up Postgres in a service container, run `bun run db:migrate:check` (which applies all migrations to empty DB, then rolls back the latest, then re-applies — proving determinism + reversibility).
- Add new job `integration-tests` running tests in `tests/integration/db/` against the same PG service container.
- Wire per-workspace coverage gate into the `unit-tests` matrix: each matrix entry now runs `bun scripts/coverage-gate.ts --threshold=0.80 --workspace=<ws>` after its tests.

### 3.5. Documentation

- ADR `docs/adr/0002-db-driver-kysely-pg.md` — captures the Kysely + `pg` choice **AND locks the migrator decision** (R6): Kysely's built-in `Migrator` class, NOT `node-pg-migrate`, NOT `postgres-migrations`, NOT raw SQL files + custom runner. §Decision section states this explicitly with rationale (one fewer dep, integrates with the typed `Database` interface, allowed by spec §4.2). Alternatives considered (Drizzle, Prisma, raw `postgres.js`, `node-pg-migrate`, `postgres-migrations`, `bun:sqlite` for tests) are documented in §Alternatives so future contributors don't re-litigate. Decision is locked **before any migration file lands** — the ADR is part of the Sprint 2 commit, not a follow-up.
- Update `README.md` with a "Database" section: how to run migrations, how to point tests at a different PG, how the migration-check loop works.
- New `docs/runbooks/db-migrations.md` (~80 lines): how to author a new migration, how the up/down contract works, the determinism rule (no `now()` baked into a migration; use deterministic seeds), append-only trigger pattern.

### 3.6. Out of scope (deferred to later sprints)

- HTTP routes (Sprint 3+).
- Auth bcrypt + sessions (Sprint 3, uses these tables).
- RBAC matrix (Sprint 3).
- Real audit middleware (Sprint 4 wires repositories into Hono routes).
- Scope-engine, queue, decepticon adapter — Sprints 6–8.
- `observations_http`, `observations_cyberstrike`, `observations_decepticon`, `oob_events`, `skill_library`, `framework_mappings`, `tool_catalog` — explicitly deferred per spec §2 Sprint 2 "Deferred" bullet.

---

## 4. Acceptance Criteria (testable, binary)

Identifiers continue from Sprint 1 (which ended at A27 + A14a/A14b). Sprint 2 acceptance criteria are B1–B30.

### 4.1. Driver, types, factory

- [ ] **B1:** `packages/db` declares `kysely` and `pg` deps + dev-only `@types/pg` in its `package.json`. Migrator is Kysely's built-in `Migrator` class — NO `node-pg-migrate` dependency (locked in ADR 0002, R6). No global root install.
- [ ] **B2:** `createDatabase(config)` returns a typed `Kysely<Database>` instance using a connection pool. Closes cleanly via `db.destroy()`.
- [ ] **B3:** `Database` type lists every Sprint 2 table; tsd-style test asserts the type contains all 17 expected table keys (see §3.1).
- [ ] **B4:** `packages/db/src/index.ts` exports `name = 'packages/db'` (preserve Sprint 1 A18 / R9 invariant). Aggregator test in `tests/integration/workspace-names.test.ts` continues to pass.

### 4.2. Migrations apply, roll back, redo

- [ ] **B5:** `bun run db:migrate:up` applies every migration to an empty DB without error.
- [ ] **B6:** `bun run db:migrate:rollback` rolls back the latest migration; running it 13 times rolls back to empty schema.
- [ ] **B7 (R4 rewrite — concrete schema-equivalence + digest pin):** `bun run db:migrate:check` (CI script) does:
  ```bash
  bun run db:migrate:up
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > /tmp/schema.before.sql
  bun run db:migrate:rollback
  bun run db:migrate:up
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > /tmp/schema.after.sql
  diff /tmp/schema.before.sql /tmp/schema.after.sql   # exit 0 required
  ```
  This catches enum OID drift, comment drift, constraint-ordering drift that a naive up/down comparison misses. **Postgres image pinned by SHA256 digest** in both `infra/docker/docker-compose.local.yml` AND the CI workflow `services:` block — `postgres:16-alpine@sha256:<digest>`. Documented in `docs/runbooks/db-migrations.md` how to bump the digest when refreshing the base image.
- [ ] **B8:** Migration files contain no `now()` / `gen_random_uuid()` baked into structural DDL — only as DEFAULT clauses (where the value is computed at row-insert time, not migration-apply time). Verified by a grep test in `tests/integration/db/migrations.test.ts`.

### 4.3. Schema shape (every tenant-owned table)

For each table EXCEPT `tenants` (platform-level — see B12):

- [ ] **B9:** Has `tenant_id UUID NOT NULL`.
- [ ] **B10:** Has `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
- [ ] **B11:** Has `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` UNLESS the table is append-only (see §4.4). Append-only tables have no `updated_at`.
- [ ] **B11b:** Has an index `(tenant_id, ...)` — at minimum `(tenant_id)` so per-tenant scans never table-scan.
- [ ] **B11c:** Every unique constraint is scoped by `tenant_id` (e.g. `UNIQUE (tenant_id, name)` not `UNIQUE (name)`).
- [ ] **B12:** `tenants` itself has `id UUID PRIMARY KEY`, `created_at`, `updated_at`, but NO `tenant_id` (it IS the tenant). Documented inline.

Verified by `tests/integration/db/schema-shape.test.ts` — queries `information_schema.columns` and `information_schema.table_constraints` and asserts every table from §3.1 satisfies the rules.

### 4.4. Append-only enforcement

- [ ] **B13:** Tables `audit_events`, `llm_audit_events`, `finding_evidence`, `assessment_artifacts` have NO `updated_at` column.
- [ ] **B14 (R3 rewrite):** Each append-only table is guarded by TWO triggers calling a single shared function `enforce_append_only()`:
  - `<table>_no_update_delete` — `BEFORE UPDATE OR DELETE ON <table> FOR EACH ROW`.
  - `<table>_no_truncate` — `BEFORE TRUNCATE ON <table> FOR EACH STATEMENT` (TRUNCATE fires per-statement, not per-row, so it needs its own trigger).
  Function body raises `EXCEPTION 'append-only table %s: % rejected', TG_TABLE_NAME, TG_OP` so logs identify both the table and the offending operation. Verified by integration test that runs `UPDATE audit_events SET action='x'`, `DELETE FROM audit_events`, and asserts each fails with a message containing `append-only table audit_events: UPDATE` / `: DELETE`.
- [ ] **B14b (R3 new — TRUNCATE):** Raw `TRUNCATE audit_events` MUST fail with the same exception, message containing `audit_events: TRUNCATE`. Same coverage for the other 3 append-only tables (`llm_audit_events`, `finding_evidence`, `assessment_artifacts`).
- [ ] **B15 (R9 rewrite — strict `never` + dual-layer):** The repository class for each append-only table (`AuditRepository` etc.) extends `AppendOnlyRepository<T>` which exposes only `insert(...)` and `findBy*(...)`. **No `update`, no `delete`, no `upsert` methods exist.** Verified by TWO independent layers (both required):
  - **B15a (compile-time, strict-match):** `tests/integration/db/schema-tsd.test.ts` uses the strict pattern (R9):
    ```typescript
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .update
    const _no_update: never = auditRepo.update;
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .delete
    const _no_delete: never = auditRepo.delete;
    // Same pattern for upsert, replaceWhere, deleteWhere.
    ```
    The `: never` annotation tightens the assertion: if `update` is silently re-added with any non-`never` type, the line type-errors twice (`@ts-expect-error` consumes one), and the test fails. If `update` is correctly absent, the access yields `undefined`/property-missing error which `@ts-expect-error` catches. CI's `typecheck` job is the gate.
  - **B15b (runtime probe — second layer per R9):** A unit test asserts `Object.getOwnPropertyNames(Object.getPrototypeOf(auditRepo))` excludes `'update'`, `'delete'`, `'upsert'`. This catches a regression where someone injects a method via prototype mutation at runtime (which the compile-time check can't see).

### 4.5. Tenant context

- [ ] **B16:** `packages/db/src/tenant-context.ts` exports `runInTenant(tenantId: string, fn)` — sets `tenantId` on AsyncLocalStorage, runs `fn`, clears.
- [ ] **B17 (R1 rewrite — precedence rule):** Every tenant-scoped repository method requires `tenantId` either explicitly (first arg) OR through `runInTenant` context. Precedence: **explicit arg always wins**. If neither is present, throws `MissingTenantContextError`. If both are present and they DIFFER, throws `TenantContextMismatchError` (caller has a bug — the repository must not silently choose). Documented inline in `tenant-context.ts`.
- [ ] **B17b (R1 new — mismatch test):** `tests/integration/db/tenant-isolation.test.ts` includes:
  - `runInTenant(T2, () => repo.findById(T1, id))` → throws `TenantContextMismatchError` with `{explicit: T1, ambient: T2}` payload.
  - `runInTenant(T1, () => repo.findById(T1, id))` (matching) → succeeds.
  - `runInTenant(T1, () => repo.findById(undefined, id))` (ambient only) → succeeds, uses T1.
  - `repo.findById(T1, id)` (explicit only, no ambient) → succeeds, uses T1.
  - `repo.findById(undefined, id)` (neither) → throws `MissingTenantContextError`.
- [ ] **B18:** Cross-tenant query test: insert two rows with different `tenant_id` values; a `findById(rowFromT1.id)` called inside `runInTenant(T2, ...)` returns `null` (not the row). Verified at integration level.
- [ ] **B18b (R8 new — full query-shape coverage):** Tenant isolation must hold across every query shape, not just `findById`. Tests assert from inside `runInTenant(T2, ...)`:
  - `findAll()` returns ONLY rows where `tenant_id = T2`; no T1 rows ever appear.
  - `count()` returns the count of T2 rows only (insert 3 T1 rows + 2 T2 rows; expect `count() === 2`).
  - `findWhere({status: 'x'})` filters within T2 only.
  - Any aggregate currently exposed (`sum`, `avg`, `max`) — same property. (No aggregates in Sprint 2 yet, but the helper test pattern is in place so when they land in Sprint 5+ this isolation guarantee carries.)
  - `update(id, data)` (mutable repo) where `id` belongs to T1 affects 0 rows from T2 context (already covered by B19).
  This is the explicit "tenant isolation tests" deliverable from spec §1.5; without it, Sprint 2 PASS doesn't actually prove isolation across query types.
- [ ] **B19:** Cross-tenant `update` attempt: `update(rowFromT1.id, ...)` called inside `runInTenant(T2, ...)` updates 0 rows (does NOT throw, returns `{updated: 0}`). The repository must not silently update across tenants. The 0-row return is the correct shape — no error differentiation that could leak existence of cross-tenant rows.
- [ ] **B19b (R2 new — auditability hook):** Per plan §2.6, every security-relevant decision must be reconstructible. When the repository's pre-update SELECT-by-id finds a row whose `tenant_id` doesn't match the active context, the repository MUST invoke an injected `onCrossTenantAttempt?: (event: CrossTenantAttempt) => void` hook (set via constructor option or `setCrossTenantHook(fn)`). Event payload:
  ```typescript
  {
    actorTenantId: string;     // active context (T2 in the test)
    rowTenantId: string;       // T1 — the row's actual owner
    resourceType: string;      // 'project' | 'target' | etc.
    resourceId: string;
    operation: 'find' | 'update' | 'delete';
    occurredAt: Date;
  }
  ```
  Test asserts the hook fires with the correct payload on cross-tenant find AND cross-tenant update. Sprint 4 wires this hook to `denyAudit` in `packages/audit`; Sprint 2 just defines + tests the contract.

### 4.6. Optimistic locking

- [ ] **B20:** `assessments`, `targets`, `assessment_scope_rules` each have a `version INTEGER NOT NULL DEFAULT 1` column.
- [ ] **B21:** `MutableRepository.update(id, data, expectedVersion)` increments `version` only when `expectedVersion` matches. On mismatch, throws `OptimisticLockError`. Test: two concurrent updates from version=1 — first succeeds (becomes version=2), second fails with `OptimisticLockError`.
- [ ] **B22:** Optimistic version is enforced at SQL level: `UPDATE ... SET version = version + 1 WHERE id = $1 AND tenant_id = $2 AND version = $3`. Confirmed by the row-count check after the UPDATE.

### 4.7. Object-storage references (no inline blobs)

- [ ] **B23 (R7 augment):** Tables `assessment_artifacts`, `finding_evidence`, `decepticon_sessions.opplan_*`, `observations_browser.*` (where applicable), `reports` use `(object_storage_key TEXT NOT NULL, sha256 CHAR(64) NOT NULL, size_bytes BIGINT NOT NULL)` for any blob-like data. No `BYTEA`. Migration test asserts no `BYTEA` columns exist anywhere in the schema.
- [ ] **B23b (R7 — JSONB paper trail):** "No `JSONB > 64 KiB`" cannot be enforced statically until rows exist, so we enforce a paper-trail proxy: every `JSONB` column MUST have a `COMMENT ON COLUMN <tbl>.<col> IS 'purpose=<...>; expected_size_bytes=<n>; if_larger=<object_storage_key path>'`. Migration test enumerates JSONB columns via `information_schema.columns` and asserts each has a matching `pg_description` row whose comment matches the regex `purpose=.+; expected_size_bytes=\d+`. Soft enforcement, durable paper trail.
- [ ] **B24:** sha256 column is `CHAR(64)` (hex-string, lowercase) — `CHECK (sha256 ~ '^[a-f0-9]{64}$')` constraint enforced; migration test inserts `'X'.repeat(64)` and asserts CHECK violation.

### 4.8. Cyrillic path / `fileURLToPath` (C4)

- [ ] **B25 (R5 rewrite — three footguns guarded):** Every new path-handling script under `packages/db/`, `tests/integration/db/`, and `scripts/` uses `import { fileURLToPath } from 'node:url'; const here = fileURLToPath(new URL('.', import.meta.url));` and **NEVER** any of:
  - `new URL('.', import.meta.url).pathname` — percent-encodes cyrillic, original Sprint 1 bug.
  - `path.dirname(import.meta.url)` — keeps the `file://` scheme prefix; resulting path is wrong.
  - bare `__dirname` in `.ts` files — CommonJS shim, undefined under Bun's ESM.

  Verified by a strengthened grep guard:
  ```sh
  ! grep -RIn -E "(import\.meta\.url\)?\.pathname|path\.dirname\(import\.meta\.url|^.*\b__dirname\b)" \
    packages/db/ tests/integration/db/ scripts/ --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist
  ```
  exits 0 (no hits). Test wrapper runs this in `tests/integration/db/path-footguns.test.ts` so violations fail `bun test` not just CI grep.

### 4.9. Per-workspace coverage gate (C2)

- [ ] **B26:** `scripts/coverage-gate-lib.ts` gains an optional `workspaceFilter?: string` parameter on `evaluateGate` and `aggregateRatios`. When set, only files whose `SF:` path starts with that prefix are aggregated. Pure function, fully unit-tested.
- [ ] **B27:** New tests in `scripts/coverage-gate-lib.test.ts` (extending the Sprint 1 file): given two records — one in `packages/config` at 100%, one in `packages/db` at 60% — with `workspaceFilter = 'packages/db'` and threshold 0.80, gate fails on `line` and `statement`; with `workspaceFilter = 'packages/config'`, gate passes.
- [ ] **B28:** `scripts/coverage-gate.ts` accepts `--workspace=<dir>` flag, plumbs through to the lib, includes the workspace filter in its `console.warn` line.
- [ ] **B29:** CI matrix in `.github/workflows/ci.yml` `unit-tests` job runs `bun scripts/coverage-gate.ts --threshold=0.80 --workspace=${{ matrix.workspace }}` after each matrix entry's tests. Matrix expands from `[packages/config]` to `[packages/config, packages/db]`.

### 4.10. Cumulative regression (C1)

- [ ] **B30 (N3 clarified):** `bun test` from root continues to run all Sprint 1 suites PLUS the new Sprint 2 suites. **No Sprint 1 test regresses (zero failures); the Sprint 1 baseline counts (62/0/173 at v2) are a floor, not an exact match — adding new tests to existing Sprint 1 packages is fine and does not constitute a regression.** Verified by: zero failures in Sprint 1 paths AND Sprint 1 test files all still discovered. CI's `unit-tests-root` job already runs this.

---

## 5. Verification commands (single source of truth, cumulative)

The evaluator runs, in order. Sprint 1 commands are repeated explicitly per §11.2 of the Sprint 1 contract.

### 5.1. Sprint 1 baseline regression

```bash
# From repo root.
bun run bun:assert-version
bun run lint
bun run typecheck
bun test --coverage
bun run coverage:gate                                      # global aggregate ≥ 80%
bun scripts/coverage-gate.ts --threshold=1.00              # MUST exit 1 (Sprint 1 A11 probe)
bun scripts/coverage-gate.ts --threshold=0.80 --workspace=packages/config   # NEW: per-workspace gate, exit 0
diff <(docker compose -f infra/docker/docker-compose.local.yml config --services | sort) \
     <(printf 'cs-minio\ncs-postgres\ncs-queue-emulator\n')
git diff --exit-code -- bun.lock                           # lockfile invariant
```

### 5.2. Sprint 2 new

```bash
# Bring up CI-style PG (or reuse the dev one).
docker compose -f infra/docker/docker-compose.local.yml up -d cs-postgres
# Wait for healthy via the deterministic loop (same shape as Sprint 1 §5).

# Migrations.
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:check
# Expected: applies all migrations, rolls back latest, re-applies. Exits 0.

# Per-workspace coverage gate for new package.
bun test --coverage packages/db
bun scripts/coverage-gate.ts --threshold=0.80 --workspace=packages/db

# Integration tests.
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/db

# Cumulative root suite.
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test
# Expected: all Sprint 1 suites (62 tests) + new Sprint 2 suites (estimate 80–120 new) all pass.

# Cyrillic-path / fileURLToPath rule (B25 — three footguns).
! grep -RIn -E "(import\.meta\.url\)?\.pathname|path\.dirname\(import\.meta\.url|^.*\b__dirname\b)" \
  packages/db/ tests/integration/db/ scripts/ --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist

# Append-only runtime guard probe.
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun -e "
  const { createDatabase } = require('./packages/db/src/index.ts');
  const db = createDatabase({ url: process.env.DATABASE_URL });
  await db.executeQuery({ sql: \"INSERT INTO audit_events (id, tenant_id, action, resource_type, occurred_at) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'test', 'test', now())\", parameters: [] });
  try {
    await db.executeQuery({ sql: \"UPDATE audit_events SET action = 'tampered'\", parameters: [] });
    process.exit(2);  // should NOT reach here
  } catch (e) {
    if (!String(e.message).includes('append-only')) process.exit(3);
  }
  await db.destroy();
"
```

All commands exit 0 (or, for explicitly negated checks, satisfy the documented inverse).

---

## 6. Edge cases covered

- **Cross-tenant read** — returns 0 rows (B18).
- **Cross-tenant update** — affects 0 rows, no throw (B19).
- **Concurrent updates with same version** — second fails with `OptimisticLockError` (B21).
- **Append-only update via raw SQL** — Postgres trigger raises (B14).
- **Append-only update via TS API** — method does not exist; tsd assertion proves it (B15a).
- **Migration applied twice** — `db:migrate:check` redo step proves determinism (B7).
- **Migration mid-batch failure** — single migration is wrapped in a transaction; partial apply rolls back. Concrete fixture: `tests/fixtures/migrations/broken/_001_partial_then_throw.ts` runs:
  ```typescript
  await db.schema.createTable('broken_table').addColumn('x', 'text').execute();
  throw new Error('intentional break for fixture test');
  ```
  Test in `tests/integration/db/migrations-rollback.test.ts` invokes the migrator with this fixture, asserts (a) the error propagates, (b) `broken_table` does NOT exist in `information_schema.tables` (transaction rolled back), (c) the migrations bookkeeping table records the migration as failed/not-applied. Cleanup teardown drops the test schema regardless.
- **Inline blob smuggling** — schema-shape test asserts no `BYTEA` columns (B23).
- **Non-hex sha256** — CHECK constraint rejects (B24).
- **Cyrillic path script bug** — grep guard (B25).

---

## 7. TDD plan

Per package:

1. **RED** — author `tenant-context.test.ts`, `errors.test.ts`, `repos/append-only.test.ts`, `repos/mutable.test.ts` first. They reference symbols that do not exist yet → `bun typecheck` fails → tests fail.
2. **GREEN** — implement minimal `MissingTenantContextError`, `AppendOnlyViolationError`, `OptimisticLockError`, the two repository base classes, and the AsyncLocalStorage-based `tenant-context.ts`. Make the unit tests pass without a running DB (they only exercise type errors and runtime guards on stubbed Kysely instances).
3. **GREEN-INTEGRATION** — write `migrations/001_tenants.ts` etc. one at a time. After each migration, the corresponding repo test against the live PG runs and passes before moving to the next migration.
4. **REFACTOR** — no file >400 lines. Migration files can be small and similar; common helpers go into `packages/db/migrations/_common.ts`.

## 8. File-size budget

Each migration ~50–100 lines (DDL + comment block). Each repository ~80–150 lines. Append-only base ~80 lines. Mutable base ~120 lines. Schema type file is large (one interface per table ~400 lines total) — split if it crosses 600 lines, but keeping all table types in one place aids type discovery; the spec budget allows up to 800.

## 9. Non-deliverables (explicit deferrals)

- **Drizzle / Prisma / `postgres.js`** evaluated in ADR 0002 but not chosen — Kysely is mandated by spec §4.2.
- **Encrypted columns / row-level security (RLS)** — RLS is a follow-up; tenant guard is enforced at repository level for now.
- **Connection-string vault retrieval** — `DATABASE_URL` is plain env (validated by `packages/config` in non-`local`).
- **Materialized views, partitioning, `pg_stat_statements`** — perf optimisations deferred until real workload appears (probably Phase 2).
- **`observations_http`, `observations_cyberstrike`, `observations_decepticon`, `oob_events`, `skill_library`, `framework_mappings`, `tool_catalog`** — explicit spec §2 Sprint 2 "Deferred" entries; no migrations in this slice.
- **CI gitleaks / trufflehog** — still deferred (Sprint 1 §9 R3 carry-over).

## 10. Risks / open questions (RESOLVED in v2)

All previously-open questions are now resolved per evaluator's review:

1. **Kysely's built-in migrator: APPROVED.** ADR 0002 §Decision locks this before code lands (R6).
2. **Tenant context hybrid: APPROVED.** Precedence rule encoded in B17 (R1): explicit arg always wins; mismatch throws `TenantContextMismatchError`; B17b tests cover all 5 combinations.
3. **Single generic `enforce_append_only()` trigger: APPROVED** with the requirement that the EXCEPTION includes `TG_TABLE_NAME` AND `TG_OP` for debuggability (R3 / B14).
4. **PG service container in GH Actions: APPROVED**, image **pinned by sha256 digest** in both compose + CI (R4).
5. **`@ts-expect-error` + strict `never` assignment: APPROVED.** Pattern is `const _no_update: never = repo.update;` so a regression that re-adds the method with any non-`never` type still trips the gate (R9). Runtime probe (B15b) preserved as second layer.
6. **`statement` aliasing — confirmed durable, no further action.** Codified in §2.2 + comment blocks in `coverage-gate.ts` and `bunfig.toml`.

---

## 11. Commit hygiene + regression guard

### 11.1. Commit hygiene

Conventional commits only (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`). No `Co-Authored-By:`, no "Generated with Claude Code". Lead handles git per Sprint 1 §11.1.

### 11.2. Regression guard (cumulative test set)

Per Sprint 1 §11.2: Sprint 1 is the baseline. Sprint 2's PASS verdict requires:

- All Sprint 1 unit/integration tests still pass without regression (zero failures); baseline counts (62/0/173) are a floor — adding tests is fine.
- All new Sprint 2 unit tests pass (estimate 40+).
- All new Sprint 2 integration tests pass against ephemeral PG (estimate 30+).
- Per-workspace coverage gate green for both `packages/config` and `packages/db`.
- `git diff --exit-code -- bun.lock` after `bun install --frozen-lockfile`.

Sprint 3+ contracts must continue this pattern.

---

End of contract proposal v1. Awaiting evaluator approval or revision requests.
