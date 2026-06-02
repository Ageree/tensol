# GitHub Webhook Contract — NEW event variants (feature 004)

All deliveries hit the **existing** endpoint `POST /v1/review/github/webhook`. Every delivery is HMAC-verified against the raw body (`X-Hub-Signature-256`) and de-duplicated via the existing `webhook_dedup` table **inside the same transaction** as any resulting write (no stranded deliveries), before any processing — per Constitution IX and prior hardening. `classifyWebhook()` in `review/github/webhook.ts` is extended to recognize the new event types below; unknown events return `204` (acknowledged, ignored).

The **authorization root is `installation.id`** carried in every payload — a delivery is matched to the owning Sthrip user via `installations.installationId → installations.userId`. A repository slug alone NEVER authorizes a review (closes the cross-tenant takeover class).

| `X-GitHub-Event` | action(s) | Handling |
|---|---|---|
| `installation` | `created` | Upsert `installations` row for the user resolved from the connect-flow `state`/token; set `status=active`; reconcile accessible repos (honour `repository_selection`). Audit `github_app_installed`. → `202`. |
| `installation` | `deleted` | Mark installation `deleted`; cascade-disable its `review_repos` (`enabled=0`, `status=revoked`); stop reviewing. Audit `github_app_uninstalled`. → `202`. |
| `installation` | `suspend` / `unsuspend` | Toggle `status` suspended/active; suspended installs are not reviewed. Audit `github_app_suspended`. → `202`. |
| `installation_repositories` | `added` | For each added repo: if `repository_selection=all`, auto-enable; else create as disabled. Audit `review_repo_enabled` per auto-enabled repo. → `202`. |
| `installation_repositories` | `removed` | Disable/forget removed repos. → `202`. |
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | **EXISTING** path: enqueue a `pr_review` job iff the repo is `enabled` and the PR targets a covered branch; otherwise `204` (no-op). |
| `issue_comment` | `created` | If `issue.pull_request` present and body matches `@sthrip review` (case-insensitive, trimmed) on an enabled repo: enqueue a re-review **unless one is already running** for that PR (dedupe by `(repoId, prNumber, running)`). Otherwise `204`. Currently the engine returns an explicit `comment_trigger_not_supported_yet` 202 — this feature implements it. |
| `check_run` / `check_suite` | `rerequested` | Optional: treat a re-request of the `Sthrip N/5` check as a re-review trigger (same guard as the comment trigger). → `202`/`204`. |

## Delivery → review lifecycle (recap, mostly existing)

1. PR event (or `@sthrip review`) on an `enabled` repo targeting a covered branch → enqueue `pr_review` job (idempotent on `(repoId, prNumber, headSha)`).
2. Job: fetch diff + build context (tree-sitter symbol graph) → run SAST sidecars (SARIF→RawFinding) → reachability (Joern) → reviewer (decomposed CVSS + reachability + confidence, with self-challenge) → **`verify.ts` gate drops `unverified`** → `score.ts` computes 0–5 deterministically → persist findings + threads.
3. Post: inline comments on verified findings + one **edit-in-place** summary comment (0–5 score, files/issues table, per-finding severity + numeric confidence + reachability indicator) + optional `Sthrip N/5` check-run (`failure` if `mergeBlockOnCritical` and a verified critical exists). Dedup via `review_threads` fingerprint map; auto-resolve threads whose finding is remediated.
4. Audit each state change; reflect in dashboard.

## Idempotency & safety invariants

- Re-delivered webhook (same `X-GitHub-Delivery`) → no second review, no duplicate comments.
- Comment trigger while a review is running → ignored (no concurrent reviews for one PR).
- Forked-PR / reduced token scope → post what is permitted; never crash the cycle.
- Over-capacity → transparent explanatory PR comment instead of silent skip.
