# Tensol Review API (used by tensol-loop)

Base: `$TENSOL_API_BASE` (default `https://api.tensol.ru`). Cookie-authenticated
(`tensol_session`). All bodies/responses are JSON, snake_case.

## POST /v1/review

Trigger a review of a diff (PR-style) or a whole-repo whitebox scan.

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

## GET /v1/review/:id

Returns the same shape as the sync response once `status` is `completed`
(`queued`/`running`/`failed` while in flight).

## GET /v1/review/repos

List the caller's connected repos: `[{id, scm, owner, name, default_branch, status}]`.

## POST /v1/review/whitebox

Launch a whitebox (whole-repo) scan: `{repo_id?}` or `{repo, clone_url?, ref?}` →
`202 {review_id}`. Poll `GET /v1/review/:id`.

## Actionable findings

A finding is **actionable** when `severity` ∈ {critical, high, medium} AND
`reachable !== false`. `low`/`informational` findings are advisory. The loop's
stop condition is `score_0_5 == 5` AND zero actionable findings.

## Scoring (deterministic)

`score_0_5` is computed by a deterministic CVSS gate (worst-severity), NOT by the
LLM — so it cannot be gamed by prompt manipulation. `cvss_score`/`severity` derive
from the model's decomposed CVSS vector via the official CVSS 3.1 equation.
