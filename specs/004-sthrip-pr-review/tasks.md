---
description: "Task list — Sthrip PR Review (feature 004)"
---

# Tasks: Sthrip PR Review — Connect, Select Repositories & Deep Automated Review

**Input**: Design documents from `/specs/004-sthrip-pr-review/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: REQUIRED. Constitution VI (Test-First) is NON-NEGOTIABLE — every new route/handler/gate starts with a failing test on real in-memory SQLite + fakes (never mock the DB or the audit signer). Coverage floor 80%.

**Context**: the review **engine already exists** (`server/src/review/`, migration 0012) and is merged to `main`. Most tasks **extend** existing modules. Stack: Bun + Hono + Drizzle + SQLite (single `server/` package), React/Vite frontend (`apps/site`). External analyzers run as `Bun.spawn`/VM sidecars (no in-process linking). Commercial-license-clean shippable path only.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[US#]**: the user story (from spec.md) a task serves; setup/foundational/polish carry no story label

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Create migration `server/migrations/0013_pr_review_connect.sql`: new `installations` and `review_suppressions` tables; `review_repos` +cols (`enabled`, `status_check_enabled`, `merge_block_on_critical`, `last_review_id`, `installation_row_id`); `review_findings` +cols (`verification_status` default `'unverified'`, `reachability_evidence_md`). Per data-model.md.
- [X] T002 Add matching Drizzle definitions in `server/src/db/schema.ts` (`installations`, `reviewSuppressions`, new columns + inferred row types), preserving PG-portable SQL.
- [X] T003 [P] Extend `server/src/config.ts` Zod env schema: confirm `GITHUB_APP_*` present; add `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID/SECRET`, and review tuning knobs (`STHRIP_REVIEW_CONFIDENCE_FLOOR`, `STHRIP_SUPPRESS_AFTER_N_IGNORES`, `STHRIP_OPENGREP_RULES_DIR`) each with safe `.default(...)`.
- [X] T004 [P] Add a license-audit script `server/scripts/license-audit.sh` (asserts no `gitnexus` in `server/src`; asserts Opengrep rules dir is AikidoSec-MIT/self-authored, not semgrep-registry/opengrep-rules) — wired into CI in T0xx polish.

**Checkpoint**: schema + config compile (`npx tsc --noEmit`), migration applies (`bun run migrate`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: blocks all user stories.

- [X] T005 Write failing tests for the installations repository/service in `server/src/review/service.test.ts` (create/upsert by `installationId`, map to `userId`, suspend/delete cascade-disables `review_repos`, signed audit emitted) — real in-memory SQLite + fake audit signer.
- [X] T006 Implement installations CRUD + cross-tenant-safe lookup in `server/src/review/service.ts` (`upsertInstallation`, `getInstallationByGithubId`, `getInstallationsForUser`, `markInstallationDeleted`) emitting `github_app_installed`/`_uninstalled`/`_suspended` via `emitSignedAudit`.
- [X] T007 [P] Extend `server/src/review/github/client.ts`: add `listInstallationRepos({installationId})` (paginated `GET /installation/repositories`) + `FakeGitHubClient` parity; unit test in `client.test.ts`.
- [X] T008 Extend webhook classifier `server/src/review/github/webhook.ts` `classifyWebhook()` to recognize `installation` (created/deleted/suspend/unsuspend) and `installation_repositories` (added/removed); failing tests in `webhook.test.ts` first.
- [X] T009 [P] Add new audit event names to the audit allowlist/types wherever events are enumerated (search `emitSignedAudit` usages / event union) so the new events validate.

**Checkpoint**: installation lifecycle persists + audits; foundation ready.

---

## Phase 3: User Story 1 — Connect GitHub & choose repositories (Priority: P1) 🎯 MVP

**Goal**: a user connects GitHub, sees accessible repos, selects coverage (all/subset) + per-repo branches, sees status; uninstall flips to "not connected".

**Independent Test**: complete connect against a test account; toggle a subset; reload → persisted; uninstall on GitHub → status "not connected".

### Tests (write first, must fail)

- [X] T010 [P] [US1] Contract tests for connect routes in `server/src/routes/github-connect.test.ts`: `GET /v1/github/connect` returns install_url+state; `GET /v1/github/callback` validates state + persists installation + 302; `GET /v1/github/installations`; `GET /v1/github/installations/{id}/repos`; `POST /v1/github/disconnect` (per contracts/openapi.yaml).
- [X] T011 [P] [US1] Webhook integration tests in `server/src/routes/review-webhook.test.ts`: `installation` created→upsert; deleted→disable repos; `installation_repositories` added (auto-enable when selection=all) / removed (disable). Cross-tenant: a delivery for another user's installation never mutates this user's repos.
- [X] T012 [P] [US1] Repo-settings test in `server/src/routes/review.test.ts`: `PATCH /v1/review/repos/{id}/settings` updates enabled/covered_branches/status_check/merge_block; rejects non-owner (403); Zod-bounds covered_branches.

### Implementation

- [X] T013 [US1] Implement `server/src/review/github/connect.ts`: build App install URL (slug + state nonce), validate callback `state`/`installation_id`/`setup_action`, mint installation token, fetch installation metadata, persist via service (T006), reconcile repos.
- [X] T014 [US1] Implement `server/src/routes/github-connect.ts` (Hono router factory `createGithubConnectRouter({db, auditKey, requireAuth, now})`): the 5 endpoints from openapi.yaml; Zod-validate all inputs; emit audits.
- [X] T015 [US1] Extend `server/src/routes/review.ts` with `PATCH /repos/:id/settings` (enable/disable + covered branches + status-check/merge-block), owner-scoped, audited (`review_repo_enabled/_disabled/_settings_changed`).
- [X] T016 [US1] Extend `server/src/routes/review-webhook.ts`: handle `installation` + `installation_repositories` events (dedup row in same tx; HMAC verified) calling service (T006); explicit `204` for ignored.
- [X] T017 [US1] Mount `createGithubConnectRouter` in `server/src/server.ts` under `/v1/github` (graceful-null when GitHub App creds absent, mirroring existing review mount); add dispatcher/audit wiring.
- [X] T018 [P] [US1] Frontend `apps/site/src/pages/ConnectGitHub.tsx`: "Connect GitHub" button → `GET /v1/github/connect` → redirect; callback landing reads status; shows connected/not-connected.
- [X] T019 [P] [US1] Frontend `apps/site/src/pages/Repositories.tsx`: list installation repos, toggle enabled (all/subset), edit covered branches, toggle status-check/merge-block, show per-repo last-review status.
- [X] T020 [US1] Extend `apps/site/src/lib/api-client.ts` with a `github`/`repos` namespace (connect, installations, repos, settings, disconnect) using snake_case wire types from openapi.yaml.
- [X] T021 [US1] Wire routes + nav in `apps/site/src/App.tsx` (+ AppShell nav entry) for Connect/Repositories; add RU+EN strings to `apps/site/src/i18n.ts` (no English terms in the RU dict; keep "Sthrip").

**Checkpoint**: US1 independently testable — connect → select persists → uninstall reconciles. **This is the MVP.**

---

## Phase 4: User Story 2 — Automatic deep review on every PR (Priority: P1)

**Goal**: PR on an enabled repo (covered branch) → inline comments + one edit-in-place summary with 0–5 score, within minutes; visible in dashboard.

**Independent Test**: pre-seed an enabled installation; open a PR with a known issue → inline + single summary w/ score; push follow-up → same summary updates (no duplicate).

### Tests (write first)

- [ ] T022 [P] [US2] Integration test in `server/src/review/engine.test.ts` (or `poster.test.ts`): PR-open → review produced; summary carries 0–5 + files/issues table + per-finding **severity + numeric confidence + reachability indicator**; re-run edits the SAME summary comment (FakeGitHubClient asserts single comment id).
- [ ] T023 [P] [US2] Test covered-branch gating + over-capacity transparent comment in `server/src/routes/review-webhook.test.ts`.

### Implementation

- [ ] T024 [US2] Extend `server/src/review/poster.ts` summary renderer to include a numeric confidence column + reachability indicator per finding (mapping from existing `confidence`/`cvssScore`/`reachable`), preserving edit-in-place (`<!-- sthrip:fp:* -->` markers).
- [ ] T025 [US2] Add over-capacity behaviour: when the job queue/limit is exceeded, post a transparent explanatory PR comment instead of skipping (in `server/src/jobs/handlers/pr-review.ts` + poster helper).
- [ ] T026 [P] [US2] Confirm/extend dashboard wiring: `apps/site/src/pages/Reviews.tsx` + `ReviewDetail.tsx` render the new confidence/reachability fields (wire types in api-client).

**Checkpoint**: US2 delivers a complete review on a real PR.

---

## Phase 5: User Story 3 — Verified, reachable, low-noise findings (Priority: P2)

**Goal**: only verified + reachable findings surface, each with confidence; FP rate materially below LLM-only; score stays deterministic.

**Independent Test**: run against a mixed benchmark (genuine reachable vulns + decoys) → genuine surface w/ reachability+confidence, decoys suppressed, FP ≥50% below LLM-only baseline.

### Tests (write first)

- [ ] T027 [P] [US3] `server/src/review/verify.test.ts`: a candidate with no SAST corroboration AND no reachability AND refuted PoC → `verification_status='unverified'`, NOT posted; a corroborated/ reachable one → `verified`, posted.
- [ ] T028 [P] [US3] `server/src/review/reachability/joern.test.ts`: fake Joern taint result populates `reachable`+`reachabilityEvidenceMd`; missing Joern binary → graceful labelled lower-confidence (no crash).
- [ ] T029 [P] [US3] `server/src/review/reviewer.test.ts`: self-challenge pass drops a low-confidence/refuted candidate; assert model never emits the 0–5 score (type-level + runtime).
- [ ] T030 [P] [US3] `server/src/review/context/treesitter.test.ts`: tree-sitter symbol graph extracts defs/refs/imports/calls for TS/JS/Py; PageRank ranks the diff neighbourhood; falls back to regex repomap on unknown languages.

### Implementation

- [ ] T031 [US3] Implement `server/src/review/verify.ts` — the verification gate (SAST-corroboration ∨ reachability-proven ∨ un-refuted PoC); writes `verification_status`; only `verified` reach the poster.
- [ ] T032 [US3] Implement `server/src/review/reachability/joern.ts` (+ `FakeJoernClient`): `Bun.spawn`/VM adapter producing taint paths → `reachable` + `reachabilityEvidenceMd`; graceful degrade when absent.
- [ ] T033 [US3] Extend `server/src/review/reviewer.ts` with a confidence-gated self-challenge step before emit (refute-then-keep); honour `STHRIP_REVIEW_CONFIDENCE_FLOOR`.
- [ ] T034 [US3] Implement `server/src/review/context/treesitter.ts` (web-tree-sitter symbol graph + ported aider-style PageRank) behind the existing `context/repomap` boundary; keep regex extractor as fallback. (MIT/Apache only.)
- [ ] T035 [P] [US3] Point SAST rules at `STHRIP_OPENGREP_RULES_DIR` (AikidoSec-MIT/self-authored) in `server/src/review/sast/runner.ts`; add Kingfisher/OSV-Scanner as optional sidecars; ensure SARIF→RawFinding normalization covers them.
- [ ] T036 [P] [US3] Add an FP-benchmark harness `server/src/review/__bench__/fp-benchmark.test.ts` (seeded reachable vulns + decoys) reporting FP rate vs an LLM-only baseline (SC-004).

**Checkpoint**: US3 — trustworthy findings; benchmark shows the FP reduction.

---

## Phase 6: User Story 4 — Control the review on the PR (Priority: P2)

**Goal**: `@sthrip review` re-trigger; optional merge-blocking `Sthrip N/5` check; auto-resolve on remediation; idempotent threads.

**Independent Test**: comment `@sthrip review` → fresh review (not while running); verified critical → check `failure` (blocks under branch protection); fix commit → thread resolves, check green.

### Tests (write first)

- [ ] T037 [P] [US4] `server/src/routes/review-webhook.test.ts`: `issue_comment` `@sthrip review` enqueues re-review; ignored when one is already running for that PR.
- [ ] T038 [P] [US4] `server/src/review/poster.test.ts`: check-run conclusion = `failure` iff `mergeBlockOnCritical` and a verified critical exists; otherwise `neutral/success` with score; `statusCheckEnabled=false` posts no check.
- [ ] T039 [P] [US4] `server/src/review/poster.test.ts`: remediated finding → thread auto-resolved next cycle; unchanged finding → single thread (idempotent, no duplicate).

### Implementation

- [ ] T040 [US4] Implement `issue_comment` (`@sthrip review`) handling in `server/src/review/github/webhook.ts` + `server/src/routes/review-webhook.ts` (replace the existing `comment_trigger_not_supported_yet` 202), with concurrency guard `(repoId, prNumber, running)`.
- [ ] T041 [US4] Extend `server/src/review/poster.ts` check-run logic: `Sthrip N/5` conclusion honouring `statusCheckEnabled`/`mergeBlockOnCritical` (+ verified-critical detection).
- [ ] T042 [US4] Implement remediation detection + auto-resolve in `poster.ts`/`service.ts` (fingerprint absent in new cycle → `resolveReviewThread` GraphQL + mark `review_findings.lifecycle_state='resolved'`).

**Checkpoint**: US4 — review safe to gate merges on.

---

## Phase 7: User Story 5 — Learning loop from team feedback (Priority: P3)

**Goal**: suppress repeatedly-dismissed nit categories per repo; never suppress security/correctness; honour `.sthrip/rules.md`.

**Independent Test**: ignore a nit category N times → suppressed; security still posts; rules file changes subsequent reviews.

### Tests (write first)

- [ ] T043 [P] [US5] `server/src/review/learning.test.ts`: N ignores of a `style`/`nit` category → `review_suppressions` row → category not posted; `security`/`correctness` never suppressed regardless of dismissals.
- [ ] T044 [P] [US5] `server/src/review/learning.test.ts`: `.sthrip/rules.md` ignored-paths/trusted-sources applied at review time (size-capped fetch).

### Implementation

- [ ] T045 [US5] Implement `server/src/review/learning.ts`: derive suppressions from `review_feedback` (signals + first-vs-last-commit of merged PRs), write/read `review_suppressions`, enforce the never-suppress-security invariant; audit `review_category_suppressed`.
- [ ] T046 [US5] Wire suppression + `rules.md` application into `server/src/review/engine.ts`/`reviewer.ts` filtering; fetch `.sthrip/rules.md` on review (cache to `review_repos.rulesMd`, ≤64KB).

**Checkpoint**: US5 — noise drops over time, safely.

---

## Phase 8: User Story 6 — Developer assistant skills (Priority: P2)

**Goal**: `sthrip-loop` (to 5/5 ≤5 iters) + `sthrip-check-pr`, mirroring `greptileai/skills`, fixer-agnostic, branded Sthrip.

**Independent Test**: `sthrip-loop` drives a seeded vulnerable PR to 5/5 in ≤5 iterations; `sthrip-check-pr` categorizes mixed comments correctly.

### Implementation

- [ ] T047 [P] [US6] Rename skill dir `.claude/skills/tensol-loop` → `.claude/skills/sthrip-loop`; update `SKILL.md` (name/description/branding "Sthrip", `@sthrip review` trigger), `scripts/review.sh`, `references/api.md` (new endpoints), add `references/graphql-queries.md`.
- [ ] T048 [P] [US6] Create `.claude/skills/sthrip-check-pr/SKILL.md` (port greptile check-pr: detect platform; fetch comments/checks/description; categorize actionable vs informational; resolve addressed threads) + `references/graphql-queries.md` + `references/gitlab-api.md`.
- [ ] T049 [US6] In both skills, implement the **read-latest-summary-by-`updated_at`** rule (edit-in-place gotcha) and GitHub/GitLab/Perforce auto-detect; document multi-platform usage in a skills `README.md`.
- [ ] T050 [US6] Update any references to `tensol-loop` (memory/docs/CLAUDE skill list) → `sthrip-loop`; verify host-agent install via symlink (quickstart §5).

**Checkpoint**: US6 — loop-until-5/5 works on the seeded repo.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T051 [P] Wire `server/scripts/license-audit.sh` into CI (fail on AGPL/BSL/SSPL/Elastic/Commons-Clause/PolyForm-NC in shippable path; assert no `gitnexus` in `server/src`; assert Opengrep rules source) — SC-008.
- [ ] T052 Run full regression: `cd server && bun test src/` (expect prior 1078+ pass / 0 fail + new tests), `npx tsc --noEmit` 0; `cd apps/site && npx tsc -b` 0 + Playwright `connect-select` E2E green.
- [ ] T053 [P] Verify all new state changes emit signed audit (Constitution X) and run `verify-audit-chain` against the test DB (CI gate).
- [ ] T054 [P] Branding/i18n sweep: user-facing strings say "Sthrip"; no English terms in the RU i18n dict; check-run title `Sthrip N/5`.
- [ ] T055 [P] Reindex GitNexus (`npx gitnexus analyze`, add `--embeddings` only if `.gitnexus/meta.json` stats.embeddings>0) after merge; update `docs/` with the connect-flow + skills usage.
- [ ] T056 Run `quickstart.md` end-to-end against a dev GitHub App; confirm SC-001…SC-009.

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → **Phase 2 (Foundational)** block everything.
- **US1 (P1)** depends on Foundational. **US2 (P1)** depends on US1 (needs an enabled repo) — or a seeded installation for isolated testing.
- **US3 (P2)**, **US4 (P2)** depend on US2's pipeline; US3 and US4 are largely independent of each other (different modules: `verify.ts`/`reachability/`/`reviewer.ts` vs `poster.ts` check-run/`webhook.ts` trigger) → can proceed in parallel after US2.
- **US5 (P3)** depends on US2 (feedback + engine filtering).
- **US6 (P2)** depends only on the review API existing (US2) → can run in parallel with US3/US4/US5.
- **Polish** last.

### Parallel opportunities

- Setup: T003, T004 [P].
- Foundational: T007, T009 [P] (after T005/T006 land the schema/service).
- US1: tests T010–T012 [P]; frontend T018–T019 [P] (after backend routes exist).
- US3: tests T027–T030 [P]; impl T035, T036 [P].
- US4: tests T037–T039 [P].
- US6: T047, T048 [P] (independent of backend) — can start anytime after Setup.
- Polish: T051, T053, T054, T055 [P].

## Implementation Strategy

- **MVP = Phase 1 + Phase 2 + Phase 3 (US1)** — a user can connect GitHub and select repositories; combined with the already-shipped engine + a seeded enable, reviews already post. Ship this first.
- **Increment 2 = US2 + US3** — complete, *trustworthy* review delivery (the competitive wedge).
- **Increment 3 = US4 + US6** — merge-gating + developer loop skills (adoption).
- **Increment 4 = US5** — learning loop (retention).
- Each phase ends at an independently testable checkpoint; do not start a phase's implementation tasks before its failing tests exist (Constitution VI).

## Task count

- Setup: 4 · Foundational: 5 · US1: 12 · US2: 5 · US3: 10 · US4: 6 · US5: 4 · US6: 4 · Polish: 6 → **56 tasks**.
