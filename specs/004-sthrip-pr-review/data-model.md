# Data Model — Sthrip PR Review (Phase 1)

Migration: **`server/migrations/0013_pr_review_connect.sql`** (+ matching Drizzle defs in `server/src/db/schema.ts`). SQLite, integer epoch timestamps, `text` PKs (ULID). Avoid SQLite-only constructs (PG upgrade path, Constitution).

Legend: **EXISTING** = already shipped (migration 0012), shown for reference; **NEW** = added by this feature; **+col** = new column on an existing table.

---

## EXISTING (reference — do not recreate)

- **`review_repos`** — `id, userId, scm, installationId?, owner, name, defaultBranch, coveredBranchesJson, rulesMd?, status(active|paused|revoked), createdAt, updatedAt`. Unique `(scm,owner,name,userId)`. → already models repo selection, covered branches, and the `.sthrip/rules.md` cache (`rulesMd`).
- **`reviews`** — `id, repoId?, userId?, kind(pr|whitebox), prNumber?, headSha?, baseSha?, commitRef?, status(queued|running|completed|failed|cancelled), score0to5?, summaryMd?, githubReviewId?, findingsCount, startedAt?, completedAt?, error?, timestamps`.
- **`review_findings`** — `id, reviewId, fingerprint, filePath, startLine?, endLine?, side(LEFT|RIGHT), severity, cweJson, cvssVector?, cvssScore?, confidence(verified|high|medium|low)?, reachable?(int), category?, title, rationaleMd, pocMd?, fixPromptMd?, source(llm|sast|secrets|sca), lifecycleState(open|resolved|suppressed), createdAt`.
- **`review_threads`** — `id, reviewId, repoId?, fingerprint, githubThreadId?, githubCommentId?, isResolved(int), timestamps`. → already powers dedup + auto-resolve threading.
- **`review_feedback`** — `id, repoId, fingerprint?, signal(up|down|addressed|ignored), commentText?, embeddingJson?, createdAt`. → already captures triage signal for the learning loop.

These cover much of US1–US5 already. The gaps below are what this feature adds.

---

## NEW entity: `installations`

First-class GitHub-App installation, decoupled from individual repos (the connect-flow anchor + the authorization root).

| Field | Type | Notes |
|---|---|---|
| `id` | text PK | ULID |
| `userId` | text → users.id (cascade) | the Sthrip account that connected (one user = one org) |
| `scm` | text | `github` (default); reserved for future |
| `installationId` | text | GitHub numeric installation id (string) — **authorization key for webhooks** |
| `accountLogin` | text | GitHub org/user login the app is installed on |
| `accountType` | text | `User` \| `Organization` |
| `repositorySelection` | text | `all` \| `selected` (GitHub's own setting) |
| `status` | text | `active` \| `suspended` \| `deleted` |
| `setupAction` | text? | last `setup_action` seen (`install`/`update`) |
| `createdAt` / `updatedAt` | integer | |

Indexes: unique(`scm`,`installationId`); index(`userId`). **Rule**: webhook deliveries resolve the owning account via `installationId` → `installations.userId`; repo slug alone never authorizes.

State transitions: `active → suspended` (GitHub suspend) → `active` (unsuspend); `* → deleted` (uninstall: cascade-disable the installation's `review_repos`).

---

## NEW columns on `review_repos` (+col)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | integer (bool) | `1` | explicit enable/disable independent of `status` (US1 toggle) |
| `statusCheckEnabled` | integer (bool) | `1` | post the `Sthrip N/5` check-run (FR-014) |
| `mergeBlockOnCritical` | integer (bool) | `0` | check-run conclusion = `failure` when a verified critical exists (FR-014) |
| `lastReviewId` | text? → reviews.id | null | for the per-repo "last-review status" column (FR-007) |
| `installationRowId` | text? → installations.id | null | link to the new installations entity (the existing `installationId` string stays for compatibility) |

(`coveredBranchesJson` + `rulesMd` already exist → FR-005/FR-006 need no new columns.)

---

## NEW column on `review_findings` (+col)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `verificationStatus` | text | `unverified` | `verified` \| `unverified` \| `refuted`. **Only `verified` findings are posted** (FR-018). Set by `verify.ts` from SAST-corroboration / reachability / un-refuted-PoC. |
| `reachabilityEvidenceMd` | text? | null | the taint path / why-reachable evidence (FR-019/020), distinct from `rationaleMd`. |

(`confidence`, `reachable`, `severity`, `cvss*` already exist → FR-019 numeric-confidence is surfaced by mapping `confidence`+`cvssScore`; no schema change needed beyond the two above.)

---

## NEW entity: `review_suppressions`

Derived suppression decisions for the learning loop (FR-023/024). Computed from `review_feedback`; cached here so reviews are fast and deterministic.

| Field | Type | Notes |
|---|---|---|
| `id` | text PK | ULID |
| `repoId` | text → review_repos.id (cascade) | scope = per repo |
| `category` | text | the finding category being suppressed (e.g. `style`, `nit`) |
| `reason` | text | `ignored_n_times` \| `manual` |
| `ignoreCount` | integer | running count that triggered suppression |
| `createdAt` / `updatedAt` | integer | |

Indexes: unique(`repoId`,`category`); index(`repoId`). **Invariant** (enforced in code, FR-024): rows whose `category ∈ {security, correctness, …}` are never written — suppression applies to style/nit classes only.

---

## Audit events (Constitution X) — emitted via `emitSignedAudit`

New state-changing events this feature must log: `github_app_installed`, `github_app_uninstalled`, `github_app_suspended`, `review_repo_enabled`, `review_repo_disabled`, `review_settings_changed`, `review_finding_verified`, `review_thread_resolved`, `review_category_suppressed`. (Existing `review`/`scan` events unchanged.)

---

## Relationships (summary)

```
users 1───* installations 1───* review_repos 1───* reviews 1───* review_findings
                                   │                   │
                                   │                   └──* review_threads (by fingerprint)
                                   └──* review_feedback ──(derive)──> review_suppressions
```

## Validation rules (Zod, at boundaries — Constitution IX)

- Connect callback: `installation_id` (numeric string, required), `setup_action ∈ {install, update}`, `state` (CSRF nonce) validated before persistence.
- Repo-management body: `enabled: boolean`, `coveredBranches: string[]` (≤ 50, each ≤ 255 chars), `statusCheckEnabled/mergeBlockOnCritical: boolean` — bounded.
- Webhook payloads: each new event variant Zod-validated before processing; HMAC raw-body verify + `webhook_dedup` idempotency (existing) before any write.
- `.sthrip/rules.md`: size-capped (e.g. ≤ 64 KB) on fetch; treated as untrusted text.
