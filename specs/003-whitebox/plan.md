# 003-whitebox — Implementation Plan

Autonomous whitebox security testing (Hacktron competitor). Research: `docs/research/2026-05-29-hacktron-whitebox-dossier.md`.

## Two sub-products, one engine
- **PR Review** — GitHub App; reviews each PR with whole-repo context; posts inline comments + check-run `N/5`; per-finding PoC + AI-fix prompt; learns from triage. Seat-priced.
- **Whitebox Pentest** — source-aware deep audit at repo scope; reuses scans/VM/findings/reports; autonomous triage + (follow-up) sandbox PoC validation; dual-audience report. Credit/usage-priced.

Both run the same `review/engine` (context → candidates → LLM judge → deterministic score →
findings). PR review runs inline/light; whitebox runs at repo scope (optionally on a GCP VM).

## Architectural principle
**The moat is the deterministic reachability/taint + generate-then-verify layer, not the LLM call.**
Generator ≠ Judge. Model emits decomposed CVSS vector + reachable + confidence; **never the final
number** (anti reward-hacking). Deterministic scorer computes CVSS + 0-5.

## Module map (`server/src/review/`)
| File | Responsibility | Deps | Tested w/ |
|---|---|---|---|
| `types.ts` | Domain types (Severity, CvssVector, RawFinding, Candidate, ReviewFinding, ReviewResult, ReviewKind) | — | — |
| `schemas.ts` | Zod: LLM structured output, `/v1/review` body, GitHub webhook subset | zod | unit |
| `fingerprint.ts` | Stable `fingerprint(cwe,path,snippet)` (line-shift invariant) | crypto | unit |
| `score.ts` | `cvssBaseScore(vector)` (CVSS 3.1), `severityFromScore`, `overallScore0to5(findings)` worst-sev gating | — | unit |
| `sarif.ts` | SARIF → `RawFinding[]` normalizer (Opengrep/Trivy/Gitleaks) | — | unit (fixtures) |
| `sast/runner.ts` | `SastRunner` iface; `FakeSastRunner`; `CliSastRunner` (shells out iff binary present, else []) | sarif | unit |
| `context/repomap.ts` | `SymbolIndexer` iface; `RegexSymbolIndexer`; `buildContextBundle(diff, files, budget)` w/ PageRank-ish ranking | — | unit |
| `reviewer.ts` | `LlmClient` iface; `FakeLlmClient`; `buildPrompt` (rationale-before-severity, redact PR metadata); `review(ctx,candidates)` | schemas | unit |
| `llm/openrouter.ts` | Real `LlmClient` over OpenRouter/LiteLLM via fetch (injected) | — | unit (fake fetch) |
| `github/sign.ts` | `verifyWebhookSignature` (X-Hub-Signature-256), `appJwt` (RS256), token cache | crypto | unit |
| `github/client.ts` | `GitHubClient` iface; `FakeGitHubClient`; `HttpGitHubClient` (fetch: PR files, post review, check-run, resolveReviewThread) | sign | unit (fake fetch) |
| `github/webhook.ts` | parse + classify webhook event (pull_request/issue_comment/check_run) | schemas | unit |
| `engine.ts` | `runReview(input, deps)` orchestrator (context→sast→reviewer→score→fingerprint) | most | unit (fakes, e2e) |
| `poster.ts` | `ReviewResult` → batched GitHub review + check-run + thread map | github/client | unit (fake) |
| `service.ts` | persistence (repos/reviews/findings/threads/feedback) + `emitSignedAudit` | db | unit (in-mem db) |
| `feedback.ts` | team-feedback filter (suppress comments similar to ≥3 downvoted) — cosine over stored embeddings (follow-up: real embeddings) | — | unit |

## Routes (`server/src/routes/`)
- `review-webhook.ts` — `POST /v1/review/github/webhook` (verify sig + dedup via `webhook_dedup` + enqueue `pr_review`).
- `review.ts` — `POST /v1/review` (client-skill API: `{repo,pr,head_sha,diff}` → 202 `{review_id}`; or sync), `GET /v1/review/:id`, `GET /v1/review/repos`, `POST /v1/review/whitebox` (launch whitebox), auth via `createRequireAuth`.

## Jobs
Extend `jobs.type` union: `pr_review`, `whitebox_scan`, `resolve_threads`, `index_repo`.
- `jobs/handlers/pr-review.ts` — load review → engine → persist → poster.
- `jobs/handlers/whitebox-scan.ts` — repo-scope review (clone via GitHubClient archive or git; SAST suite + engine → findings → report). Deep CPG/Joern + sandbox PoC = documented follow-up.

## DB — migration `0012_whitebox_review.sql`
`review_repos`, `reviews` (kind pr|whitebox), `review_findings`, `review_threads`, `review_feedback`.
+ schema.ts Drizzle tables + inferred types.

## Config (all optional, graceful degrade)
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID?`,
`TENSOL_REVIEW_LLM_API_KEY`, `TENSOL_REVIEW_LLM_BASE_URL`, `TENSOL_REVIEW_LLM_MODEL`.

## Audit events (new)
`review_repo_connected`, `review_started`, `review_completed`, `review_failed`,
`review_finding_posted`, `review_webhook_received`, `review_webhook_invalid_signature`,
`whitebox_scan_started`, `whitebox_scan_completed`.

## Frontend (`apps/site`)
`api-client.ts` review namespace + `pages/Reviews.tsx` (connected repos, recent reviews, scores) +
nav entry + route. `pages/ReviewDetail.tsx` (findings list).

## Client skill `.claude/skills/tensol-loop/`
greploop shape: SKILL.md + scripts (push → trigger `/v1/review` → poll → parse score+comments →
fixer (host agent) → resolve threads → commit/push → stop at 5/5 & 0 unresolved or 5 iters).

## Test plan (TDD)
Each leaf module RED→GREEN with `bun test`. Engine e2e with all fakes. Routes with in-mem DB.
Target: new modules ≥80% lines, zero regressions in existing suite (run no-DB suite to confirm).

## Out of scope tonight (documented follow-ups)
Joern CPG/taint depth; real tree-sitter indexer (RegexSymbolIndexer ships first behind the iface);
sandbox PoC executor wiring; real embedding model for feedback filter; GitLab/Bitbucket; billing
(credits/seats) enforcement; auto-remediation PRs.
