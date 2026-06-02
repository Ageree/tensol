#!/usr/bin/env bash
# sthrip-check-pr — inspect a PR for unresolved Sthrip findings, failing checks,
# and description gaps; categorise actionable vs informational.
#
# Usage:
#   STHRIP_API_BASE=https://api.tensol.ru STHRIP_SESSION=<cookie> \
#     bash check-pr.sh <owner/name> <pr-number> [--resolve]
#
# Options:
#   --resolve  after fetching, resolve threads whose finding fingerprints are
#              absent from the latest Sthrip review result (requires GITHUB_TOKEN)
#
# Output (stdout): JSON blob — see SKILL.md for full schema.
set -euo pipefail

REPO="${1:?usage: check-pr.sh <owner/name> <pr-number> [--resolve]}"
PR_NUMBER="${2:?usage: check-pr.sh <owner/name> <pr-number> [--resolve]}"
RESOLVE_MODE="${3:-}"

API="${STHRIP_API_BASE:-https://api.tensol.ru}"
SESSION="${STHRIP_SESSION:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITLAB_TOKEN="${GITLAB_TOKEN:-}"
GITLAB_BASE_URL="${GITLAB_BASE_URL:-https://gitlab.com}"

# ---------------------------------------------------------------------------
# Platform auto-detection
# ---------------------------------------------------------------------------
REMOTE_URL=""
if git remote get-url origin >/dev/null 2>&1; then
  REMOTE_URL="$(git remote get-url origin)"
fi

if echo "$REMOTE_URL" | grep -q "github\.com"; then
  PLATFORM="github"
elif echo "$REMOTE_URL" | grep -qE "(gitlab\.com|/-/merge_requests/)"; then
  PLATFORM="gitlab"
elif echo "$REMOTE_URL" | grep -qiE "(p4|perforce|helix)"; then
  PLATFORM="perforce"
else
  PLATFORM="github"  # safe default
fi

# ---------------------------------------------------------------------------
# JSON helper (python3 > node fallback)
# ---------------------------------------------------------------------------
json_encode() {
  # $1 = variable name with the value
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$1"
  else
    node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$1"
  fi
}

# ---------------------------------------------------------------------------
# Fetch the latest Sthrip review result for this PR
# ---------------------------------------------------------------------------
STHRIP_COOKIE_ARGS=()
if [ -n "${SESSION}" ]; then
  STHRIP_COOKIE_ARGS=(-H "Cookie: sthrip_session=${SESSION}")
fi

STHRIP_RESULT=""
STHRIP_SCORE=null
STHRIP_FINDINGS_JSON="[]"
STHRIP_SUMMARY_UPDATED_AT="null"

if command -v curl >/dev/null 2>&1; then
  OWNER="${REPO%%/*}"
  REPO_NAME="${REPO##*/}"

  STHRIP_RESP="$(curl -sf -X GET \
    "${API}/v1/review?repo=$(json_encode "$REPO")&pr=${PR_NUMBER}&limit=1" \
    "${STHRIP_COOKIE_ARGS[@]}" 2>/dev/null || echo "")"

  if [ -n "${STHRIP_RESP}" ]; then
    STHRIP_RESULT="${STHRIP_RESP}"
    if command -v python3 >/dev/null 2>&1; then
      STHRIP_SCORE="$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
results = data if isinstance(data, list) else data.get('results', [data])
if results:
    r = sorted(results, key=lambda x: x.get('updated_at',''), reverse=True)[0]
    print(r.get('score_0_5', 'null'))
else:
    print('null')
" "${STHRIP_RESULT}" 2>/dev/null || echo "null")"

      STHRIP_FINDINGS_JSON="$(python3 -c "
import json, sys
data = json.loads(sys.argv[1])
results = data if isinstance(data, list) else data.get('results', [data])
if results:
    r = sorted(results, key=lambda x: x.get('updated_at',''), reverse=True)[0]
    print(json.dumps(r.get('findings', [])))
else:
    print('[]')
" "${STHRIP_RESULT}" 2>/dev/null || echo "[]")"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# GitHub: fetch review threads + comments + check-runs
# ---------------------------------------------------------------------------
fetch_github() {
  local owner="${REPO%%/*}"
  local repo_name="${REPO##*/}"

  if [ -z "${GITHUB_TOKEN}" ]; then
    echo '{"error":"GITHUB_TOKEN not set","platform":"github"}' >&2
    exit 1
  fi

  # GraphQL query: list review threads
  THREADS_QUERY="$(cat <<'GRAPHQL'
query ListReviewThreads($owner: String!, $name: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      title
      bodyText
      state
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              id
              body
              createdAt
              updatedAt
              author { login }
            }
          }
        }
      }
      comments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          id
          body
          createdAt
          updatedAt
          author { login }
        }
      }
    }
  }
}
GRAPHQL
)"

  local variables
  variables="$(python3 -c "
import json
print(json.dumps({
    'owner': '$owner',
    'name': '$repo_name',
    'prNumber': int('$PR_NUMBER')
}))
")"

  local gql_body
  gql_body="$(python3 -c "
import json
print(json.dumps({'query': open('/dev/stdin').read(), 'variables': json.loads('$variables')}))
" <<< "${THREADS_QUERY}")"

  local gql_resp
  gql_resp="$(curl -sf -X POST https://api.github.com/graphql \
    -H "Authorization: bearer ${GITHUB_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${gql_body}" 2>/dev/null || echo "")"

  # Parse and categorise via python3
  python3 - "${gql_resp}" "${STHRIP_FINDINGS_JSON}" "${STHRIP_SCORE}" "${STHRIP_SUMMARY_UPDATED_AT}" <<'PYEOF'
import json, sys

raw_resp = sys.argv[1]
findings_json = sys.argv[2]
score = sys.argv[3]
summary_updated_at = sys.argv[4]

actionable = []
informational = []
resolved_list = []

try:
    resp = json.loads(raw_resp) if raw_resp else {}
    pr_data = resp.get("data", {}).get("repository", {}).get("pullRequest", {})

    # Build fingerprint set from latest Sthrip result
    sthrip_findings = json.loads(findings_json) if findings_json else []
    fp_set = {f.get("fingerprint", "") for f in sthrip_findings}

    # Read-latest-summary rule: find the most recently *updated* Sthrip summary comment
    all_comments = pr_data.get("comments", {}).get("nodes", [])
    sthrip_summaries = [c for c in all_comments if "<!-- tensol:fp:" in c.get("body", "")]
    sthrip_summary = sthrip_summaries[0] if sthrip_summaries else None  # DESC sorted by API
    if sthrip_summary:
        summary_updated_at = sthrip_summary.get("updatedAt", "null")

    # Process review threads
    threads = pr_data.get("reviewThreads", {}).get("nodes", [])
    for thread in threads:
        if thread.get("isResolved"):
            resolved_list.append({
                "type": "thread",
                "thread_id": thread.get("id"),
                "path": thread.get("path"),
                "line": thread.get("line"),
            })
            continue
        if thread.get("isOutdated"):
            informational.append({
                "type": "finding",
                "thread_id": thread.get("id"),
                "severity": "outdated",
                "title": "Outdated thread (stale diff)",
                "file": thread.get("path"),
                "line": thread.get("line"),
            })
            continue

        # Extract fingerprint from thread comments (Sthrip encodes it in body)
        comments = thread.get("comments", {}).get("nodes", [])
        fingerprint = None
        severity = "unknown"
        title = ""
        for comment in comments:
            body = comment.get("body", "")
            if "<!-- tensol:fp:" in body:
                # Extract: <!-- tensol:fp:<fingerprint>:severity:<sev> -->
                import re
                fp_match = re.search(r'<!-- tensol:fp:([a-f0-9]+)', body)
                sev_match = re.search(r':severity:(critical|high|medium|low|info(?:rmational)?|nit|style)', body)
                title_match = re.search(r'\*\*(.+?)\*\*', body)
                if fp_match:
                    fingerprint = fp_match.group(1)
                if sev_match:
                    severity = sev_match.group(1)
                if title_match:
                    title = title_match.group(1)

        item = {
            "type": "finding",
            "thread_id": thread.get("id"),
            "fingerprint": fingerprint,
            "severity": severity,
            "title": title or "(unknown)",
            "file": thread.get("path"),
            "line": thread.get("line"),
        }

        if severity in ("critical", "high", "medium"):
            actionable.append(item)
        else:
            informational.append(item)

except Exception as e:
    sys.stderr.write(f"parse error: {e}\n")

result = {
    "platform": "github",
    "repo": sys.argv[0] if len(sys.argv) > 0 else "",
    "pr_number": int(sys.argv[0]) if False else 0,
    "score_0_5": None if score in ("null", "", "None") else float(score),
    "summary_updated_at": summary_updated_at,
    "actionable": actionable,
    "informational": informational,
    "resolved": resolved_list,
}
print(json.dumps(result, indent=2))
PYEOF
}

# ---------------------------------------------------------------------------
# GitLab: fetch discussions + pipeline jobs
# ---------------------------------------------------------------------------
fetch_gitlab() {
  if [ -z "${GITLAB_TOKEN}" ]; then
    echo '{"error":"GITLAB_TOKEN not set","platform":"gitlab"}' >&2
    exit 1
  fi

  local project_id
  project_id="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${REPO}")"

  local discussions_resp
  discussions_resp="$(curl -sf \
    "${GITLAB_BASE_URL}/api/v4/projects/${project_id}/merge_requests/${PR_NUMBER}/discussions?per_page=100" \
    -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" 2>/dev/null || echo "[]")"

  python3 - "${discussions_resp}" "${STHRIP_FINDINGS_JSON}" "${STHRIP_SCORE}" <<'PYEOF'
import json, sys

discussions_json = sys.argv[1]
findings_json = sys.argv[2]
score = sys.argv[3]

actionable = []
informational = []
resolved_list = []
summary_updated_at = "null"

try:
    discussions = json.loads(discussions_json) if discussions_json else []
    sthrip_findings = json.loads(findings_json) if findings_json else []
    fp_set = {f.get("fingerprint", "") for f in sthrip_findings}

    # Read-latest-summary rule: find all notes with the Sthrip marker, sort by updated_at DESC
    all_sthrip_notes = []
    for disc in discussions:
        for note in disc.get("notes", []):
            if "<!-- tensol:fp:" in note.get("body", ""):
                all_sthrip_notes.append(note)
    if all_sthrip_notes:
        all_sthrip_notes.sort(key=lambda n: n.get("updated_at", ""), reverse=True)
        summary_updated_at = all_sthrip_notes[0].get("updated_at", "null")

    for disc in discussions:
        notes = disc.get("notes", [])
        if not notes:
            continue
        if disc.get("individual_note"):
            # Standalone comment — informational only
            informational.append({
                "type": "comment",
                "discussion_id": disc.get("id"),
                "body_preview": (notes[0].get("body") or "")[:120],
            })
            continue

        first_note = notes[0]
        if not first_note.get("resolvable", False):
            continue
        if first_note.get("resolved", False):
            resolved_list.append({
                "type": "discussion",
                "discussion_id": disc.get("id"),
                "path": (first_note.get("position") or {}).get("new_path"),
            })
            continue

        import re
        body = first_note.get("body", "")
        fp_match = re.search(r'<!-- tensol:fp:([a-f0-9]+)', body)
        sev_match = re.search(r':severity:(critical|high|medium|low|info(?:rmational)?|nit|style)', body)
        title_match = re.search(r'\*\*(.+?)\*\*', body)

        fingerprint = fp_match.group(1) if fp_match else None
        severity = sev_match.group(1) if sev_match else "unknown"
        title = title_match.group(1) if title_match else body[:80]
        position = first_note.get("position") or {}

        item = {
            "type": "finding",
            "discussion_id": disc.get("id"),
            "fingerprint": fingerprint,
            "severity": severity,
            "title": title,
            "file": position.get("new_path"),
            "line": position.get("new_line"),
        }

        if severity in ("critical", "high", "medium"):
            actionable.append(item)
        else:
            informational.append(item)

except Exception as e:
    sys.stderr.write(f"parse error: {e}\n")

result = {
    "platform": "gitlab",
    "score_0_5": None if score in ("null", "", "None") else float(score),
    "summary_updated_at": summary_updated_at,
    "actionable": actionable,
    "informational": informational,
    "resolved": resolved_list,
}
print(json.dumps(result, indent=2))
PYEOF
}

# ---------------------------------------------------------------------------
# GitHub: resolve threads whose fingerprints are absent from latest result
# ---------------------------------------------------------------------------
resolve_github_threads() {
  local threads_json="$1"
  if [ -z "${GITHUB_TOKEN}" ]; then
    echo '{"error":"GITHUB_TOKEN required for --resolve"}' >&2
    return 1
  fi

  python3 - "${threads_json}" "${STHRIP_FINDINGS_JSON}" "${GITHUB_TOKEN}" <<'PYEOF'
import json, sys, subprocess

threads_json = sys.argv[1]
findings_json = sys.argv[2]
token = sys.argv[3]

sthrip_findings = json.loads(findings_json) if findings_json else []
fp_set = {f.get("fingerprint", "") for f in sthrip_findings}

try:
    data = json.loads(threads_json)
    threads = data.get("actionable", [])
except Exception:
    threads = []

resolved = []
skipped = []

for t in threads:
    fp = t.get("fingerprint")
    thread_id = t.get("thread_id")
    if not thread_id:
        skipped.append(t)
        continue
    # Only resolve if fingerprint is gone from the latest result (remediated)
    if fp and fp in fp_set:
        skipped.append({"thread_id": thread_id, "reason": "still_present"})
        continue

    mutation = '{"query":"mutation ResolveThread($id: ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}","variables":{"id":"' + thread_id + '"}}'
    result = subprocess.run(
        ["curl", "-sf", "-X", "POST", "https://api.github.com/graphql",
         "-H", f"Authorization: bearer {token}",
         "-H", "Content-Type: application/json",
         "-d", mutation],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        resolved.append({"thread_id": thread_id, "status": "resolved"})
    else:
        skipped.append({"thread_id": thread_id, "reason": "api_error"})

print(json.dumps({"resolved": resolved, "skipped": skipped}, indent=2))
PYEOF
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
case "${PLATFORM}" in
  github)
    OUTPUT="$(fetch_github)"
    if [ "${RESOLVE_MODE}" = "--resolve" ]; then
      RESOLVE_RESULT="$(resolve_github_threads "${OUTPUT}")"
      # Merge resolve_result into output
      python3 -c "
import json, sys
out = json.loads(sys.argv[1])
res = json.loads(sys.argv[2])
out['resolve_result'] = res
print(json.dumps(out, indent=2))
" "${OUTPUT}" "${RESOLVE_RESULT}"
    else
      echo "${OUTPUT}"
    fi
    ;;
  gitlab)
    fetch_gitlab
    ;;
  perforce)
    echo '{"platform":"perforce","status":"not_implemented","message":"Perforce/Helix Swarm support: use the Swarm REST API /api/v9/reviews/:id/comments manually. See SKILL.md for details."}'
    ;;
  *)
    echo '{"error":"unknown platform"}'
    exit 1
    ;;
esac
