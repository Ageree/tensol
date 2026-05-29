# Implementation Plan: Sthrip PR Review — Connect, Select Repositories & Deep Automated Review

**Branch**: `004-sthrip-pr-review` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-sthrip-pr-review/spec.md`

## Summary

Complete the self-serve product around the **already-shipped** review engine (`server/src/review/`) and deepen its finding quality to Hacktron level. Three workstreams:

1. **Connect & select (P1)** — a GitHub-App OAuth connect flow, an installation lifecycle (install / repos-added / repos-removed / uninstall), and a repository-selection + per-repo-config UI. This is the missing product surface; the webhook ingestion + review pipeline already exist.
2. **Trust upgrades (P2)** — an explicit **verification gate** (no finding posts unless corroborated/evidenced), **reachability/dataflow** gating (so a finding asserts the sink is reachable from untrusted input), **confidence-gated self-challenge**, a merge-blocking **check-run**, and **auto-resolve on remediation**. Plus a **context-engine upgrade** (regex repomap → tree-sitter symbol graph), staying commercially-license-clean.
3. **Developer skills (P2)** — rebrand `tensol-loop` → `sthrip-loop` and add `sthrip-check-pr`, mirroring `greptileai/skills`.

The engineering posture follows the research dossier (`research.md`): keep the deterministic SAST-grounded scorer (kills the LLM-only hallucination class), bolt on reachability + an evidence gate as the differentiators, and ship **only permissively-licensed** scanners/rules/context tooling as `Bun.spawn` sidecars or in-process TS.

## Technical Context

**Language/Version**: TypeScript on Bun ≥ 1.1 (server); React + Vite (apps/site frontend).

**Primary Dependencies**: Hono (HTTP), Drizzle (ORM), SQLite; `@octokit/auth-app` (already present — installation-token minting). New/extended: `web-tree-sitter` (MIT, WASM, in-process AST for the context upgrade); SAST sidecars invoked via `Bun.spawn` — Opengrep engine + **AikidoSec/opengrep-rules (MIT)** / self-authored rules, Trivy, OSV-Scanner, Gitleaks (or Kingfisher); **Joern (Apache-2.0)** as a reachability/CPG sidecar run on the existing ephemeral-VM rail (JVM, not in-process). Optional/deferred semantic layer: `sqlite-vec` + an open code-embedding model.

**Storage**: SQLite (file in prod, in-memory in tests) via Drizzle. New migration `0013_pr_review_connect.sql`.

**Testing**: `bun test` (unit + integration on real in-memory SQLite; fake GitHub/SAST/LLM/repo-fetch/Joern clients — never mock the DB or the audit signer, per Constitution VI); Playwright E2E in `apps/site` for the connect→select flow.

**Target Platform**: Linux server (single Bun binary) + GCP ephemeral VM rail for heavy/isolated analysis.

**Project Type**: web-service (`server/`) + web frontend (`apps/site/`). Single Bun package (Constitution III).

**Performance Goals**: connect→select < 2 min (SC-001); review posted ≤ 5 min for a typical PR (SC-002); incremental context index keyed `repo+file+contentHash` for large monorepos.

**Constraints**: single Bun package (no `packages/*`); **commercial-license-clean shippable path only** (no AGPL/BSL/SSPL/Elastic/Commons-Clause/PolyForm-NC); per-user tenancy (one user = one org, Constitution V); signed audit on every state change (Constitution X); Zod at every boundary (Constitution IX); immutable data (Constitution VIII); files ≤ 800 lines (Constitution VII).

**Scale/Scope**: large monorepos (100k+ files) via change-scoped + incremental indexing; per-user installations; one GitHub App registration per deployment.

## Constitution Check

*GATE: must pass before Phase 0. Re-checked after Phase 1 (below).*

| Principle | Status | Notes |
|---|---|---|
| I. Decepticon Untouched | ✅ PASS | Review engine is independent of `external/decepticon/`; no edits there. Heavy analysis reuses the VM rail, not Decepticon. |
| II. Three Invariants | ✅ PASS (adapted) | **Auth-proof analog**: a review only runs for a repo reached via a *signed GitHub App installation* the user owns — the installation IS the ownership proof (no slug-only authorization; closes the cross-tenant takeover class). **HMAC audit**: new state changes emit `emitSignedAudit` (install/enable/review/verify/resolve/uninstall). **Egress isolation**: repo clone + scanners (incl. Joern) run on the per-review ephemeral VM where resource/footprint warrants; static analysis does **not** execute customer code, so the isolation need is lower than for blackbox scans but the rail is reused for heavy jobs. |
| III. Single Binary, Single Package | ✅ PASS | All backend code stays in `server/`. No new workspace packages. Joern/Opengrep/etc. are external **binaries** invoked via `Bun.spawn` or on the VM — not npm packages linked in-process. |
| IV. No Premature Abstraction | ✅ PASS | Verification gate, reachability, and self-challenge are concrete functions added to the existing `reviewer`/`engine`/`score` modules; no speculative interfaces. Context upgrade swaps the regex extractor for a tree-sitter one behind the existing `repomap` boundary. |
| V. YAGNI | ✅ PASS | Per-user tenancy retained (org/RBAC explicitly deferred — matches spec Assumptions). GitLab/Perforce backend ingestion out of scope. |
| VI. Test-First (NON-NEGOTIABLE) | ✅ PASS | Every new route/handler/gate starts with a failing test on real in-memory SQLite + fakes; coverage floor 80%. |
| VII. Files Small & Focused | ✅ PASS | New code organized as small modules (`review/github/connect.ts`, `review/verify.ts`, `review/reachability/`, `review/context/treesitter.ts`, etc.); split before 600 lines. |
| VIII. Immutable Data | ✅ PASS | Drizzle rows readonly; updates via explicit `db.update()`; finding records rebuilt, not mutated. |
| IX. Validate at Boundaries | ✅ PASS | Zod on every new HTTP route + every new webhook event variant before processing. |
| X. Audit Everything State-Changing | ✅ PASS | New audit events: `github_app_installed`, `github_app_uninstalled`, `review_repo_enabled`, `review_repo_disabled`, `review_settings_changed`, `review_finding_verified`, `review_thread_resolved`. |

**No violations → Complexity Tracking table omitted.**

One spec correction surfaced during Phase 0 grounding (see research.md R1): **GitNexus was never a product runtime dependency** (it is a dev-only MCP tool). FR-026 is therefore satisfied by *policy* — never vendor GitNexus into `server/` — rather than by ripping out a shipped dependency. The current product context engine is a permissively-clean regex extractor; the upgrade path stays clean. FR-025/027/028 are unaffected.

## Project Structure

### Documentation (this feature)

```text
specs/004-sthrip-pr-review/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (consolidated from the 6-agent dossier)
├── data-model.md        # Phase 1 — existing + new entities/columns
├── quickstart.md        # Phase 1 — how to run/verify the feature end-to-end
├── contracts/
│   ├── openapi.yaml      # New connect/repo-management endpoints (+ existing review endpoints referenced)
│   └── webhooks.md       # New GitHub webhook event variants handled
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /specify)
└── tasks.md             # Phase 2 — /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
server/                                  # single Bun package (Constitution III)
├── migrations/
│   └── 0013_pr_review_connect.sql        # NEW: installations table + repo settings + finding.verification
├── src/
│   ├── db/schema.ts                      # EXTEND: installations table; review_repos settings cols; review_findings.verificationStatus; review_suppressions
│   ├── config.ts                         # EXTEND: GITHUB_APP_* already present; add review tuning knobs
│   ├── server.ts                         # EXTEND: mount /v1/github connect routes; new audit/dispatcher entries
│   ├── routes/
│   │   ├── github-connect.ts             # NEW: GET /v1/github/connect (install URL), GET /v1/github/callback, GET /v1/github/installations, GET/POST repo mgmt
│   │   ├── review.ts                     # EXTEND: repo enable/disable + per-repo settings
│   │   └── review-webhook.ts             # EXTEND: handle installation, installation_repositories, issue_comment(@sthrip review)
│   └── review/
│       ├── github/
│       │   ├── connect.ts                # NEW: OAuth/app-install URL build + callback handling + installation persistence
│       │   ├── client.ts                 # EXTEND: list installation repos; minimal already present
│       │   └── webhook.ts                # EXTEND: classifyWebhook for new event types
│       ├── verify.ts                     # NEW: verification gate (SAST corroboration / evidence / reachability) → drop unverified
│       ├── reachability/                 # NEW: Joern (or lightweight taint) sidecar adapter → reachable + evidence
│       ├── context/
│       │   ├── repomap.ts                # EXISTING regex extractor (kept as fallback)
│       │   └── treesitter.ts             # NEW: web-tree-sitter symbol graph + PageRank-style ranking (commercially clean)
│       ├── reviewer.ts                   # EXTEND: confidence-gated self-challenge before emit
│       ├── score.ts                      # EXISTING deterministic 0-5; unchanged contract (model never emits score)
│       ├── poster.ts                     # EXTEND: edit-in-place summary; merge-blocking check-run; auto-resolve threads
│       ├── learning.ts                   # NEW: suppress nit category after N ignores; never security/correctness
│       └── service.ts                    # EXTEND: installation/repo CRUD + signed audit for new events

apps/site/                                # frontend (untouched stack)
├── src/pages/
│   ├── ConnectGitHub.tsx                 # NEW: connect button + callback landing + status
│   ├── Repositories.tsx                  # NEW: repo picker (all/subset) + per-repo settings + last-review status
│   ├── Reviews.tsx                       # EXISTING (review history list)
│   └── ReviewDetail.tsx                  # EXISTING (one review)
├── src/lib/api-client.ts                 # EXTEND: github connect + repo mgmt namespace
└── src/App.tsx                           # EXTEND: routes + nav

.claude/skills/
├── sthrip-loop/                          # RENAME of tensol-loop (loop-until-5/5)
│   ├── SKILL.md
│   ├── scripts/review.sh
│   └── references/{api.md, graphql-queries.md}
└── sthrip-check-pr/                      # NEW (port of greptile check-pr)
    ├── SKILL.md
    └── references/{graphql-queries.md, gitlab-api.md}
```

**Structure Decision**: Extend the existing `server/src/review/` domain and `apps/site` rather than create anything new at the package level (Constitution III). New backend capabilities are small sibling modules behind the engine's existing boundaries (`context/`, `github/`, plus new `verify.ts`, `reachability/`, `learning.ts`). External analyzers stay out-of-process (`Bun.spawn` / VM), preserving the single-package invariant and license isolation (FR-028).

## Phase 0 — Research

See [research.md](./research.md). All technical unknowns resolved; no remaining `NEEDS CLARIFICATION`. Key decisions: context-engine upgrade path (tree-sitter in-process, codegraph/codebase-memory-mcp as reference, not vendored); reachability via Joern on the VM rail; verification-gate definition; license matrix for every shippable component; skills shape.

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md) — existing entities (reference) + new `installations`, `review_suppressions`, new columns (`review_repos.statusCheckEnabled`, `mergeBlockOnCritical`; `review_findings.verificationStatus`).
- [contracts/openapi.yaml](./contracts/openapi.yaml) — new connect + repo-management endpoints.
- [contracts/webhooks.md](./contracts/webhooks.md) — new GitHub event variants (installation, installation_repositories, issue_comment trigger).
- [quickstart.md](./quickstart.md) — end-to-end run/verify.
- Agent context (`CLAUDE.md` SPECKIT block) updated to point at this plan.

**Post-Design Constitution re-check**: ✅ still passing — no new package, all writes audited, all boundaries Zod-validated, all shippable deps permissive. Verification gate + reachability add concrete functions, not speculative abstractions.
