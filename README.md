# CyberStrike Hybrid

Multi-tenant SaaS / private-cloud platform for authorized autonomous pentest
and adversary emulation in owned or explicitly authorized environments.

This repository is the implementation of the spec at
`PROJECT-SPECS-cyberstrike-hybrid.md` (read-only) and the plan at
`.omx/plans/implementation-cyberstrike-hybrid.md` (read-only). The current
sprint state and per-sprint contracts live under `.harness/cyberstrike-hybrid/`.

## Prerequisites

- **Bun** `1.3.11` (pinned in `package.json#packageManager`). Install with
  `curl -fsSL https://bun.sh/install | bash`.
- **Docker** with Docker Compose v2 (used for the local Postgres + MinIO
  stack from Sprint 1 onward).
- **Git**. The repo uses conventional commits; attribution is disabled
  globally per project rules.

To verify the Bun pin matches your local install:

```sh
bun run bun:assert-version
```

## Install

```sh
bun install
```

The command resolves every workspace declared in `package.json#workspaces`
(`apps/*`, `services/*`, `packages/*`).

## Common scripts

| Script              | Purpose                                                  |
|---------------------|----------------------------------------------------------|
| `bun run lint`      | Biome lint + format check across the repo                |
| `bun run lint:fix`  | Biome auto-fix                                           |
| `bun run format`    | Biome format only                                        |
| `bun run typecheck` | `tsc -b` against composite refs in every workspace       |
| `bun test`          | Run all `*.test.ts` suites                               |
| `bun run test:coverage` | Run tests with coverage thresholds (80/80/80/80)     |
| `bun run db:migrate:up`       | Apply all pending DB migrations.                |
| `bun run db:migrate:rollback` | Rollback the latest migration.                  |
| `bun run db:migrate:redo`     | Rollback latest then re-apply.                  |
| `bun run db:migrate:check`    | CI gate: up→pg_dump→rollback→up→diff (B7).      |

## Local stack

```sh
docker compose -f infra/docker/docker-compose.local.yml up -d
```

Brings up:

- **Postgres 16** at `localhost:5433` (user `cs`, password `cs`,
  database `cyberstrike`)
- **MinIO** S3-compatible object store at `localhost:9000` (API) and
  `localhost:9001` (console). Root creds: `cs` / `cs-secret-local-only`.
- **queue-emulator** placeholder — no real adapter until Sprint 7.

Tear down with:

```sh
docker compose -f infra/docker/docker-compose.local.yml down -v
```

## Database

The CyberStrike data layer (`packages/db`) uses Kysely + node-postgres + Kysely's
built-in `Migrator` (see [ADR 0002](./docs/adr/0002-db-driver-kysely-pg.md)).

Apply migrations:

```sh
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:up
```

Rollback the latest migration:

```sh
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:rollback
```

Verify schema determinism (CI gate, Sprint 2 contract B7):

```sh
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:check
```

The check applies all migrations, dumps the schema with
`pg_dump --schema-only --no-owner --no-privileges`, rolls back the latest, re-applies,
dumps again, and exits non-zero if the two dumps differ. This catches enum OID drift,
comment drift, and constraint-ordering drift that a naive up/down comparison would miss.

For migration authoring conventions and the append-only trigger contract, see
[`docs/runbooks/db-migrations.md`](./docs/runbooks/db-migrations.md).

## Repo layout

```
apps/
  api/                       Hono + Bun product API (lands Sprint 3+)
  web/                       React + Vite SPA (lands Sprint 11)
services/
  coordinator/               assessment lifecycle + dispatch (Sprint 7)
  browser-worker/            Playwright browser signal (Sprint 9)
  validator-worker/          deterministic validators (Sprint 10)
  report-builder/            PDF/HTML/JSON + evidence ZIP (Sprint 12)
  http-worker/               scaffold only — out of first slice
  cyberstrike-worker/        scaffold only — out of first slice
  llm-gateway/               scaffold only — out of first slice
packages/
  config/                    typed config loader (zod), fail-fast on missing keys
  contracts/                 zod DTOs, queue envelopes, event schemas
  db/                        kysely migrations + tenant-aware repositories
  authz/                     RBAC matrix, tenant guard, ownership checks
  scope-engine/              normalization + allow/deny decision (pure)
  audit/                     append-only audit writer
  object-storage/            S3-compatible adapter + local FS adapter
  queue/                     queue abstraction + local adapter
  telemetry/                 OTel + Sentry init (stubbed in slice)
  validators/                shared validator primitives
  reports/                   report domain models + templates
  skill-library/             scaffold only — deferred
infra/
  docker/                    docker-compose.local.yml
tests/
  fixtures/                  shared test fixtures (DB, queue, etc.)
  integration/               cross-package integration suites
  e2e/                       Playwright e2e (lands Sprint 11)
  lab/                       vulnerable lab apps (xss-fixture lands Sprint 9)
docs/
  adr/                       architecture decision records
  runbooks/                  operational runbooks
.harness/
  cyberstrike-hybrid/        sprint contracts + product spec (Lead-managed)
.omx/
  plans/                     read-only source plans
```

## ADRs

- [ADR 0001 — Monorepo with Bun workspaces](./docs/adr/0001-monorepo-bun-workspaces.md)

Subsequent ADRs land sprint by sprint as architecture decisions are made.

## Development workflow

CyberStrike Hybrid follows a 3-agent harness (Planner → Generator → Evaluator)
with a per-sprint contract and TDD loop. The active sprint contract is in
`.harness/cyberstrike-hybrid/sprint-N-contract.md`. The hard invariants
governing every sprint live in the product spec §1.1:

1. Scope-first execution. Deny overrides allow. Out-of-scope is never retried.
2. Findings only after deterministic validator success.
3. Browser-first for web assessments.
4. Ownership-verified high-impact tools (C2, post-exploit, AD).
5. Cost caps never block an assessment.
6. Auditability — every security-relevant decision is reconstructible.
