# ADR 0002 — Database Driver: Kysely + node-postgres + Kysely's Built-in Migrator

- Status: Accepted
- Date: 2026-04-28
- Deciders: CyberStrike Hybrid harness team (Planner, Generator, Evaluator)
- Sprint: 2
- Related: product-spec.md §1.2 / §2 Sprint 2; plan §4.2; sprint-2-contract.md (R6)

## Context

Sprint 2 introduces the data layer for CyberStrike Hybrid. The platform stores
multi-tenant security-relevant state: tenants, users, sessions, projects,
targets, assessments, scope rules, jobs, candidate findings, confirmed
findings, evidence, audit events, LLM audit events, reports. Every request
that touches state must be tenant-isolated, and several tables are
append-only (`audit_events`, `llm_audit_events`, `finding_evidence`,
`assessment_artifacts`).

The product spec §1.2 mandates Postgres (managed Yandex in production, local
Docker for development). It also names Kysely as the query builder. What it
leaves slightly open is the migrator: §4.2 says
"node-pg-migrate (or kysely's built-in migrator)". That ambiguity must be
resolved before any migration file lands; otherwise the whole migration
suite would need rewriting if the choice changes mid-sprint.

This ADR locks the driver choice and the migrator choice for Sprint 2 and
beyond.

## Decision

CyberStrike Hybrid uses:

- **Kysely** (latest 0.27.x as of Sprint 2) as the type-safe query builder,
  parameterised over a `Database` interface that lists every Postgres table.
- **`pg`** (node-postgres) as the underlying PG driver. Bun ships its own
  `Bun.sql` postgres client, but Kysely's official dialect targets `pg`. We
  prefer the well-trodden combination over a Bun-specific dialect that would
  couple us to Bun's release cadence for query plumbing.
- **Kysely's built-in `Migrator` class** as the migration runner. We do
  **NOT** add `node-pg-migrate`, `postgres-migrations`, or any custom
  SQL-file runner.

The migrator decision (Kysely built-in) is the load-bearing one and is
locked here:

- Each migration is a TypeScript module exporting `up(db: Kysely<any>)` and
  `down(db: Kysely<any>)`.
- The runner uses `FileMigrationProvider` pointed at
  `packages/db/migrations/`. Migration filenames follow the `NNN_name.ts`
  convention so lexical ordering matches semantic ordering.
- The `kysely_migration` and `kysely_migration_lock` bookkeeping tables are
  created automatically by Kysely on first run; we accept this as the
  schema contract.
- Up and down are wrapped in a transaction by Kysely. A migration that
  throws mid-batch rolls back atomically (verified by the broken-migration
  fixture test in `tests/integration/db/migrations-rollback.test.ts`).

## Consequences

**Positive.**

- One fewer dependency than the `node-pg-migrate` route. The toolchain
  surface stays small; the migrator and the query builder are the same
  library, so contributors learn one API.
- Migrations are pure TypeScript — they can import the same `Database`
  interface used by repositories. A change to a column type is visible at
  compile time across the migration plus every repo that touches the table.
- `bun run db:migrate:up` and `bun run db:migrate:rollback` run via Bun's
  TypeScript executor; no compile-emit step.
- Yandex managed Postgres exposes only standard Postgres features. Kysely's
  generic Postgres dialect targets exactly those features. We do not couple
  to a vendor-specific extension.
- The append-only invariant is enforced at the Postgres level via triggers
  written in the migration files themselves. The shared
  `enforce_append_only()` function lives in migration `011_audit_events.ts`
  and is referenced by every later append-only migration.

**Negative / risks.**

- Kysely's migrator does not have first-class support for "data migrations"
  separate from "schema migrations". For Sprint 2 we author DDL only; once a
  data migration is needed (probably Phase 2 production-readiness), we will
  layer a thin convention on top — almost certainly a `data/` subdirectory
  that runs in a separate migration phase. Decision deferred until
  necessary.
- No `pg_dump`-like rollback safety net beyond the per-migration `down()`
  method. The runbook (`docs/runbooks/db-migrations.md`) prescribes that
  every migration must be authored with a tested `down()` and that the
  CI-enforced `db:migrate:check` script (Sprint 2 contract B7) runs the
  up→rollback→up cycle plus a `pg_dump --schema-only` diff to catch
  silent drift.
- Postgres image is pinned by sha256 digest (Sprint 2 contract B7/R4) so
  test runs are deterministic across local and CI. The runbook documents
  the digest-bump procedure.

## Alternatives considered

1. **Drizzle ORM.** Mature TypeScript ORM with a richer migration story
   (auto-generated diffs). Rejected because spec §4.2 explicitly names
   Kysely; switching the query builder would require revisiting the entire
   product-spec data layer. Drizzle's auto-migrations are also a footgun in
   security-critical contexts where every schema change should be a
   reviewed, version-controlled artifact.
2. **Prisma.** Heavier toolchain, code generation step, opinionated runtime
   client, harder to reason about in multi-tenant scenarios where every
   query must carry a tenant guard. Rejected on weight + indirection.
3. **Raw `postgres.js`.** Excellent driver, but no type-safe query builder
   and no migrator. We would still need to layer something on top. Net
   negative versus Kysely + `pg` for this codebase.
4. **`node-pg-migrate`.** A solid migration runner. The reason we did not
   pick it: Kysely's built-in migrator is sufficient for Sprint 2's needs,
   and avoiding a second dependency keeps the install graph smaller. The
   key feature `node-pg-migrate` offers that Kysely's runner does not is a
   richer DSL for SQL-only migrations; we do not need that because we are
   writing migrations in TypeScript with the typed `Database` interface in
   scope.
5. **`postgres-migrations`.** SQL-file based, no TypeScript integration.
   Would force migrations to live outside the type system. Rejected.
6. **Custom SQL-file runner.** Maximum simplicity at the cost of every
   migration being a free-text string. Hard to refactor when a column
   renames. Rejected.
7. **`bun:sqlite` for tests.** Tempting because Bun runs SQLite natively
   and tests would be fast. Rejected because Postgres-specific features
   matter to Sprint 2: Postgres triggers (append-only enforcement), check
   constraints, optimistic-locking semantics, sha256 char(64) regex CHECK,
   UUID generation. Tests must run against Postgres, period. We use
   docker-compose Postgres locally and a GH Actions service container in
   CI (pinned by digest).

## References

- Product spec §1.2 "Architectural decisions", §2 Sprint 2 deliverables.
- Sprint 2 contract §3.5 (this ADR's home), R6 (lock-in requirement).
- Plan §4.2.
- Kysely docs: https://kysely.dev/
- node-postgres docs: https://node-postgres.com/
- Sprint 2 runbook: `docs/runbooks/db-migrations.md`.
