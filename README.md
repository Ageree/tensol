# CyberStrike Hybrid

Multi-tenant SaaS / private-cloud platform for authorized autonomous pentest
and adversary emulation in owned or explicitly authorized environments.

## Current product context

Read [`docs/project-current-context.md`](./docs/project-current-context.md)
before relying on older specs. The product has pivoted from Russia-first
packaging to an international security SaaS; YooKassa/RUB/RU-first assumptions
are legacy unless a task explicitly says otherwise.

## Quick start for new contributors

The canonical setup doc for the current product (Blackbox MVP) is:

> **[`specs/002-blackbox-mvp/quickstart.md`](./specs/002-blackbox-mvp/quickstart.md)**

It covers repo bootstrap, env vars, DB migrations, running the
`server` / `apps/site` / `vps-agent` stack in tmux, happy-path smoke,
and the per-push / nightly / E2E test suites.

The rest of this README documents the 001-backend-v2 era (Postgres +
multi-service) and is being phased out as 002-blackbox-mvp lands; treat
it as historical context until this notice is removed.

---

This repository is the implementation of the spec at
`PROJECT-SPECS-cyberstrike-hybrid.md` (read-only). The current sprint state and
per-sprint contracts live under `.harness/cyberstrike-hybrid/`.

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

## Decepticon engine (real adapter)

Sprint 12 wires `RealDecepticonAdapter` to the upstream
[PurpleAILAB/Decepticon](https://github.com/PurpleAILAB/Decepticon)
LangGraph platform. Decepticon ships its own Docker Compose stack with
two isolated networks (management + sandbox) — we only talk to its
LangGraph HTTP endpoint at `localhost:2024`.

The repo lives under `external/decepticon/` (gitignored, cloned via
`git clone`):

```sh
mkdir -p external && cd external
git clone --depth 1 https://github.com/PurpleAILAB/Decepticon.git decepticon
```

Run it (separate from cyberstrike-hybrid services):

```sh
cd external/decepticon
# follow upstream setup: install Docker + run the install script
curl -fsSL https://decepticon.red/install | bash
decepticon onboard           # provider, API key, model profile
decepticon                   # starts LangGraph :2024 + web :3000
```

Switch the platform to the real adapter via env:

```sh
export DECEPTICON_ADAPTER=real
export DECEPTICON_API_URL=http://localhost:2024
export DECEPTICON_ASSISTANT_ID=decepticon  # or 'soundwave' for planning interview
```

The `FakeDecepticonAdapter` (Sprint 8) remains the default and is used
for CI / unit tests since CI has no Docker runtime for the real engine.

## End-to-end demo (Sprint 13)

Run a real engagement from assessment.start → confirmed finding in the UI:

**Prerequisites:**
- Decepticon stack healthy on `localhost:2024` (7/7 containers)
- PostgreSQL on `localhost:5433` (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike`)
- Lab target reachable (e.g. Metasploitable 2 on `http://192.168.56.101/`)

**Steps:**

1. Set env vars for the real adapter:

```sh
export DECEPTICON_ADAPTER=real
export DECEPTICON_API_URL=http://localhost:2024
export DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike
```

2. Start the API + coordinator (from project root):

```sh
bun run dev
```

3. Create a project, add the lab target (IP or URL), start an assessment via the UI or API.

4. The coordinator picks up the `assessment.start` job, scope-validates the target, then calls
   `RealDecepticonAdapter.start()` which creates a LangGraph thread at `:2024` and streams
   subagent events back. Each `report_finding` event becomes a `candidate_findings` row,
   and a `validate.finding` job is dispatched to the validator-worker.

5. Open `http://localhost:3000` (apps/web) — confirmed findings appear under the assessment
   once the validator-worker processes the `validate.finding` job.

**Scope invariant:** every candidate's `affectedUrl` is validated against the assessment scope
before it is persisted. Out-of-scope candidates are dropped silently with a
`scope.validate.denied` audit row.

**LangGraph thread ID** is stored in `decepticon_sessions.langgraph_thread_id` for traceability.
You can cross-reference with the Decepticon web UI at `http://localhost:3000` (upstream port).

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
```

## Auth

Sprint 3 ships the auth surface for the API: bootstrap registration, login
(password + optional TOTP MFA), logout, MFA enrollment, password reset, and a
1274-cell static RBAC matrix.

### Bootstrap

The very first registration creates the platform_admin user + owning tenant
and atomically flips `platform_settings.bootstrap_consumed_at`. Every
subsequent `POST /auth/register` returns `410 Gone`.

In non-`local` envs, a strong `BOOTSTRAP_TOKEN` (≥32 bytes / 64 hex chars)
is required at boot. In `local`, the token is optional (set
`APP_ENV=local`).

```sh
APP_ENV=local SESSION_SECRET="$(openssl rand -hex 32)" \
  bun apps/api/src/server.ts &

curl -X POST http://localhost:8080/auth/register \
  -H 'content-type: application/json' \
  -d '{
    "email": "admin@example.com",
    "password": "correct-horse-battery-staple",
    "displayName": "Bootstrap Admin",
    "tenantSlug": "acme",
    "tenantName": "Acme",
    "bootstrapToken": "irrelevant-in-local"
  }'
```

### Login

Two-step flow:

1. `POST /auth/login` with `{email, password}`.
   - Valid creds + no MFA → `200` + `Set-Cookie: cs_session=...`.
   - Valid creds + MFA enrolled → `401` + `{pre_auth_token, expires_in}`.
   - Anything else → `401` + `{error: 'invalid_credentials'}` (canonical).

2. (only if MFA) `POST /auth/login/mfa` with `{pre_auth_token, mfa_code}`.
   - Valid → `200` + `Set-Cookie`. Failure → canonical `401`.

### MFA enrollment

Authenticated user calls `POST /auth/mfa/enable` to receive a fresh TOTP
secret (SHA1 / 6 digits / 30s period), renders it as a QR code, and confirms
with `POST /auth/mfa/verify` carrying the first valid 6-digit code.

### RBAC summary

- 7 roles: `platform_admin`, `tenant_admin`, `security_lead`, `operator`,
  `developer`, `auditor`, `viewer`.
- 13 resources, 14 actions → 1274 frozen `(role, resource, action)` cells.
- `assertCan(actor, action, resource)` is pure (no I/O, no tenancy).
- Tenancy is enforced separately via `tenantGuard` + `assertOwnership`.

### Further reading

- [ADR 0003 — Auth, RBAC, Tenancy & MFA Secret Encryption](./docs/adr/0003-mfa-secret-encryption.md)
- [OWASP ASVS L1 mapping](./docs/security/asvs-l1-mapping.md)
- [Auth-rotation runbook](./docs/runbooks/auth-rotation.md)

## ADRs

- [ADR 0001 — Monorepo with Bun workspaces](./docs/adr/0001-monorepo-bun-workspaces.md)
- [ADR 0002 — DB driver: Kysely + node-postgres](./docs/adr/0002-db-driver-kysely-pg.md)
- [ADR 0003 — Auth, RBAC, Tenancy & MFA Secret Encryption](./docs/adr/0003-mfa-secret-encryption.md)

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
