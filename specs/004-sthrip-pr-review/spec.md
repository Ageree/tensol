# Feature Specification: Sthrip PR Review — Connect, Select Repositories & Deep Automated Review

**Feature Branch**: `004-sthrip-pr-review`

**Created**: 2026-05-29

**Status**: Draft

**Input**: User description: "Создать как у hacktron приложение автоматической проверки PR … github app чтобы пользователь мог подключить github и потом выбрать репозитории и по ним бы анализировались pr … найти опенсорсные решения для сканирования и индексирования кодовой базы … сделать скилл как у greptile (subagent подход)."

## Context & Boundary

The core review **engine already exists and is in production** (it can fetch a pull request, gather code context, run static-analysis scanners, ask a language model for findings, compute a deterministic 0–5 score, and post results to a code-hosting platform). This feature does **not** re-specify that engine. It specifies the **product surface and trust upgrades** that turn the engine into a self-serve product comparable to Hacktron / CodeRabbit / Greptile:

1. the self-serve **connect-and-select** onboarding a customer needs before any review can run;
2. the **completeness and trustworthiness** of what gets posted back on a pull request;
3. a hard **commercial-licensing** constraint that removes a non-shippable dependency currently in the engine; and
4. **developer-side assistant skills** that drive a pull request to a perfect score.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect GitHub and choose which repositories are reviewed (Priority: P1)

A developer or team lead signs in to Sthrip, clicks **Connect GitHub**, installs the Sthrip application on their GitHub account or organization, and is returned to Sthrip. They see the list of repositories the installation can access and choose which ones Sthrip should review — either *all repositories* or a *specific subset*. They can change this selection at any time and see, per repository, whether it is enabled and when it was last reviewed.

**Why this priority**: Nothing else in the product is reachable without it. This is the gateway that converts a visitor into an active account, and it is the single largest gap versus competitors today (the engine works, but there is no way for a customer to self-serve connect and pick repositories).

**Independent Test**: With no prior connection, complete the connect flow against a test GitHub account, confirm the accessible repositories appear, toggle a subset on, reload, and confirm the selection persisted and the connection status reads "connected". Removing the application on GitHub's side flips Sthrip's status back to "not connected".

**Acceptance Scenarios**:

1. **Given** a signed-in user with no GitHub connection, **When** they click Connect GitHub and complete the installation, **Then** they are returned to Sthrip showing "connected" and a list of accessible repositories.
2. **Given** a connected user, **When** they enable a specific subset of repositories and save, **Then** only those repositories are marked enabled and the choice survives a page reload.
3. **Given** a connected user who chose "all repositories", **When** a new repository later becomes accessible to the installation, **Then** it is automatically included as enabled without further action.
4. **Given** a connected user, **When** the application is uninstalled on GitHub, **Then** Sthrip reflects "not connected" and stops attempting reviews on those repositories.
5. **Given** a connected user, **When** they open the repository list, **Then** each enabled repository shows its last-review status (e.g. never / in progress / score / failed).

---

### User Story 2 - Automatic deep review appears on every pull request (Priority: P1)

Once a repository is enabled, every pull request opened or updated against a covered target branch is automatically reviewed. Within minutes the pull request shows **inline comments on the exact vulnerable lines** plus a **single summary comment** carrying a **0–5 confidence score**, a changed-files / issues overview, and per-finding detail. The summary comment is **edited in place** on each subsequent review cycle rather than spamming new comments. The same review history is visible inside the Sthrip dashboard.

**Why this priority**: This is the core value the customer is paying for. Connect-and-select (US1) only has value because this delivers a review.

**Independent Test**: On a repository with a pre-seeded enabled installation, open a pull request that introduces a known issue against a covered branch; confirm inline comment(s) on the right lines and one summary comment with a 0–5 score arrive within the target time, and that pushing a follow-up commit updates the *same* summary comment instead of adding a second.

**Acceptance Scenarios**:

1. **Given** an enabled repository, **When** a pull request is opened against a covered target branch, **Then** a review is produced and posted as inline comments plus one summary comment with a 0–5 score.
2. **Given** a pull request that was already reviewed, **When** a new commit is pushed, **Then** the existing summary comment is updated in place and only newly-relevant inline comments are added (no duplicate threads).
3. **Given** a pull request against a branch that is **not** covered for that repository, **When** it is opened, **Then** no review is posted.
4. **Given** a posted review, **When** the user opens the Sthrip dashboard, **Then** the same review and its findings are listed with their score and status.
5. **Given** the service is temporarily over capacity, **When** a pull request would otherwise be reviewed, **Then** the pull request receives a transparent comment explaining the delay rather than being silently skipped.

---

### User Story 3 - Findings I can trust: verified, reachable, low-noise (Priority: P2)

Every finding that reaches the developer has cleared a quality bar that the market leaders do not fully meet: it has **passed an automated verification step** (it is corroborated by deterministic analysis and/or accompanied by reproduction/exploit-path evidence), it carries an explicit **reachability/exploitability indicator** (the dangerous code is shown to be reachable from untrusted input, not merely pattern-matched), and it carries a **numeric confidence** alongside its severity. Candidate findings that fail verification or are low-confidence are **suppressed before posting**. The overall 0–5 score is computed deterministically and can never be inflated by the language model.

**Why this priority**: Trust is the entire competitive wedge. Competitors are criticised for high false-positive / "nit" noise (one is reported at ~60% noise, with visible hallucinations). A verified-and-reachable-only stream is what makes the product credible and is the headline differentiator.

**Independent Test**: Run the reviewer against a benchmark repository containing both genuine reachable vulnerabilities and plausible-but-unreachable/decoy patterns; confirm genuine reachable issues surface with a reachability indicator and a confidence value, and that the decoys are suppressed; confirm the false-positive rate is materially below an LLM-only baseline on the same set.

**Acceptance Scenarios**:

1. **Given** a candidate finding that fails the verification step, **When** the review is assembled, **Then** that finding is not posted to the pull request.
2. **Given** a genuine vulnerability where untrusted input reaches a dangerous sink, **When** it is reported, **Then** the finding carries a reachability/exploitability indicator and a numeric confidence value in addition to its severity.
3. **Given** a pattern match that is provably not reachable from untrusted input, **When** the review runs, **Then** it is down-ranked or suppressed rather than posted at full severity.
4. **Given** any posted review, **When** the 0–5 score is computed, **Then** it is derived deterministically from finding severity/confidence/reachability and is not a number chosen by the language model.

---

### User Story 4 - Control the review on the pull request (Priority: P2)

A developer can **re-trigger a review** by commenting `@sthrip review` on the pull request. A maintainer can optionally configure a **status check** (`Sthrip N/5`) that can be made a **required, merge-blocking** check when a verified critical-severity finding is present. When a later commit **remediates** a finding, Sthrip detects the fix and **resolves the corresponding thread automatically**. Re-posting is idempotent: the same finding is never threaded twice.

**Why this priority**: These controls make the review safe to put in the critical path of merging. The merge-blocking required check is a concrete capability the closest competitor (Hacktron) does not document — a differentiator — and auto-resolution keeps the pull request clean.

**Independent Test**: Comment `@sthrip review` and confirm a fresh review runs; introduce a verified critical finding and confirm the status check reports failing and can block merge under branch protection; push a commit that fixes the issue and confirm the thread resolves automatically and the status check turns green.

**Acceptance Scenarios**:

1. **Given** a pull request on an enabled repository, **When** a user comments `@sthrip review`, **Then** a new review cycle runs (unless one is already running).
2. **Given** the status check is enabled and a verified critical finding exists, **When** branch protection requires the Sthrip check, **Then** merge is blocked until the finding is resolved or accepted.
3. **Given** an open finding, **When** a subsequent commit removes the vulnerable data-flow, **Then** the finding's thread is resolved automatically on the next cycle.
4. **Given** repeated review cycles, **When** the same unresolved finding persists, **Then** it remains a single thread and is not duplicated.

---

### User Story 5 - Reviews get smarter from team feedback (Priority: P3)

Sthrip learns from how a team triages its comments. When developers repeatedly dismiss a particular **style/nit** category (via 👍/👎 reactions or by ignoring it across merged pull requests), Sthrip **suppresses that category** for the repository. It **never** suppresses security- or correctness-class findings, no matter how often they are dismissed. Team-specific guidance committed to the repository (a version-controlled rules file) is honoured automatically.

**Why this priority**: A learning loop materially reduces long-run noise and is a retention feature, but the product is valuable and shippable without it; hence lower priority than the trust mechanics that gate every finding from day one.

**Independent Test**: Repeatedly dismiss a nit category across reviews and confirm it stops being posted for that repository; confirm a security finding continues to be posted even after repeated dismissals; add a rules file to the repository and confirm its guidance changes subsequent reviews.

**Acceptance Scenarios**:

1. **Given** a style/nit category dismissed N times on a repository, **When** the next review runs, **Then** that category is no longer posted for that repository.
2. **Given** a security/correctness finding dismissed repeatedly, **When** the next review runs, **Then** the finding is still posted.
3. **Given** a repository containing a Sthrip rules file describing trusted sources and ignored paths, **When** a review runs, **Then** those instructions are applied (e.g. flagged paths are not reported).

---

### User Story 6 - Developer assistant skills drive a PR to a clean review (Priority: P2)

A developer using an AI coding assistant can invoke two Sthrip skills locally: **`sthrip-loop`** runs a bounded loop that triggers a Sthrip review, applies fixes for actionable findings, and re-reviews until the pull request reaches **5/5 with zero unresolved comments** (or a 5-iteration cap), and **`sthrip-check-pr`** inspects a pull request for unresolved review comments, failing checks, and an incomplete description, then categorises them as actionable vs. informational and helps resolve them. Both skills auto-detect the hosting platform and let the host agent perform the actual edits (fixer-agnostic).

**Why this priority**: This is the "subagent approach" the customer explicitly asked for and mirrors the competitor's published skills. It drives adoption and the "loop until perfect" experience, but depends on the review API (US2/US3) existing first.

**Independent Test**: On a seeded vulnerable repository, run `sthrip-loop` and confirm it drives the pull request to 5/5 within at most 5 iterations, resolving threads as it goes; run `sthrip-check-pr` on a pull request with mixed comments and confirm it correctly separates actionable from informational items.

**Acceptance Scenarios**:

1. **Given** a pull request scoring below 5/5, **When** `sthrip-loop` runs, **Then** it iterates trigger→fix→re-review and stops at 5/5 with zero unresolved comments or after 5 iterations, reporting the final state.
2. **Given** the review summary comment is edited in place across cycles, **When** a skill reads the score, **Then** it uses the most-recently-updated summary (not the most-recently-created comment).
3. **Given** a pull request with a mix of actionable and informational comments, **When** `sthrip-check-pr` runs, **Then** it produces a categorised report and can resolve addressed threads.
4. **Given** every remaining finding is judged a false positive, **When** the loop cannot improve the score, **Then** it records that feedback and stops instead of looping indefinitely.

---

### Edge Cases

- **Installation drift**: repositories added/removed on GitHub's side after connect must reconcile with Sthrip's enabled set (added repos honour the "all" choice; removed repos stop being reviewed).
- **Cross-tenant safety**: a webhook delivery must only be matched to the account that owns that installation; a repository slug alone must never authorise a review for a different account.
- **Large monorepo**: a repository too large to fully index must still produce a review for the changed files within the time budget (incremental, change-scoped context).
- **Re-delivered / duplicate webhooks**: a repeated delivery must not create a second review or duplicate comments.
- **Pull request with no analysable change** (docs-only, generated files, vendored paths): produce a clean result rather than spurious findings.
- **Forked-PR / limited-token permissions**: degrade gracefully (post what is permitted; never crash the cycle).
- **Verification engine unavailable for a language**: fall back to a clearly-labelled lower-confidence result rather than emitting unverified findings as if verified.
- **Comment trigger spam / loops**: `@sthrip review` while a review is already running must not start a second concurrent review.

## Requirements *(mandatory)*

### Functional Requirements

**Connection & repository management**

- **FR-001**: Users MUST be able to initiate a GitHub connection from Sthrip and complete installation/authorisation without leaving the guided flow.
- **FR-002**: System MUST persist the resulting installation and associate it with the connecting Sthrip account, and MUST surface a clear connected / not-connected status.
- **FR-003**: Users MUST be able to view all repositories the installation can access and select coverage as either "all repositories" or a specific subset, and change it later.
- **FR-004**: System MUST react to repositories being added to or removed from the installation and reconcile them with the user's coverage choice.
- **FR-005**: Users MUST be able to configure, per repository, which target branch(es) are covered.
- **FR-006**: System MUST honour a version-controlled rules file located in the customer repository that can declare auth patterns, trusted sources, and ignored paths.
- **FR-007**: System MUST display, per enabled repository, its most recent review status.
- **FR-008**: System MUST stop reviewing repositories once the installation is uninstalled or the repository is disabled.

**Review trigger & delivery**

- **FR-009**: System MUST automatically review a pull request when it is opened or updated against a covered target branch on an enabled repository.
- **FR-010**: System MUST allow a review to be re-triggered by an `@sthrip review` comment, and MUST NOT start a second review while one is already running for that pull request.
- **FR-011**: System MUST post findings as inline comments on the relevant lines and as a single summary comment that is updated in place across review cycles.
- **FR-012**: The summary comment MUST carry the 0–5 score, a changed-files / issues overview, and per-finding detail.
- **FR-013**: System MUST be idempotent across cycles and re-deliveries: the same unresolved finding is a single thread and is never duplicated.
- **FR-014**: System MUST optionally expose a status check (`Sthrip N/5`) that can be configured as a required, merge-blocking check when a verified critical-severity finding is present.
- **FR-015**: System MUST detect when a later commit remediates a finding and resolve that finding's thread automatically.
- **FR-016**: System MUST make the same reviews and findings visible in the Sthrip dashboard.
- **FR-017**: When over capacity, System MUST post a transparent explanation on the pull request rather than silently skipping it.

**Finding quality & trust**

- **FR-018**: System MUST suppress any candidate finding that does not pass an automated verification step before it is posted.
- **FR-019**: Each posted finding MUST carry a severity, a numeric confidence, and a reachability/exploitability indicator.
- **FR-020**: System MUST down-rank or suppress findings that cannot be shown reachable from untrusted input.
- **FR-021**: The reviewer MUST challenge its own hypotheses and drop low-confidence candidates before posting.
- **FR-022**: The overall 0–5 score MUST be computed deterministically from finding attributes and MUST NOT be a value chosen by the language model.

**Learning**

- **FR-023**: System MUST learn from triage signals (reactions and dismiss-across-merged-PRs) and suppress a repeatedly-dismissed style/nit category for that repository.
- **FR-024**: System MUST NEVER suppress security- or correctness-class findings on the basis of dismissals.

**Commercial-licensing safety (cross-cutting hard constraint)**

- **FR-025**: The shippable product path MUST NOT include any component whose licence forbids use in a paid, closed-source, competing service (specifically: no copyleft network-clause, no source-available "no competing / no hosted service" clause, no non-commercial-only licence, and no bundled rule-content carrying a "no sell" clause).
- **FR-026**: The current code-context/indexing dependency that carries a non-commercial-only licence MUST be replaced with a commercially-licensable alternative before launch; the change MUST preserve the call-graph / blast-radius capability the engine relies on.
- **FR-027**: Static-analysis rule content that is shipped or invoked MUST be limited to permissively-licensed or self-authored rules; rule sets carrying competing-SaaS or "no sell" restrictions MUST NOT be shipped or invoked.
- **FR-028**: Third-party analysers MUST be integrated as isolated subprocess sidecars (no in-process linking) so that their licences impose no obligation on Sthrip's own code, and their outputs MUST be normalised to a common finding format.

**Developer assistant skills**

- **FR-029**: System MUST provide a `sthrip-loop` skill that drives a pull request to 5/5 with zero unresolved comments within at most 5 iterations, leaving edits to the host agent.
- **FR-030**: System MUST provide a `sthrip-check-pr` skill that categorises a pull request's review comments, failing checks, and description gaps as actionable vs. informational and can resolve addressed threads.
- **FR-031**: Both skills MUST read the most-recently-updated summary comment (because the review summary is edited in place) and MUST auto-detect the hosting platform.
- **FR-032**: Both skills MUST carry Sthrip branding (replacing the prior `tensol-loop` naming) and be installable into a host agent's skill directory.

### Key Entities *(include if feature involves data)*

- **Connection / Installation**: the link between a Sthrip account and a GitHub application installation; holds the installation identifier, owner account, and account-scoping used to authorise webhook deliveries.
- **Repository**: a code repository accessible to an installation; attributes include enabled/disabled state, covered target branches, owning account, and last-review status.
- **Review**: one review cycle for a pull request; attributes include the pull request reference, head commit, computed 0–5 score, status, and timing.
- **Finding**: one issue in a review; attributes include location (file/line), category, severity, numeric confidence, reachability/exploitability indicator, verification outcome, stable fingerprint (for idempotent threading), and remediation/thread state.
- **Triage signal**: a feedback record (reaction, dismissal, accepted-risk) used by the learning loop, scoped to a repository and finding category.
- **Repository rules file**: customer-authored, version-controlled guidance (auth patterns, trusted sources, ignored paths) honoured at review time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can connect GitHub and select repositories in **under 2 minutes** end-to-end.
- **SC-002**: A pull request opened on an enabled repository receives an inline-plus-summary review with a 0–5 score within a **few minutes** of opening (target: ≤ 5 minutes for a typical change).
- **SC-003**: **100%** of surfaced findings carry severity, a numeric confidence, and a reachability indicator, and have passed the verification gate.
- **SC-004**: On a mixed benchmark of genuine reachable vulnerabilities and decoys, the **false-positive rate is materially lower than an LLM-only reviewer** on the same set (target: a measurable, reported reduction, e.g. ≥ 50% fewer false positives).
- **SC-005**: Across repeated review cycles on the same pull request, **zero duplicate threads** are created for an unchanged unresolved finding.
- **SC-006**: A remediating commit results in automatic thread resolution on the **next** cycle in **≥ 95%** of cases.
- **SC-007**: The `sthrip-loop` skill drives a seeded vulnerable pull request to **5/5 within ≤ 5 iterations**.
- **SC-008**: The shippable dependency set contains **zero** components under non-commercial / no-competing-service / no-sell licences (auditable list), and the non-commercial context dependency is removed.
- **SC-009**: The connect flow correctly reflects disconnection within one reconciliation cycle when the application is uninstalled (no orphaned reviews attempted).

## Assumptions

- **Account model**: an installation maps to the **individual connecting account** (the current per-account ownership model is reused). Multi-member organisations with role-based access and shared seats are **out of scope** for this feature and deferred.
- **Hosting platform**: **GitHub is the only platform with backend review ingestion** in this feature. The developer skills may auto-detect GitLab/Perforce, but server-side webhook ingestion for those platforms is out of scope here.
- **Existing engine reused**: the pull-request fetch, context gathering, scanner orchestration, language-model call, deterministic scorer, and posting already exist and are extended — not rebuilt.
- **Heavy analysis isolation**: deeper analysis that is resource-intensive may run on the existing isolated ephemeral-compute rail rather than inline; either way the user-facing time budget in SC-002 holds for typical changes.
- **No training on customer code**: customer source is used only to produce that customer's reviews and is never used to train shared models.
- **Branding**: all user-facing text says "Sthrip"; internal identifiers/markers may retain legacy names where changing them is purely cosmetic and risk-bearing.
- **Out of scope** (restated): the autonomous Whitebox pentest product (separate spec `003-whitebox`), live/dynamic blackbox scanning of running target URLs, billing/seats/payments, and IDE extensions.
- **Dependency**: requires an operational Sthrip GitHub application registration (app id, private key, webhook secret) in the deployment environment.
