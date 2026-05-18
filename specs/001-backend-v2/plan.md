# Implementation Plan: Tensol Backend v2 — Clean-Slate Redesign

**Branch**: `001-backend-v2` | **Date**: 2026-05-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-backend-v2/spec.md`

## Summary

Replace the bloated multi-package TS backend with one flat Bun package `server/` that serves the existing `apps/site/` frontend, drives Decepticon via a tiny per-scan VPS agent, and preserves the three load-bearing invariants from Constitution v1.0.0 (auth-proof, HMAC audit chain, egress isolation). Magic-link auth, SQLite + Drizzle persistence, in-process SQLite-backed job runner, Hetzner Cloud for ephemeral VPS, Resend for transactional email.

## Technical Context

**Language/Version**: TypeScript 5+ on Bun ≥ 1.1

**Primary Dependencies**: Hono (HTTP), Drizzle ORM, `bun:sqlite`, Zod (boundary validation), `resend` SDK (magic-link delivery), `node:crypto` (HMAC + random tokens), `@hetznercloud/api` HTTP client (no SDK — straight `fetch`)

**Storage**: SQLite (file `server/data/tensol.db` in prod; `:memory:` in tests)

**Testing**: `bun test` (unit + integration); Playwright on the `apps/site` side for E2E against a localhost backend

**Target Platform**: Linux x86_64 for production, macOS arm64 for development

**Project Type**: Web service — single Bun binary + the existing `apps/site` SPA + a tiny separate `vps-agent/` deployed to ephemeral cloud-init Linux VMs

**Performance Goals**: API p95 < 100 ms for read-only routes on SQLite single-process; sustain 10 concurrent scans without degradation

**Constraints**: Single-process, file-backed SQLite, no HA, no horizontal scaling. Public-internet reachability required for webhook (`cloudflared` tunnel in dev, reverse-proxied subdomain in prod). Depends on the unmodified `external/decepticon/` Docker image.

**Scale/Scope**: < 1k users in year one; tens of scans per week. Roughly 25–35 source files in `server/src/` plus 4–6 in `vps-agent/src/`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against Constitution v1.0.0 (`.specify/memory/constitution.md`):

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Decepticon Untouched | PASS | Plan changes only `server/` and `vps-agent/`; `external/decepticon/` is invoked as a black-box Docker image |
| II. Three Load-Bearing Invariants | PASS | Auth-proof enforced at `requireAuthProof` middleware before scan-start; HMAC audit centralized in `src/audit/emit.ts`; egress isolation via `vps/hetzner.ts` provisioning per scan |
| III. Single Binary, Single Package | PASS | One flat `server/` package; no `packages/*`. `vps-agent/` is a separate deploy unit (not an internal package) |
| IV. No Premature Abstraction | PASS | VPS provider is a plain module (one impl: Hetzner), no interface; email is a plain module (one impl: Resend) gated by env flag for `stdout` dev mode |
| V. YAGNI Ruthlessly | PASS | No action-cap layer, no multi-tenant, no HA, no SSE/WS progress |
| VI. Test-First (NON-NEGOTIABLE) | PASS | `/speckit-tasks` will produce failing-test tasks before implementation; coverage floor 80% via `bun test --coverage` |
| VII. Files Small & Focused | PASS | 200–400 line target / 800 max; project structure decomposes by domain |
| VIII. Immutable Data | PASS | Drizzle returns plain objects; service-layer helpers always return new copies; updates go through explicit `db.update()` |
| IX. Validate at Boundaries | PASS | Zod schemas in `src/schemas/*.ts` mounted on every route and every webhook |
| X. Audit Everything State-Changing | PASS | All mutators call `emitSignedAudit(db, args)`; chain verifier `src/audit/verify-chain.ts` runnable as a one-shot CLI |

**Verdict**: No violations. No entries needed in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-backend-v2/
├── plan.md              # This file
├── spec.md              # Feature spec (already created)
├── research.md          # Phase 0 output (this command)
├── data-model.md        # Phase 1 output (this command)
├── quickstart.md        # Phase 1 output (this command)
├── contracts/           # Phase 1 output (this command)
│   ├── openapi.yaml
│   └── webhook.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (already created)
└── tasks.md             # Phase 2 output (/speckit-tasks, NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
server/                         # New backend — one flat Bun package
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── README.md
├── data/                       # gitignored — runtime SQLite file
│   └── tensol.db
├── migrations/                 # Drizzle migrations
│   └── 0000_init.sql
├── src/
│   ├── server.ts               # Entry point: env load → db init → reconciler → Hono app → port listen
│   ├── config.ts               # Env loading + validation
│   ├── db/
│   │   ├── schema.ts           # Drizzle schema (all tables)
│   │   └── client.ts           # DB factory + tx helper
│   ├── audit/
│   │   ├── sign.ts             # HMAC sign/verify + canonical message format
│   │   ├── emit.ts             # emitSignedAudit() chain-aware writer
│   │   └── verify-chain.ts     # Standalone chain verifier (CLI entry point)
│   ├── auth/
│   │   ├── magic-link.ts       # Issue + verify magic-link token
│   │   ├── session.ts          # Cookie helpers
│   │   └── middleware.ts       # requireAuth
│   ├── auth-proof/
│   │   ├── challenge.ts        # Generate challenge token + methods payload
│   │   ├── verify.ts           # DNS TXT + HTTP file + meta-tag probe
│   │   └── middleware.ts       # requireAuthProof(targetId)
│   ├── projects/
│   │   └── service.ts          # CRUD
│   ├── targets/
│   │   ├── service.ts          # CRUD
│   │   └── url-guard.ts        # Reject private/local/malformed URLs
│   ├── scans/
│   │   ├── service.ts          # Lifecycle state machine
│   │   └── reconcile.ts        # Startup reconciliation
│   ├── findings/
│   │   └── service.ts          # Store + dedup by (scanId, title)
│   ├── vps/
│   │   ├── provider.ts         # Public API: spawnVps / getVpsStatus / destroyVps
│   │   └── hetzner.ts          # Hetzner Cloud API client (single impl)
│   ├── jobs/
│   │   ├── runner.ts           # Poll-and-dispatch loop
│   │   ├── types.ts            # Discriminated union of job types
│   │   └── handlers/
│   │       ├── spawn-vps.ts
│   │       ├── dispatch-scan.ts
│   │       ├── watchdog.ts
│   │       └── teardown-vps.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── projects.ts
│   │   ├── targets.ts
│   │   ├── auth-proof.ts
│   │   ├── scans.ts
│   │   └── webhooks.ts
│   ├── schemas/                # Zod schemas
│   │   ├── auth.ts
│   │   ├── projects.ts
│   │   ├── targets.ts
│   │   ├── auth-proof.ts
│   │   ├── scans.ts
│   │   └── webhook.ts
│   ├── email/
│   │   ├── resend-client.ts
│   │   └── templates/
│   │       └── magic-link.ts
│   └── lib/
│       ├── ids.ts              # uuid v7 generator
│       ├── time.ts             # now() helper (testable clock)
│       └── crypto.ts           # HMAC + random-token helpers
└── tests/
    └── integration/
        ├── auth.test.ts
        ├── auth-proof.test.ts
        ├── scan-lifecycle.test.ts
        ├── webhook.test.ts
        ├── reconcile.test.ts
        └── audit-chain.test.ts

vps-agent/                      # Tiny Bun server on each ephemeral VPS (~100 lines)
├── package.json
├── README.md
├── Dockerfile                  # Bun + docker-cli base image, baked by cloud-init
├── src/
│   ├── agent.ts                # HTTP: POST /scan, GET /status; self-teardown after callback
│   ├── decepticon-runner.ts    # docker compose up + wait for workspace/findings
│   ├── findings-collector.ts   # Parse YAML frontmatter from .md files into JSON
│   └── callback.ts             # HMAC-signed POST back to backend
└── tests/
    └── agent.test.ts
```

**Structure Decision**: Web service with **one** flat `server/` package (Bun + Hono + Drizzle + SQLite) plus a **second** flat `vps-agent/` package deployed onto ephemeral Hetzner Cloud VPSes. `apps/site/` (untouched) and `external/decepticon/` (untouched) remain at the repo root. No internal `packages/*`. This is the structure declared by Constitution III.

## Phase 0: Research

No `NEEDS CLARIFICATION` markers remained after the spec was written. All technology choices were made during brainstorming (see [docs/superpowers/specs/2026-05-18-backend-v2-design.md](../../docs/superpowers/specs/2026-05-18-backend-v2-design.md)). Phase 0 output is a single `research.md` that records the decisions made during planning that affect implementation: Hetzner cloud-init shape, Resend integration, cloudflared tunnel for dev webhook, audit canonical message format reuse from EE-2.

## Phase 1: Design & Contracts

Phase 1 produces:

- `data-model.md` — final Drizzle schema with TypeScript types, indexes, and state-transition tables for `scans`, `targets`, `auth_proofs`, `vps_instances`, `jobs`
- `contracts/openapi.yaml` — OpenAPI 3.1 covering the eight resource families: `auth`, `projects`, `targets`, `auth-proof`, `scans`, `findings` (read), `audit` (read), `webhooks`
- `contracts/webhook.md` — VPS-agent → backend signed-callback contract (request envelope, signature canonical-string, idempotency rules)
- `quickstart.md` — local dev recipe (Bun install, env file, cloudflared tunnel, first scan against a fake provider)

Then the agent context (`CLAUDE.md` between `<!-- SPECKIT START -->` and `<!-- SPECKIT END -->`) is updated to point at this plan.

## Phase 2: Tasks (deferred to /speckit-tasks)

Generated by `/speckit-tasks`. Not part of this plan output.

## Complexity Tracking

*No Constitution violations — section intentionally empty.*
