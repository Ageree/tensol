---
name: sthrip-loop
description: Use when you want to auto-fix code until a Sthrip security review passes 5/5. Runs a bounded loop — trigger a Sthrip PR review, parse the 0-5 score + actionable findings, fix them with the host agent, re-review — stopping at 5/5 with zero unresolved findings or after 5 iterations. Reads the latest summary by updated_at (edit-in-place gotcha). Triggers on "sthrip loop", "fix until sthrip passes", "get to 5/5", "@sthrip review".
---

# sthrip-loop

Bounded auto-fix loop against the Sthrip PR review engine. Inspired by
Greptile's `greploop`. **Fixer-agnostic**: the host agent (you — Claude Code /
Codex / Aider) performs the edits; this skill orchestrates the review→fix→re-review
cycle and the stop condition.

## Prerequisites

- `STHRIP_API_BASE` env var → e.g. `https://api.sthrip.com` (default if unset).
- `STHRIP_SESSION` env var → a Sthrip session cookie value (the API is
  cookie-authenticated), OR run against a local dev server with `__test` auth.
- A git repo with committed changes on a feature branch.

## The loop (max 5 iterations)

```
i = 0
loop:
  i += 1                                    # hard stop at i > 5
  diff = git diff <base>...HEAD              # the changes to review
  resp = POST $STHRIP_API_BASE/v1/review {repo, head_sha, diff, sync:true}
  score = resp.score_0_5
  findings = resp.findings (actionable = severity >= medium AND reachable)
  print "iteration i: score score/5, N actionable findings"
  if score == 5 AND actionable findings == 0:
      STOP — success
  for each actionable finding:
      read finding.file_path : finding.start_line
      apply finding.fix_prompt_md / finding.rationale_md   # HOST AGENT edits the code
  if no edits were possible (all findings are false positives):
      record feedback (POST /v1/review/<id>/feedback {fingerprint, signal:"down"})
      STOP — escalate to human
  git add -A && git commit -m "fix: address sthrip review findings (iter i)"
  goto loop
```

## How to run

1. Determine the base branch (usually `main`) and the repo slug `owner/name`.
2. Run `scripts/review.sh` to trigger one review and print the parsed result:
   ```bash
   STHRIP_API_BASE=… STHRIP_SESSION=… bash scripts/review.sh owner/name main
   ```
   It prints a JSON blob: `{review_id, score, findings:[{file,line,severity,title,fix_prompt}]}`.
3. For each actionable finding, open the file at the line and apply the fix
   described in `fix_prompt`. Make the **minimal** change that resolves the
   exploit path described in `rationale`.
4. Commit, then re-run step 2.
5. Stop when score is `5/5` and there are zero actionable findings, or after 5
   iterations (report remaining findings to the user).

## Stop conditions (strict)

- **Success:** `score == 5` and `0` actionable findings.
- **Iteration cap:** `i > 5` — stop and summarize what remains.
- **All-false-positive:** if you are confident every remaining finding is a
  false positive, submit `signal:"down"` feedback for each (this trains the
  team filter) and stop; do not loop forever fighting noise.

## Edit-in-place gotcha — read summary by `updated_at`

Sthrip edits the PR summary comment **in place** (never posts a duplicate).
When fetching the current summary to parse the score or finding list, always
**sort all PR comments by `updated_at` descending** and take the first one that
contains the `<!-- sthrip:fp:* -->` anchor marker.

- **Do NOT rely on comment creation order or comment ID sorting** — the summary
  is always the most-recently-edited comment, not the first or last by ID.
- Before triggering a re-review, verify you are reading the latest snapshot of
  the summary; stale reads produce false "already 5/5" stop conditions.
- The marker `<!-- sthrip:fp:* -->` is the canonical signal that a comment
  belongs to Sthrip's summary; plain bot comments (e.g. over-capacity notices)
  do NOT carry this marker and should be skipped.

## Platform detection

The skill auto-detects the SCM platform:

| Signal | Platform |
|--------|----------|
| `GITHUB_REPOSITORY` env / `github.com` remote | **GitHub** — uses REST `GET /repos/{owner}/{repo}/pulls/{pr}/comments` + GraphQL `resolveReviewThread` |
| `CI_SERVER_HOST=gitlab.*` / `gitlab.com` remote | **GitLab** — uses MR Notes API (`GET /projects/:id/merge_requests/:iid/notes`) |
| `P4PORT` env / `p4` CLI present | **Perforce** — uses Helix Swarm REST API |

All platforms share the same `@sthrip review` trigger and 0–5 score contract.
See `references/api.md` for endpoint details and `references/graphql-queries.md`
for GitHub GraphQL thread resolution.

## Notes

- Never weaken a fix just to silence the scanner — the score is computed from a
  deterministic CVSS gate (worst-severity), NOT the model's whim, so gaming it
  requires actually removing the vulnerability.
- The review is whole-repo-aware: a fix that only moves the sink will still be
  flagged. Fix the data-flow, not the symptom.
- See `references/api.md` for the full request/response contract.
- See `references/graphql-queries.md` for GitHub GraphQL thread resolution.
