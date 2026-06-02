---
name: sthrip-check-pr
description: Use when you want to inspect a pull request for unresolved Sthrip review comments, failing CI checks, and description gaps, then categorise them as actionable vs. informational and help resolve addressed threads. Auto-detects GitHub, GitLab, and Perforce. Triggers on "check pr", "sthrip check", "review status", "resolve threads".
---

# sthrip-check-pr

Pull-request health inspector for the **Sthrip** security review engine.
Inspired by Greptile's `check-pr` skill. **Fixer-agnostic**: this skill
categorises and reports; the host agent (Claude Code / Codex / Aider) performs
the actual edits and resolutions.

---

## What it does

1. **Auto-detects the SCM platform** (GitHub / GitLab / Perforce) from the
   current git remote URL.
2. **Fetches** the PR's:
   - Inline review threads and comments (including the Sthrip summary comment).
   - CI / check-run statuses.
   - PR description (title + body).
3. **Finds the most-recent Sthrip summary** by sorting all comments by
   `updated_at` descending and selecting the first one whose body contains the
   edit-in-place marker `<!-- tensol:fp:`. This is the canonical Sthrip
   summary comment — always prefer the most recently updated one, never the
   oldest (edit-in-place gotcha: the summary is updated in place, so the
   creation time is stale).
4. **Categorises** every review thread and check:
   - **Actionable** — a Sthrip inline finding thread that is still open AND the
     finding severity is `medium` or above, OR a failing required check.
   - **Informational** — resolved threads, dismissed findings, `nit`/`style`
     category comments, optional/non-blocking checks.
5. **Reports** a structured summary to the host agent (Sthrip score, open
   actionable items, passing/failing checks, description quality).
6. Optionally **resolves addressed threads**: if the host agent has pushed a
   fix commit, call `resolveReviewThread` (GitHub GraphQL) or mark the GitLab
   discussion resolved for findings whose fingerprint is absent from the latest
   Sthrip review result.

---

## Prerequisites

- `STHRIP_API_BASE` env var → e.g. `https://api.tensol.ru` (default if unset).
- `STHRIP_SESSION` env var → a Sthrip session cookie value, OR run against a
  local dev server with `__test` auth.
- `GITHUB_TOKEN` env var for GitHub GraphQL calls (needed for resolving threads).
- The current working directory must be inside a git repository with a remote
  set to a GitHub / GitLab / Perforce URL.

---

## Platform auto-detection

```
remote_url = git remote get-url origin

if   remote_url matches github.com           → platform = "github"
elif remote_url matches gitlab.com OR self-hosted gitlab path (/-/merge_requests/)
                                              → platform = "gitlab"
elif remote_url contains p4                   → platform = "perforce"
else                                          → platform = "github"  # safe default
```

Use `scripts/check-pr.sh` to perform the detection and initial fetch; it prints
a JSON blob the host agent can parse.

---

## Thread categorisation rules

| Condition | Category |
|-----------|----------|
| Sthrip thread, unresolved, severity ∈ {critical, high, medium} | **actionable** |
| Sthrip thread, unresolved, severity ∈ {low, informational, nit, style} | **informational** |
| Sthrip thread, resolved | **informational** |
| Non-Sthrip reviewer comment, requests-changes | **actionable** |
| Non-Sthrip reviewer comment, approved / FYI | **informational** |
| Required CI check, failing | **actionable** |
| Optional CI check, failing | **informational** |
| Required CI check, passing | *(not shown)* |
| PR description missing summary / checklist | **informational** |

---

## Read-latest-summary rule (edit-in-place gotcha)

The Sthrip summary comment is **edited in place** across review cycles. Do NOT
read the newest-by-created-at comment and assume it is the summary. Instead:

```
comments = fetch all PR comments (paginated)
sthrip_summary = comments
  .filter(c => c.body.includes("<!-- tensol:fp:"))
  .sort((a, b) => b.updated_at - a.updated_at)[0]  // most recently updated
```

The `updated_at` field is the authoritative recency indicator. If no comment
matches the marker, the review has not yet run (or was posted before this
version).

---

## How to run

### 1. Auto mode (recommended)

```bash
STHRIP_API_BASE=https://api.tensol.ru STHRIP_SESSION=<cookie> \
  bash .claude/skills/sthrip-check-pr/scripts/check-pr.sh <owner/name> <pr-number>
```

Output (stdout): a JSON blob:

```json
{
  "platform": "github",
  "pr_number": 42,
  "score_0_5": 3,
  "summary_updated_at": "2026-05-29T14:00:00Z",
  "actionable": [
    {
      "type": "finding",
      "thread_id": "PRT_xxx",
      "fingerprint": "abc123",
      "severity": "high",
      "title": "SQL Injection in query builder",
      "file": "src/db.ts",
      "line": 42
    },
    {
      "type": "check",
      "name": "ci/test",
      "conclusion": "failure",
      "required": true
    }
  ],
  "informational": [
    {
      "type": "finding",
      "thread_id": "PRT_yyy",
      "severity": "nit",
      "title": "trailing whitespace"
    }
  ],
  "resolved": []
}
```

### 2. Resolve addressed threads

After the host agent has pushed a fix commit, run with `--resolve`:

```bash
GITHUB_TOKEN=<token> \
  bash .claude/skills/sthrip-check-pr/scripts/check-pr.sh <owner/name> <pr-number> --resolve
```

The script re-fetches the latest Sthrip review result and calls
`resolveReviewThread` (GitHub GraphQL) for each thread whose `fingerprint` is
absent from the new result — meaning the finding was remediated.

### 3. Manual step-by-step

1. Run `scripts/check-pr.sh` to get the categorised JSON.
2. Read `actionable` items; for each:
   - **finding**: open the file at the given line, apply the fix suggested by
     `rationale` / `fix_prompt`. Then commit.
   - **check**: inspect the failing check logs; fix the root cause.
3. After fixing, re-run with `--resolve` to close addressed threads.
4. Repeat until `actionable` is empty.

---

## Stop / done condition

The pull request is ready to merge when:

- `score_0_5 == 5` (from the latest Sthrip summary), AND
- `actionable` list is empty (no open Sthrip finding threads with severity ≥ medium), AND
- All **required** CI checks are passing.

---

## Multi-platform usage

### GitHub (default)

Uses the GitHub GraphQL API v4 for thread resolution and the REST API v3 for
check-runs. See `references/graphql-queries.md` for the exact queries.

### GitLab

Uses the GitLab Discussions REST API. Threads map to discussions; "resolve" maps
to `PUT /projects/:id/merge_requests/:mr_iid/discussions/:discussion_id?resolved=true`.
See `references/gitlab-api.md` for the full endpoint list.

### Perforce / Helix Swarm

Uses the Swarm REST API (`/api/v9/reviews/:id/comments`). Thread resolution via
`PATCH /api/v9/reviews/:id/comments/:comment_id` with `{"readBy":["<user>"]}`.
Note: Perforce does not have a native "resolved" state for code comments;
mark as read-by as the closest equivalent.

---

## Integration with sthrip-loop

`sthrip-check-pr` is called inside `sthrip-loop` after each fix commit to
verify that previously open threads are now resolved before counting the
iteration as complete. The two skills share the same platform auto-detection
logic and the same read-latest-summary rule.

---

## Notes

- The edit-in-place marker `<!-- tensol:fp:` is a wire-compatibility constant
  in the Sthrip poster; do NOT change it even though the brand is Sthrip.
- On GitHub, resolving a thread requires the `pull_request_threads` write scope
  (part of `repo`). If the token lacks this scope, the script logs a warning
  and skips resolution.
- This skill is **fixer-agnostic**: it never modifies source files. All code
  changes are performed by the host agent.
- See `references/graphql-queries.md` and `references/gitlab-api.md` for the
  raw API calls used internally.
