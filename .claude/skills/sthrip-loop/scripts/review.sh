#!/usr/bin/env bash
# sthrip-loop — trigger one Sthrip review of the current branch diff and print
# the parsed result as JSON on stdout.
#
# Usage:
#   STHRIP_API_BASE=https://api.sthrip.com STHRIP_SESSION=<cookie> \
#     bash review.sh <owner/name> [base-branch]
#
# Output (stdout): the raw JSON returned by POST /v1/review, e.g.
#   {"review_id":"...","status":"completed","score_0_5":2,
#    "findings":[{"file_path":"src/db.ts","start_line":42,"severity":"high",
#                 "title":"SQLi ...","rationale_md":"...","fix_prompt_md":"..."}]}
#
# Edit-in-place note: Sthrip edits the PR summary comment in place. When reading
# the current score from the PR, always sort comments by updated_at descending and
# take the first one matching the <!-- sthrip:fp:* --> anchor marker.
set -euo pipefail

REPO="${1:?usage: review.sh <owner/name> [base-branch]}"
BASE="${2:-main}"
API="${STHRIP_API_BASE:-https://api.sthrip.com}"
SESSION="${STHRIP_SESSION:-}"

HEAD_SHA="$(git rev-parse HEAD)"
# Three-dot diff = changes on this branch since it diverged from base.
DIFF="$(git diff "${BASE}...HEAD" || git diff "${BASE}" || true)"

if [ -z "${DIFF}" ]; then
  echo '{"error":"empty_diff","message":"no changes vs base branch"}' >&2
  exit 2
fi

# Build the request body with a heredoc-safe JSON encoder (python3 is ubiquitous;
# falls back to node if absent).
encode_body() {
  if command -v python3 >/dev/null 2>&1; then
    REPO="$REPO" HEAD_SHA="$HEAD_SHA" DIFF="$DIFF" python3 - <<'PY'
import json, os
print(json.dumps({
    "repo": os.environ["REPO"],
    "head_sha": os.environ["HEAD_SHA"],
    "diff": os.environ["DIFF"],
    "sync": True,
}))
PY
  else
    REPO="$REPO" HEAD_SHA="$HEAD_SHA" DIFF="$DIFF" node -e \
      'process.stdout.write(JSON.stringify({repo:process.env.REPO,head_sha:process.env.HEAD_SHA,diff:process.env.DIFF,sync:true}))'
  fi
}

COOKIE_ARG=()
if [ -n "${SESSION}" ]; then
  COOKIE_ARG=(-H "Cookie: sthrip_session=${SESSION}")
fi

encode_body | curl -sS -X POST "${API}/v1/review" \
  -H "Content-Type: application/json" \
  "${COOKIE_ARG[@]}" \
  --data-binary @-
echo
