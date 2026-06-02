# GitHub GraphQL Queries — sthrip-check-pr

Base endpoint: `https://api.github.com/graphql`
Authentication: `Authorization: bearer $GITHUB_TOKEN`

---

## 1. List pull request review threads

Fetches all review threads on a PR, including the thread resolution state,
the comment body/author/timestamps, and each comment's database ID (needed
for resolving).

```graphql
query ListReviewThreads($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      title
      bodyText
      state
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id               # global node ID — pass to resolveReviewThread
          isResolved
          isOutdated
          isCollapsed
          path
          startLine
          line
          comments(first: 20) {
            nodes {
              id
              databaseId
              body
              createdAt
              updatedAt
              author {
                login
              }
              pullRequestReview {
                state        # APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
              }
            }
          }
        }
      }
    }
  }
}
```

Pagination: re-run with `cursor = pageInfo.endCursor` while `hasNextPage`.

---

## 2. List all PR comments (for finding the Sthrip summary)

Issue comments (not review comments) include the edit-in-place Sthrip summary
comment. Sorted by `updatedAt` DESC by the client after fetching.

```graphql
query ListPRComments($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      comments(first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          databaseId
          body
          createdAt
          updatedAt
          author {
            login
          }
        }
      }
    }
  }
}
```

**Read-latest-summary rule**: filter nodes whose `body` contains
`<!-- tensol:fp:` and take `[0]` (first = most recently updated due to DESC
sort). This avoids the edit-in-place gotcha where the creation timestamp is
always the first review cycle.

---

## 3. List check-runs for the head commit

```graphql
query ListCheckRuns($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      headRef {
        target {
          ... on Commit {
            checkSuites(first: 20, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                app {
                  name
                }
                checkRuns(first: 50) {
                  nodes {
                    id
                    name
                    status       # QUEUED | IN_PROGRESS | COMPLETED
                    conclusion   # SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | null
                    detailsUrl
                    completedAt
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

A check-run is **actionable** when `status == COMPLETED` AND `conclusion` is
one of `FAILURE | TIMED_OUT | ACTION_REQUIRED`. Whether it is *required* is
determined by the branch protection rules (not available via GraphQL without
admin scope); treat any `FAILURE` conclusion as actionable by default.

---

## 4. Resolve a review thread

Marks a review thread as resolved. Requires the token to have `repo` scope
(or `pull_request_threads` fine-grained permission).

```graphql
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
```

Variables: `{ "threadId": "<global node ID from ListReviewThreads.nodes[i].id>" }`

---

## 5. Unresolve a review thread (rollback)

If the host agent determines a thread was resolved prematurely (e.g. a fix
introduced a regression), it can unresolve:

```graphql
mutation UnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
```

---

## cURL example

```bash
# List review threads
OWNER=my-org NAME=my-repo PR=42
curl -s -X POST https://api.github.com/graphql \
  -H "Authorization: bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json, sys
query = open('list-review-threads.graphql').read()
print(json.dumps({'query': query, 'variables': {'owner': '$OWNER', 'name': '$NAME', 'prNumber': $PR}}))
")"

# Resolve a thread
THREAD_ID=PRT_kwDOHxx...
curl -s -X POST https://api.github.com/graphql \
  -H "Authorization: bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation ResolveReviewThread(\$threadId: ID!) { resolveReviewThread(input: { threadId: \$threadId }) { thread { id isResolved } } }\",\"variables\":{\"threadId\":\"$THREAD_ID\"}}"
```

---

## Notes

- The global node ID (e.g. `PRT_kwDO...`) is opaque and must be fetched fresh —
  do not hardcode or persist it across PR rebases (the thread may be recreated).
- Resolving a thread that is already resolved is a no-op (idempotent).
- `isOutdated` threads (on stale commits) cannot be resolved via the API;
  they must be dismissed manually or will resolve automatically on the next
  push.
