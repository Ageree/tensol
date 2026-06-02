# GitLab REST API — sthrip-check-pr

Base: `$GITLAB_BASE_URL` (default `https://gitlab.com`).
Auth: `PRIVATE-TOKEN: $GITLAB_TOKEN` header, or `Authorization: Bearer $GITLAB_TOKEN`.
Project is identified by URL-encoded `:id` = `owner%2Frepo` or the numeric project ID.

---

## 1. List merge request discussions (= review threads)

```
GET /projects/:id/merge_requests/:mr_iid/discussions
```

Query params:
- `page=1&per_page=100` (paginate with `X-Next-Page` header)

Response: array of discussion objects.

```json
[
  {
    "id": "abc123",
    "individual_note": false,
    "notes": [
      {
        "id": 1234,
        "type": "DiffNote",
        "body": "SQL injection risk here",
        "author": { "username": "sthrip-bot" },
        "created_at": "2026-05-01T10:00:00.000Z",
        "updated_at": "2026-05-29T12:00:00.000Z",
        "resolvable": true,
        "resolved": false,
        "resolved_by": null,
        "position": {
          "new_path": "src/db.ts",
          "new_line": 42,
          "line_range": { "start": { "line_code": "abc", "type": "new" }, "end": null }
        }
      }
    ]
  }
]
```

**Read-latest-summary rule**: filter notes whose `body` contains
`<!-- tensol:fp:`, then sort by `updated_at` DESC and take the first. This
surfaces the most-recently-edited Sthrip summary note, avoiding the
edit-in-place gotcha.

Pagination headers:
```
X-Total: 42
X-Total-Pages: 1
X-Page: 1
X-Per-Page: 100
X-Next-Page:          (empty = last page)
X-Prev-Page:          (empty = first page)
```

---

## 2. Resolve a discussion

Marks the whole discussion (thread) as resolved.

```
PUT /projects/:id/merge_requests/:mr_iid/discussions/:discussion_id
```

Body: `{ "resolved": true }`

Response: the updated discussion object (same shape as in §1).

To unresolve: same endpoint with `{ "resolved": false }`.

---

## 3. Resolve a single note within a discussion

```
PUT /projects/:id/merge_requests/:mr_iid/discussions/:discussion_id/notes/:note_id
```

Body: `{ "resolved": true }`

Use when you want to resolve a specific note rather than the entire thread.

---

## 4. List pipeline jobs (= check-runs equivalent)

```
GET /projects/:id/merge_requests/:mr_iid/pipelines
```

Returns pipelines associated with the MR. Then fetch individual jobs:

```
GET /projects/:id/pipelines/:pipeline_id/jobs
```

Response (array):
```json
[
  {
    "id": 5678,
    "name": "test:unit",
    "stage": "test",
    "status": "failed",   // created | pending | running | failed | success | canceled | skipped | manual | scheduled
    "allow_failure": false,
    "web_url": "https://gitlab.com/owner/repo/-/jobs/5678"
  }
]
```

A job is **actionable** when `status == "failed"` AND `allow_failure == false`.

---

## 5. Get MR details (description + state)

```
GET /projects/:id/merge_requests/:mr_iid
```

Response (excerpt):
```json
{
  "iid": 42,
  "title": "feat: add rate-limiting middleware",
  "description": "## Summary\n...",
  "state": "opened",   // opened | closed | locked | merged
  "merge_status": "can_be_merged",
  "blocking_discussions_resolved": false,
  "sha": "abc123"
}
```

---

## cURL examples

```bash
GITLAB_BASE="${GITLAB_BASE_URL:-https://gitlab.com}"
PROJECT="owner%2Frepo"
MR_IID=42

# List discussions (threads)
curl -s "${GITLAB_BASE}/api/v4/projects/${PROJECT}/merge_requests/${MR_IID}/discussions?per_page=100" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN"

# Resolve a discussion
curl -s -X PUT \
  "${GITLAB_BASE}/api/v4/projects/${PROJECT}/merge_requests/${MR_IID}/discussions/${DISCUSSION_ID}" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resolved": true}'

# List pipelines for MR
curl -s "${GITLAB_BASE}/api/v4/projects/${PROJECT}/merge_requests/${MR_IID}/pipelines" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN"

# List jobs for a pipeline
curl -s "${GITLAB_BASE}/api/v4/projects/${PROJECT}/pipelines/${PIPELINE_ID}/jobs?per_page=100" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN"
```

---

## Self-hosted GitLab

Replace `https://gitlab.com` with `$GITLAB_BASE_URL`, e.g.
`https://gitlab.example.com`. The API path `/api/v4/` is the same for GitLab
CE/EE 13.0 and above.

For GitLab EE with SAML SSO, the token must be a personal access token (PAT)
with `api` scope issued by a user whose session is active. Group tokens work
for project-scoped calls if the token has the `api` scope.

---

## Notes

- GitLab `individual_note: true` entries are standalone comments, not threads;
  they cannot be resolved via the discussions API. Treat them as informational.
- `resolvable: false` on a note means the note type does not support resolution
  (e.g. a system note). Skip these when calling the resolve endpoint.
- The Sthrip bot posts `DiffNote` entries (tied to a file/line position). Filter
  by `type == "DiffNote"` AND `author.username == "sthrip-bot"` (or the
  configured bot username) to find Sthrip-specific threads.
