# Sthrip Review API (used by sthrip-loop)

Base: `$STHRIP_API_BASE` (default `https://api.sthrip.com`). Cookie-authenticated
(`sthrip_session`). All bodies/responses are JSON, snake_case.

## GitHub App connect endpoints

### GET /v1/github/connect

Begin GitHub App connection — returns the install URL and a CSRF state nonce.

Response (200):
```json
{
  "install_url": "https://github.com/apps/<slug>/installations/new?state=…",
  "state": "csrf-nonce-here"
}
```

### GET /v1/github/callback?installation_id=…&setup_action=install&state=…

GitHub redirects here after install. Validates `state`, persists the installation,
reconciles repos. Redirects to `/repositories` on success.

Errors: `400` for bad/forged state.

### GET /v1/github/installations

Connection status + all installations for the authenticated user.

Response (200):
```json
{
  "connected": true,
  "installations": [
    {
      "id": "01J...",
      "account_login": "myorg",
      "account_type": "Organization",
      "repository_selection": "selected",
      "status": "active"
    }
  ]
}
```

### GET /v1/github/installations/{installation_id}/repos

List repos the installation can access, including Sthrip coverage state.

Response (200): array of `InstallationRepo`:
```json
[
  {
    "repo_id": "01J...",
    "owner": "myorg",
    "name": "api",
    "default_branch": "main",
    "enabled": true,
    "covered_branches": ["main"],
    "status_check_enabled": true,
    "merge_block_on_critical": false,
    "last_review": {
      "review_id": "01J...",
      "status": "completed",
      "score_0_5": 4,
      "updated_at": 1700000000
    }
  }
]
```

Errors: `404` if installation not owned by this user.

### PATCH /v1/review/repos/{repo_id}/settings

Update per-repo coverage and review settings. Emits `review_repo_enabled` /
`review_repo_disabled` / `review_settings_changed` signed audit events.

Request body (all fields optional):
```json
{
  "enabled": true,
  "covered_branches": ["main", "release/*"],
  "status_check_enabled": true,
  "merge_block_on_critical": false
}
```

Response (200): the updated `InstallationRepo` shape (same as above).

Errors: `400` validation; `403` not owned by this user.

### POST /v1/github/disconnect

Mark an installation deleted locally (user should also uninstall on GitHub).

Request body:
```json
{ "installation_id": "01J..." }
```

Response (200): `{}` — repos disabled.

Errors: `403` not owned by this user.

---

## Review endpoints

### POST /v1/review

Trigger a review of a diff (PR-style) or a whole-repo scan.

Request body:
```json
{
  "repo": "owner/name",          // required, slug
  "pr": 123,                      // optional GitHub PR number (for posting back)
  "head_sha": "abc123",           // optional, anchors comments
  "base_sha": "def456",           // optional
  "diff": "<unified diff>",       // either diff OR files[] required
  "files": [                      // alternative to diff
    {"path":"src/x.ts","status":"modified","patch":"@@ ...","contents":"..."}
  ],
  "sync": true                    // true = run inline & return result; false = 202 + poll
}
```

Response (sync=true, 200):
```json
{
  "review_id": "01J...",
  "status": "completed",
  "score_0_5": 2,
  "summary_md": "…",
  "findings": [
    {
      "fingerprint": "abc123def4567890",
      "file_path": "src/db.ts",
      "start_line": 42,
      "end_line": 42,
      "side": "RIGHT",
      "severity": "high",
      "cwe": ["CWE-89"],
      "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      "cvss_score": 9.8,
      "confidence": "high",
      "reachable": true,
      "verification_status": "verified",
      "category": "SQL Injection",
      "title": "SQLi in query builder",
      "rationale_md": "User input flows unparameterized into the query…",
      "poc_md": "`' OR 1=1--`",
      "fix_prompt_md": "Use parameterized queries / bound parameters…"
    }
  ]
}
```

Response (sync=false, 202): `{ "review_id": "01J...", "status": "queued" }` — then poll.

### GET /v1/review/:id

Returns the same shape as the sync response once `status` is `completed`
(`queued`/`running`/`failed` while in flight).

### GET /v1/review/repos

List the caller's connected repos: `[{id, scm, owner, name, default_branch, status}]`.

### POST /v1/review/whitebox

Launch a whitebox (whole-repo) scan: `{repo_id?}` or `{repo, clone_url?, ref?}` →
`202 {review_id}`. Poll `GET /v1/review/:id`.

### POST /v1/review/:id/feedback

Submit signal feedback for a finding. Trains the team filter.

Request body:
```json
{ "fingerprint": "abc123", "signal": "down" }
```

---

## Actionable findings

A finding is **actionable** when `severity` ∈ {critical, high, medium} AND
`reachable !== false` AND `verification_status === "verified"`. `low`/`informational`
findings are advisory. The loop's stop condition is `score_0_5 == 5` AND zero
actionable findings.

## Scoring (deterministic)

`score_0_5` is computed by a deterministic CVSS gate (worst-severity), NOT by the
LLM — so it cannot be gamed by prompt manipulation. `cvss_score`/`severity` derive
from the model's decomposed CVSS vector via the official CVSS 3.1 equation.

## Re-trigger via PR comment

Posting `@sthrip review` (case-insensitive) in a PR comment on an enabled repo
triggers a fresh review (ignored if one is already running for that PR).

## Edit-in-place summary marker

The Sthrip summary comment on a PR contains the marker `<!-- sthrip:fp:* -->`.
Sthrip edits this comment in place on every review cycle — it is never duplicated.
Always sort PR comments by `updated_at` descending and pick the first one with
this marker to get the current score.
