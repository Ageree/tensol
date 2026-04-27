# ADR 0001 — Monorepo with Bun Workspaces

- Status: Accepted
- Date: 2026-04-27
- Deciders: CyberStrike Hybrid harness team (Planner, Generator, Evaluator)
- Sprint: 1
- Related: product-spec.md §1.2 / §1.3 / §1.5; user-criteria.md "Stack" + "Repo Layout"

## Context

CyberStrike Hybrid is a multi-tenant authorized-pentest platform composed of a
React SPA, a Hono product API, several backend services (coordinator, browser
worker, validator worker, report builder, plus three deferred service stubs),
and a layered set of business-logic packages (scope-engine, contracts, db,
authz, audit, validators, reports, queue, telemetry, object-storage, config,
skill-library). The product spec mandates that business logic lives in
`packages/*` and services are thin adapters. The first 12 sprints share many
cross-cutting concerns: contracts, DB repositories, scope engine, audit,
validators, queue envelope. Each of these is consumed by multiple apps and
services.

A monorepo lets every consumer track contract changes atomically, eliminates
the npm-publish-and-bump cycle for internal packages, and makes
`bun run typecheck` a single command across the whole platform. The product
spec already prescribes a Bun + TypeScript-strict toolchain, Biome for lint +
format, and per-workspace `composite: true` tsconfigs.

This ADR captures the decision in writing so later sprints can reference it
when they touch tooling.

## Decision

The CyberStrike Hybrid repository uses **Bun workspaces** declared in the root
`package.json` with three workspace globs:

```json
{
  "workspaces": ["apps/*", "services/*", "packages/*"]
}
```

The canonical Bun version is pinned in `package.json#packageManager`
(`bun@1.3.11` at sprint 1 bootstrap). CI runs a `bun:assert-version` step
before `bun install` to catch drift between the installed and pinned versions.

Lint + format is **Biome 1.9.4** (single tool; no ESLint + Prettier split).
Typecheck is `tsc -b` against composite project references rooted at the top
`tsconfig.json` that lists every workspace. Bun runs TypeScript directly at
runtime; we do not emit JavaScript in normal development. Composite refs
require `outDir` and `rootDir` per workspace so that `*.tsbuildinfo` files
survive incremental builds.

Tests run on `bun test` with coverage via `bun test --coverage`. Coverage
thresholds (line / function / branch / statement at 0.80) are declared in
`bunfig.toml`. If a future Bun release stops supporting any sub-field, an
lcov post-hook fallback in `scripts/coverage-gate.ts` will parse lcov and
fail on < 80 %.

Local development infrastructure is a small `docker-compose.local.yml` under
`infra/docker/` that spins up Postgres 16 (port 5433), MinIO (S3 emulator,
ports 9000/9001), and a queue-emulator placeholder. No production deploy
targets live in the repo at Sprint 1.

## Consequences

**Positive.**

- Atomic refactors across `apps/`, `services/`, `packages/` without inter-repo
  PR coordination.
- Shared `tsconfig.base.json` enforces strict mode + `noUncheckedIndexedAccess`
  + `exactOptionalPropertyTypes` everywhere from day one.
- Single `bun install` resolves the entire dependency graph; CI is a single
  job per concern (lint, typecheck, unit-tests matrix).
- Biome replaces ESLint + Prettier — one config, faster, fewer plugins to keep
  current.
- Coverage thresholds live in `bunfig.toml` and are enforced in CI from
  Sprint 1; the per-workspace gating gap is tracked for Sprint 2.

**Negative / risks.**

- Bun is younger than Node + npm/pnpm; ecosystem gaps occasionally surface
  (e.g. specific test-runner conventions, niche tooling not yet packaged for
  Bun). Mitigation: each external library choice in later sprints checks Bun
  compatibility before adoption.
- Composite refs mean every workspace must be `composite: true`, which adds a
  small amount of per-workspace tsconfig boilerplate. Mitigation: a single
  `tsconfig.base.json` that all workspaces extend keeps drift in check.
- Coverage thresholds in Sprint 1 are aggregate. From Sprint 2 onward we must
  evaluate per-workspace; otherwise a real package can dip below 80 % while
  the global average stays green. Tracked as a non-deliverable in the Sprint
  1 contract §9.

**Operational notes.**

- Bun version drift between contributors is caught by the CI assert step.
  Local devs are expected to install the pinned version (the README links to
  Bun upgrade docs).
- Per-workspace `dist/` and `*.tsbuildinfo` are in `.gitignore`; CI runs
  `tsc -b` clean every time.

## Alternatives considered

1. **pnpm workspaces + Node.** Mature, well-documented, ubiquitous in CI.
   Rejected because the product spec mandates Bun, and Bun's native
   TypeScript execution removes the build step we would otherwise need
   for development services.
2. **Turborepo on top of pnpm.** Rich task graph, remote caching. Heavier
   for a 20-workspace repo at Sprint 1; we can layer Turborepo or `bun run`
   piping later if build time becomes a problem.
3. **Nx monorepo.** Same trade-off as Turborepo — more powerful task
   orchestration, but more concepts to learn and more configuration up
   front. We keep the door open: a future ADR can adopt Nx if and when
   build times demand it.
4. **Multi-repo (one per service).** Highest isolation, worst contract
   drift. Rejected outright for a small team building a tightly-coupled
   product.

## References

- Product spec §1.2 "Architectural decisions" and §1.3 "Repo layout"
- Sprint 1 contract §2.1, §2.2 (workspace scaffolding)
- Bun workspaces docs (https://bun.sh/docs/install/workspaces)
- Biome docs (https://biomejs.dev/)
