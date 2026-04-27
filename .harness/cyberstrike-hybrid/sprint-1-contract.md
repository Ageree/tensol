# Sprint 1 Contract — Repo Bootstrap, Workspaces, Lint/Typecheck/Test Scaffolding

> Status: REVISED v2 (awaiting evaluator approval)
> Author: Generator
> Reviewer: Evaluator (R1–R10 + 3 optional tightening items folded in)
> Source: product-spec.md §1.3, §1.5, §2 Sprint 1; plan §4.1
> Repo root: `/Users/saveliy/Documents/пентест ИИ`

## Revision log

- **v2** (current): folded evaluator R1–R10 + 3 optional tightenings. Bun pinned to `1.3.11` via `package.json#packageManager`. A2/A11/A14/A17/A18/A19/A20/A21/A24 rewritten. New §11 "Commit hygiene + regression guard". `noEmit` explicitly **not** set on workspace tsconfigs (R3 confirmation).
- v1: initial proposal.

---

## 1. Goal

Stand up an empty-but-bootable Bun-workspaces monorepo with strict TypeScript, Biome lint+format, `bun test` with 80% coverage thresholds, every workspace dir from spec §1.3 present and compiling, a docker-compose stack (Postgres + MinIO + queue placeholder), `packages/config` with zod-validated env loader (fail-fast in non-`local`), CI with four jobs, ADR 0001, and a root README.

No business logic; no DB migrations; no API routes; no UI. Just the skeleton + gates.

## 2. Scope (files / dirs to create)

### 2.1. Root

- `package.json` — Bun workspaces root (`workspaces: ["apps/*", "services/*", "packages/*"]`), `private: true`, **`packageManager: "bun@1.3.11"`** as the canonical Bun version (R4/R8). Scripts: `lint`, `lint:fix`, `typecheck`, `test`, `test:coverage`, `build`, `db:migrate:check` (placeholder), `lab:xss` (placeholder), `bun:assert-version` (asserts running `bun --version` matches `package.json#packageManager`).
- `bunfig.toml` — `[test]` block with coverage thresholds 80/80/80/80 (`coverageThreshold = { line = 0.8, function = 0.8, branch = 0.8, statement = 0.8 }`). A header comment documents that the canonical Bun pin lives in `package.json#packageManager` (R4). If the pinned Bun version (`1.3.11`) lacks any sub-field of `coverageThreshold`, an lcov post-hook fallback in `scripts/coverage-gate.ts` parses lcov and fails on < 80% — documented inline in `bunfig.toml`.
- `tsconfig.base.json` — `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `module: "ESNext"`, `target: "ES2022"`, `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `skipLibCheck: true`, `composite: true`.
- `tsconfig.json` — solution-style root with `references` to every workspace.
- `biome.json` — Biome 1.x config: linter on, formatter on, recommended rules + `noNonNullAssertion: error`, `noExplicitAny: error`, import sort.
- `.gitignore` — `node_modules/`, `dist/`, `coverage/`, `.queue-local/`, `.env`, `.env.local`, `*.tsbuildinfo`.
- `.editorconfig`.
- `.nvmrc` / Bun version doc note in README (Bun is the runtime; Node only for tooling fallback).
- `README.md` — repo overview, prerequisites (Bun ≥ 1.1.x, Docker), how to run lint/typecheck/test, how to bring up compose stack, link to ADRs.

### 2.2. Workspaces (each gets `package.json`, `tsconfig.json` extending base with `composite: true`, `src/index.ts` exporting a typed placeholder, and a smoke test under `src/index.test.ts`)

Per spec §1.3:

```
apps/web/
apps/api/
services/coordinator/
services/browser-worker/
services/validator-worker/
services/report-builder/
services/http-worker/             # scaffold dirs only — out of slice (per §1.3 comment)
services/cyberstrike-worker/      # scaffold dirs only
services/llm-gateway/             # scaffold dirs only
packages/config/
packages/contracts/
packages/db/
packages/authz/
packages/scope-engine/
packages/audit/
packages/object-storage/
packages/queue/
packages/telemetry/
packages/validators/
packages/reports/
packages/skill-library/           # scaffold only
```

Per workspace `package.json` includes:
- `name: "@cyberstrike/<workspace-name>"`
- `private: true`
- `type: "module"`
- `main: "./src/index.ts"` (Bun runs TS directly)
- minimal `scripts.typecheck: "tsc -b"` (uses composite refs)
- no external deps in this sprint except `packages/config` (zod), and root devDeps.

### 2.3. `packages/config`

- `src/index.ts` — exports `loadConfig<T>(schema: ZodSchema<T>, env?: NodeJS.ProcessEnv): T`. Loads from `env ?? process.env`, parses with `safeParse`, throws `ConfigValidationError` (typed) on failure.
- `src/app-env.ts` — `AppEnv` zod enum: `local | dev | staging | production | internal-lab`.
- `src/base-schema.ts` — `baseConfigSchema` requiring `APP_ENV`. In non-`local` env: requires `DATABASE_URL`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY`, `OBJECT_STORAGE_BUCKET`, `QUEUE_ADAPTER`, `DECEPTICON_ADAPTER`, `SESSION_SECRET`. In `local`: defaults applied (zod `.default(...)`).
- `src/errors.ts` — `ConfigValidationError extends Error` with `issues` array.
- `src/index.test.ts` — RED-first test cases (see §4).

### 2.4. `infra/docker/docker-compose.local.yml`

- Service `cs-postgres`: `postgres:16-alpine`, port `5433:5432`, env `POSTGRES_USER=cs`, `POSTGRES_PASSWORD=cs`, `POSTGRES_DB=cyberstrike`, named volume `cs-postgres-data`, healthcheck `pg_isready -U cs`.
- Service `cs-minio`: `minio/minio:latest`, ports `9000:9000` (S3 API) and `9001:9001` (console), env `MINIO_ROOT_USER=cs`, `MINIO_ROOT_PASSWORD=cs-secret`, command `server /data --console-address ':9001'`, healthcheck `curl -f http://localhost:9000/minio/health/live`.
- Service `cs-queue-emulator`: tiny placeholder `alpine:3.19` running `tail -f /dev/null` with healthcheck `[CMD, 'true']`. Documented in compose-file comments as a stub for the future Yandex MQ emulator.
- Top-level `volumes:` and named network.

### 2.5. CI — `.github/workflows/ci.yml`

**Triggers (R5):**
```yaml
on:
  push:
    branches: ['**']
  pull_request:
    branches: ['main']
```

Five jobs (matrix where noted):

1. `lint` — `bun install --frozen-lockfile`, `bun run lint`.
2. `typecheck` — `bun install --frozen-lockfile`, `bun run typecheck`.
3. `unit-tests` — matrix `workspace: [packages/config]` (expands sprint-by-sprint per R6), `bun install`, `bun test --coverage`. Coverage gate fails if any threshold < 80%.
4. `migration-check` — placeholder echo-step that exits 0; expanded in Sprint 2.
5. `image-build` — placeholder echo-step that exits 0; expanded when service Dockerfiles arrive.

All jobs run on `ubuntu-latest`. Bun set up via `oven-sh/setup-bun@v1` reading the canonical pin from `package.json#packageManager` (R4/R8). Each job runs a **`bun:assert-version`** step *before* `bun install` that does:

```sh
PINNED=$(node -p "require('./package.json').packageManager.split('@')[1]")
RUNNING=$(bun --version | tr -d '\n')
[ "$PINNED" = "$RUNNING" ] || { echo "Bun version mismatch: pinned=$PINNED running=$RUNNING"; exit 1; }
```

This guarantees deterministic Bun version per R4.

### 2.6. Docs

- `docs/adr/0001-monorepo-bun-workspaces.md` — context (why monorepo, Bun, Biome over ESLint+Prettier, Kysely planned for Sprint 2), decision, consequences, alternatives considered.

## 3. Out of scope for Sprint 1

- No DB migrations, no Kysely, no actual schema (lands Sprint 2).
- No Hono routes, no auth, no RBAC.
- No queue implementation (lands Sprint 7).
- No real scope engine, no Decepticon adapter, no validators.
- No UI components.
- No service logic in `services/*` beyond placeholder index exports.
- No production Dockerfiles.
- No pre-commit hooks (out of scope; can be added later).

## 4. Acceptance Criteria (testable)

Each item below is a binary pass/fail check the evaluator can run from repo root.

### 4.1. Install + tooling

- [ ] **A1:** `bun install` from a clean clone exits 0 with no peer-dep warnings about missing direct dependencies.
- [ ] **A2 (R4 rewrite):** Canonical Bun pin lives at `package.json#packageManager` (e.g. `"bun@1.3.11"`). Verification:
  ```sh
  PINNED=$(node -p "require('./package.json').packageManager.split('@')[1]")
  RUNNING=$(bun --version | tr -d '\n')
  [ "$PINNED" = "$RUNNING" ]   # exits 0
  ```
  CI runs the same assert step (R4 / §2.5).
- [ ] **A3:** Repo contains exactly the workspace dirs listed in §2.2; `bun pm ls --all` shows every workspace.

### 4.2. Lint

- [ ] **A4:** `bun run lint` exits 0 (no errors, no warnings — Biome with recommended + project overrides).
- [ ] **A5:** Introducing a deliberate `any` type in any `src/index.ts` causes `bun run lint` to exit non-zero (manual probe by evaluator; revertable).

### 4.3. Typecheck

- [ ] **A6:** `bun run typecheck` exits 0 across every workspace via composite project references (`tsc -b`).
- [ ] **A7:** `noUncheckedIndexedAccess` is active: a probe file (added then removed) like `const a: number[] = []; const x: number = a[0];` fails typecheck.
- [ ] **A8:** Each workspace's `tsconfig.json` extends `tsconfig.base.json` and has `composite: true`. Verified by `find . -name tsconfig.json -path '*/apps/*' -o -path '*/services/*' -o -path '*/packages/*'` and grep.

### 4.4. Tests + coverage

- [ ] **A9:** `bun test` exits 0 and runs at least the `packages/config` suite + the placeholder smoke tests in every workspace.
- [ ] **A10:** `bun test --coverage` reports lines/functions/branches/statements ≥ 80% for `packages/config`.
- [ ] **A11 (R1 rewrite — direction corrected; updated to reflect the lcov-gate active mechanism):** Coverage thresholds are declared in `bunfig.toml` AND enforced by `scripts/coverage-gate.ts` (the lcov post-hook fallback documented in §10 #2 — used because Bun 1.3.11 does not actively fail on `coverageThreshold` breach). Probe:
  ```sh
  bun test --coverage
  bun run coverage:gate                  # exit 0 (passes at 0.80)
  bun scripts/coverage-gate.ts --threshold=1.00   # exit 1 (fails at 1.00)
  ```
  The gate-at-1.00 step proves the gate is real. CI runs `bun run coverage:gate` after tests in the `unit-tests` job. (Original wording was inverted — flagged by R1.)

### 4.5. `packages/config` (TDD-targeted)

Tests (RED before GREEN) the evaluator can read in `packages/config/src/index.test.ts`:

- [ ] **A12:** Given `APP_ENV=local`, `loadConfig(baseConfigSchema, {APP_ENV: 'local'})` returns parsed config with defaults; **no throw**.
- [ ] **A13:** Given `APP_ENV=staging` and missing `DATABASE_URL`, `loadConfig` throws `ConfigValidationError`; error includes the missing-key path.
- [ ] **A14 (R2 rewrite — deep immutability):** Given `APP_ENV=production` and all required keys present, `loadConfig` returns a **deeply frozen** object. Implementation: `loadConfig` runs a `deepFreeze(value)` recursive helper (covers nested objects + arrays) before returning. Tests:
  - (a) `Object.isFrozen(config) === true` and `Object.isFrozen(config.objectStorage) === true` (deep, not just root).
  - (b) Strict-mode mutation throws: `'use strict'; (() => { (config as any).appEnv = 'local'; })()` throws `TypeError`. Same for nested key: `(config.objectStorage as any).bucket = 'x'` throws.
  - (c) Array fields (if any) — pushing throws.
  This catches nested mutation, not just top-level (R2).
- [ ] **A14b (new — TOTP for SESSION_SECRET length, R8 / §10 #5):** Given `APP_ENV=staging` and `SESSION_SECRET` of length 31, `loadConfig` throws `ConfigValidationError` with an issue path pointing to `session_secret`. Length 32 passes. Same assertion for `production`, `dev`, `internal-lab`.
- [ ] **A15:** Given an invalid `APP_ENV` value (e.g. `dev2`), `loadConfig` throws with a clear `app_env` issue.
- [ ] **A16:** `ConfigValidationError.issues` is an array of `{path, message}` shaped entries.
- [ ] **A17 (R3 — labelled minimum bar):** **MINIMUM-BAR** hardcoded-secret smoke check. The grep
  ```sh
  grep -RIn -E "(SESSION_SECRET|OBJECT_STORAGE_SECRET_KEY)\s*=\s*['\"][^'\"]+" packages/ apps/ services/
  ```
  returns zero hits. **Explicitly acknowledged limitations:** misses base64 blobs, YAML `password:` literals, high-entropy strings. Broader scanning (gitleaks/trufflehog) is **deferred** and tracked in §9 / §11. This check is a smoke test, not a guarantee. Locking in false confidence is unacceptable; the contract makes the gap explicit per R3.

### 4.6. Workspace bootability

- [ ] **A18 (R9 rewrite — anti-vacuous):** Each workspace `src/index.ts` exports `export const name = '<workspace-key>' as const;` where `<workspace-key>` matches the workspace's directory path key (e.g. `apps/api` exports `name = 'apps/api'`, `packages/scope-engine` exports `name = 'packages/scope-engine'`). The sibling `src/index.test.ts` imports `name` and asserts it equals the workspace's directory path. This prevents copy-paste bugs where every workspace exports `'placeholder'` and smoke tests pass vacuously. Verified by an aggregator test in `tests/integration/workspace-names.test.ts` that walks the workspace tree, imports each `index.ts` dynamically, and asserts uniqueness + directory-path match.
- [ ] **A19 (R3 optional rewrite — verifiable):** No workspace contains a runtime side effect on import. Verified by a deterministic check:
  ```sh
  grep -RIn -E "^(console\.|await )" apps/ services/ packages/ --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist
  ```
  returns zero hits. Test files (`*.test.ts`) are scope-included; this is intentional — placeholder smoke tests must not run code on import either (the assertions live inside `test(...)` blocks, never at module top level).

### 4.7. Docker compose

- [ ] **A20 (tightened — exact service set):** `docker compose -f infra/docker/docker-compose.local.yml config` validates the file (exit 0). Additionally:
  ```sh
  docker compose -f infra/docker/docker-compose.local.yml config --services | sort
  # expected exact output (no extras, no missing):
  # cs-minio
  # cs-postgres
  # cs-queue-emulator
  ```
- [ ] **A21 (deterministic health probe — replaces `jq` chain):** `docker compose -f infra/docker/docker-compose.local.yml up -d` brings up all three services. Health verified via `docker inspect`:
  ```sh
  deadline=$(( $(date +%s) + 60 ))
  while [ $(date +%s) -lt $deadline ]; do
    pg=$(docker inspect --format '{{.State.Health.Status}}' cs-postgres 2>/dev/null || echo "starting")
    mn=$(docker inspect --format '{{.State.Health.Status}}' cs-minio    2>/dev/null || echo "starting")
    qe=$(docker inspect --format '{{.State.Health.Status}}' cs-queue-emulator 2>/dev/null || echo "starting")
    [ "$pg" = "healthy" ] && [ "$mn" = "healthy" ] && [ "$qe" = "healthy" ] && exit 0
    sleep 2
  done
  echo "timeout waiting for healthy: pg=$pg mn=$mn qe=$qe"; exit 1
  ```
  This is independent of `docker compose ps --format json` shape (which has changed across Compose versions).
- [ ] **A22:** `docker compose down -v` cleans up named volumes.

### 4.8. CI

- [ ] **A23:** `.github/workflows/ci.yml` exists with jobs `lint`, `typecheck`, `unit-tests`, `migration-check`, `image-build`. Validated by `yq '.jobs | keys' .github/workflows/ci.yml`.
- [ ] **A24 (R5 rewrite — explicit triggers):** Workflow declares exactly:
  ```yaml
  on:
    push:
      branches: ['**']
    pull_request:
      branches: ['main']
  ```
  Verified by `yq '.on' .github/workflows/ci.yml` matching the above structurally. This makes both feature-branch pushes AND PRs against `main` clear; ambiguity about `main` (raised by R5) is resolved.
- [ ] **A25:** Each job pins Bun via `oven-sh/setup-bun@v1` reading from `package.json#packageManager`, runs the `bun:assert-version` step (R4), then `bun install --frozen-lockfile`.

### 4.9. Documentation

- [ ] **A26:** `docs/adr/0001-monorepo-bun-workspaces.md` exists, has the four ADR sections (Context, Decision, Consequences, Alternatives), and is non-empty (≥ 80 lines).
- [ ] **A27:** `README.md` has sections "Prerequisites", "Install", "Common scripts", "Local stack", "Repo layout", "ADRs".

## 5. Verification commands (single source of truth)

The evaluator runs, in order:

```bash
# Install + tooling
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test --coverage

# Compose stack
docker compose -f infra/docker/docker-compose.local.yml config
# exact service set:
diff <(docker compose -f infra/docker/docker-compose.local.yml config --services | sort) <(printf 'cs-minio\ncs-postgres\ncs-queue-emulator\n')

docker compose -f infra/docker/docker-compose.local.yml up -d

# wait for health (deterministic, uses docker inspect — no jq, no Compose-version drift)
deadline=$(( $(date +%s) + 60 ))
while [ $(date +%s) -lt $deadline ]; do
  pg=$(docker inspect --format '{{.State.Health.Status}}' cs-postgres 2>/dev/null || echo "starting")
  mn=$(docker inspect --format '{{.State.Health.Status}}' cs-minio    2>/dev/null || echo "starting")
  qe=$(docker inspect --format '{{.State.Health.Status}}' cs-queue-emulator 2>/dev/null || echo "starting")
  [ "$pg" = "healthy" ] && [ "$mn" = "healthy" ] && [ "$qe" = "healthy" ] && break
  sleep 2
done
[ "$pg" = "healthy" ] && [ "$mn" = "healthy" ] && [ "$qe" = "healthy" ] || { echo "compose unhealthy: pg=$pg mn=$mn qe=$qe"; exit 1; }

docker compose -f infra/docker/docker-compose.local.yml down -v

# CI workflow shape
yq '.jobs | keys' .github/workflows/ci.yml

# Secret-leak smoke
grep -RIn -E "(SESSION_SECRET|OBJECT_STORAGE_SECRET_KEY)\s*=\s*['\"][^'\"]+" packages/ apps/ services/ || true
```

All commands exit 0 (or the documented `|| true` for the negative-grep) and outputs match expectations from §4.

## 6. Edge cases covered

- **Missing env in `local`** — defaults applied; boot succeeds (A12). Per spec §2 Sprint 1 edge cases.
- **Missing env in `staging|production|dev|internal-lab`** — boot aborts with typed error (A13, A15).
- **Bun version mismatch** — CI fails fast because `setup-bun` reads `package.json#packageManager` (A2/A25); the `bun:assert-version` step then guards against drift between installed and pinned versions.
- **Cross-workspace imports** — composite refs resolved correctly; A6 + A18 cover.
- **Coverage regression** — A10 + A11 enforce; lowering coverage breaks build.
- **Secret leak in source** — A17 grep-scan + Biome `noHardcodedSecrets` style rule (if available; otherwise rely on grep).
- **Empty workspaces don't pollute test runs** — placeholder smoke tests are deterministic (A9).

## 7. TDD plan for `packages/config`

```
RED:    write src/index.test.ts asserting A12–A16 — initially no impl, all fail.
GREEN:  implement loadConfig + schemas to pass.
REFACTOR: split base-schema into composable per-env schemas; ensure ≤ 200 lines per file.
```

## 8. File-size budget

All files in this sprint target 200–400 lines, hard cap 800. Expected sizes:
- `packages/config/src/index.ts`: ~50 lines
- `packages/config/src/base-schema.ts`: ~120 lines
- `packages/config/src/index.test.ts`: ~150 lines
- `tsconfig.base.json`: ~25 lines
- `biome.json`: ~40 lines
- `infra/docker/docker-compose.local.yml`: ~80 lines
- `.github/workflows/ci.yml`: ~120 lines
- `docs/adr/0001-monorepo-bun-workspaces.md`: ~120 lines
- `README.md`: ~150 lines

## 9. Non-deliverables (explicit deferrals)

- **`packages/config` does not yet load secrets from a vault** — env-only this sprint; vault adapter deferred.
- **CI does not run integration tests** — no integration tests exist yet.
- **`migration-check` and `image-build` jobs are placeholders** — they exit 0 with an echo message; expanded in Sprint 2 / when Dockerfiles arrive.
- **No frontend tooling** — `apps/web` is a typed placeholder; Vite + React land in Sprint 11.
- **No telemetry init** — `packages/telemetry` is a placeholder; Sentry/OTel wiring deferred to Sprint 4.
- **(R6) Coverage thresholds — global vs per-workspace gotcha.** Sprint 1 enforces 80% on `packages/config` only. The global threshold in `bunfig.toml` will pass *trivially* in Sprint 1 because every other workspace is a one-line export. **From Sprint 2 onward, coverage thresholds MUST be evaluated per-workspace, not aggregated.** Otherwise a real package can dip below 80% while the global average stays green. The Sprint 2 contract must add per-workspace coverage gates. Tracked here so the gap is explicit.
- **(R3) Broader secret scanning (gitleaks/trufflehog) deferred** to a later sprint (likely the security-hardening sprint after Sprint 12). A17 is a smoke-bar; production-grade scanning is tracked, not silently dropped.
- **Pre-commit hooks** — out of scope; not added in Sprint 1.

## 10. Risks / open questions (RESOLVED in v2)

All previously-open questions are now resolved per evaluator's review:

1. **Biome 1.x — APPROVED.** Will use.
2. **Coverage thresholds via `bunfig.toml` — APPROVED with caveat.** Bun pinned to `1.3.11` via `package.json#packageManager` (R8). If `1.3.11` lacks any sub-field of `coverageThreshold`, the lcov post-hook fallback in `scripts/coverage-gate.ts` is documented inline.
3. **`composite: true` + Bun — APPROVED.** Workspace tsconfigs set `outDir`/`rootDir`; **`noEmit` is NOT set** (composite requires emit info even though we never `bun run build` in Sprint 1). `dist/` and `*.tsbuildinfo` already in `.gitignore`.
4. **Trivial placeholder smoke tests — APPROVED with R9 shape.** Each `name` export now equals the workspace directory key (e.g. `apps/api`); aggregator test catches copy-paste bugs.
5. **`SESSION_SECRET` ≥ 32 chars in non-local — APPROVED.** A14b (new) covers this.

---

## 11. Commit hygiene + regression guard (R7, R10)

### 11.1. Commit hygiene (R7)

Per project rules (`CLAUDE.md` → `~/.claude/rules/common/git-workflow.md`) and the user's global settings (`~/.claude/settings.json` disables attribution):

- All Sprint 1 bootstrap commits use **conventional-commits** types: `feat:`, `chore:`, `docs:`, `ci:`, `test:`. Body explains *why* in 1–2 sentences.
- **No `Co-Authored-By:` line.** **No `🤖 Generated with [Claude Code]` line.** **No attribution of any kind.** Attribution is disabled globally; bootstrap commits MUST follow that rule.
- The Lead handles `git add` / `git commit` per the harness contract. Generator only authors files; never invokes git.

### 11.2. Regression guard (R10)

Per product spec §5: *"Sprint PASS = lint + typecheck + unit tests + integration tests (where applicable) + tenant-isolation tests + scope/IDOR/audit security tests. A sprint that adds a new layer must also pass all earlier sprint suites."*

**Sprint 1 is the baseline.** There are no prior sprint suites to re-run. From **Sprint 2 onward**, every PASS verdict must include a re-run of all prior sprint suites — the verification command in each subsequent sprint contract will explicitly enumerate the cumulative test set. The Sprint 2 contract will start that practice.

---

End of contract proposal v2. Awaiting evaluator approval.
