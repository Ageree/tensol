---
name: tensol-loop
description: Use when you want to auto-fix code until a Tensol security review passes 5/5. Runs a bounded loop — trigger a Tensol PR/whitebox review, parse the 0-5 score + actionable findings, fix them with the host agent, re-review — stopping at 5/5 with zero unresolved findings or after 5 iterations. Triggers on "tensol loop", "fix until tensol passes", "get to 5/5".
---

# tensol-loop

Bounded auto-fix loop against the Tensol whitebox review engine. Inspired by
Greptile's `greploop`. **Fixer-agnostic**: the host agent (you — Claude Code /
Codex / Aider) performs the edits; this skill orchestrates the review→fix→re-review
cycle and the stop condition.

## Prerequisites

- `TENSOL_API_BASE` env var → e.g. `https://api.tensol.ru` (default if unset).
- `TENSOL_SESSION` env var → a Tensol session cookie value (the API is
  cookie-authenticated), OR run against a local dev server with `__test` auth.
- A git repo with committed changes on a feature branch.

## The loop (max 5 iterations)

```
i = 0
loop:
  i += 1                                    # hard stop at i > 5
  diff = git diff <base>...HEAD              # the changes to review
  resp = POST $TENSOL_API_BASE/v1/review {repo, head_sha, diff, sync:true}
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
  git add -A && git commit -m "fix: address tensol review findings (iter i)"
  goto loop
```

## How to run

1. Determine the base branch (usually `main`) and the repo slug `owner/name`.
2. Run `scripts/review.sh` to trigger one review and print the parsed result:
   ```bash
   TENSOL_API_BASE=… TENSOL_SESSION=… bash scripts/review.sh owner/name main
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

## Notes

- Never weaken a fix just to silence the scanner — the score is computed from a
  deterministic CVSS gate, not the model's whim, so gaming it requires actually
  removing the vulnerability.
- The review is whole-repo-aware: a fix that only moves the sink will still be
  flagged. Fix the data-flow, not the symptom.
- See `references/api.md` for the full request/response contract.
