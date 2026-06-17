# Quickstart — Sthrip PR Review (feature 004)

End-to-end run/verify for the connect → select → review → fix loop. Assumes the existing engine (`server/src/review/`) is present (it is, on `main`).

## 0. Prerequisites

- Bun ≥ 1.1, repo installed (`cd server && bun install`).
- A **Sthrip GitHub App** registered (dev app is fine). Env in `server/.env`:
  - `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` (for the install URL), `GITHUB_APP_CLIENT_ID`/`CLIENT_SECRET`.
  - `STHRIP_REVIEW_LLM_*` (model + key; falls back to shared OpenRouter key per PR #8).
- Scanner sidecars on PATH (dev): `opengrep`, `trivy`, `osv-scanner`, `gitleaks` (or `kingfisher`). Reachability (`joern`) is optional locally — degrades to a labelled lower-confidence verdict if absent.
- Rules: point Opengrep at **AikidoSec/opengrep-rules (MIT)** or self-authored rules only — never Semgrep registry / opengrep's own Commons-Clause rules.

## 1. Migrate + run

```bash
cd server
bun run migrate          # applies 0013_pr_review_connect.sql
bun run dev              # or: tmux new-session -d -s dev 'bun run dev'  (per repo hook)
```

## 2. Connect GitHub (US1)

1. Open the frontend, sign in, click **Connect GitHub**.
2. Frontend calls `GET /v1/github/connect` → redirects to the App install URL.
3. Install the app on a test account/org; GitHub redirects to `GET /v1/github/callback?installation_id=…&setup_action=install&state=…`.
4. Backend validates `state`, persists an `installations` row, lands you on **Repositories**.
   - Verify: `GET /v1/github/installations` → `{ connected: true, installations: [...] }`.

## 3. Select repositories (US1)

1. On **Repositories**, toggle a repo **enabled**, set covered branches (default `main`), optionally enable the status check / merge-block.
   - `PATCH /v1/review/repos/{repo_id}/settings { enabled, covered_branches, status_check_enabled, merge_block_on_critical }`.
2. Reload → selection persisted; each repo shows last-review status.
3. (Optional) commit `.sthrip/rules.md` to the repo with trusted-source/ignored-path rules.

## 4. Get a review (US2 + US3)

1. Open a PR on the enabled repo against a covered branch (use a seeded vulnerable repo — see §6).
2. Within minutes: inline comments on vulnerable lines + ONE summary comment with a **0–5 score**.
   - Push a follow-up commit → the **same** summary comment updates (no duplicate).
   - Every posted finding shows **severity + numeric confidence + reachability indicator** and passed the verification gate (`verificationStatus=verified`).
3. Re-trigger by commenting **`@sthrip review`** (ignored if a review is already running).
4. If `merge_block_on_critical` and a verified critical exists → the `Sthrip N/5` check is `failure` and (under branch protection) blocks merge.
5. Fix the issue and push → the finding's thread auto-resolves next cycle; check turns green.
6. Confirm the same review appears in the Sthrip dashboard.

## 5. Developer skills (US6)

```bash
# Install (symlink into the host agent skill dir)
ln -s "$PWD/.claude/skills/sthrip-loop"     ~/.claude/skills/sthrip-loop
ln -s "$PWD/.claude/skills/sthrip-check-pr" ~/.claude/skills/sthrip-check-pr
```

- `/sthrip-loop` on a PR < 5/5 → trigger→fix→re-review until **5/5 & 0 unresolved** or 5 iterations; reports final state. Reads the latest summary by `updated_at` (edit-in-place).
- `/sthrip-check-pr 123` → categorizes comments/checks/description into actionable vs informational; resolves addressed threads.

## 6. Automated verification (tests — Constitution VI)

```bash
cd server
bun test src/review                 # unit + integration on in-memory SQLite + fakes
bun test src/routes/github-connect.test.ts
npx tsc --noEmit                    # type gate
# apps/site
cd ../apps/site && npx tsc -b && npx playwright test e2e/connect-select.spec.ts
```

Acceptance to assert (maps to spec SCs):
- **SC-001** connect→select < 2 min (E2E timing).
- **SC-002** review posted ≤ 5 min on a typical PR.
- **SC-003** 100% of posted findings carry severity+confidence+reachability and `verificationStatus=verified`.
- **SC-004** on a mixed benchmark (genuine reachable vulns + decoys), FP rate materially below an LLM-only baseline (≥ 50% fewer FPs).
- **SC-005/006** zero duplicate threads; ≥95% auto-resolve on remediation.
- **SC-007** `sthrip-loop` reaches 5/5 in ≤ 5 iterations on the seeded repo.
- **SC-008** dependency audit: zero AGPL/BSL/SSPL/Elastic/Commons-Clause/PolyForm-NC in the shippable path; GitNexus absent from `server/`.

## 7. License audit (SC-008 gate)

```bash
cd /path/to/repo
bash server/scripts/license-audit.sh
```

The script is wired into `.github/workflows/ci.yml` before server tests. It
fails on shippable `server/src` GitNexus references, known forbidden package
names in `server/package.json`, and forbidden Opengrep/Semgrep rule sources
when `STHRIP_OPENGREP_RULES_DIR` is configured.

## 8. Audit-chain gate (Constitution X)

```bash
cd /path/to/repo
TENSOL_AUDIT_SIGNING_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  bun run --cwd server verify-chain --db :memory:

bun test server/test/audit/new-events.test.ts server/src/audit/verify-chain.test.ts
```

CI runs the `verify-chain --db :memory:` smoke before the server test suite.
The focused tests seed every feature-004 audit event literal, verify each can
be emitted, and run `verifyChain` against the seeded in-memory test DB.
