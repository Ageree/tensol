# GitHub GraphQL Queries (used by sthrip-loop)

These queries are used when interacting with GitHub PRs via the GraphQL API.
Endpoint: `POST https://api.github.com/graphql`
Auth: `Authorization: Bearer <token>` (installation token from Sthrip).

---

## Resolve a review thread

When Sthrip detects a finding has been remediated (fingerprint absent from the
new review cycle), it auto-resolves the corresponding PR review thread.

```graphql
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
      resolvedBy {
        login
      }
    }
  }
}
```

Variables:
```json
{ "threadId": "PRRT_kwDOA..." }
```

---

## List PR review threads (with resolution state)

Used to find unresolved threads matching a Sthrip fingerprint anchor, and to
check which threads have already been auto-resolved.

```graphql
query ListPRReviewThreads($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          startLine
          line
          comments(first: 1) {
            nodes {
              id
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
  }
}
```

The `body` of the first comment in each thread may contain the
`<!-- sthrip:fp:<fingerprint> -->` marker — use this to match threads to findings.

---

## Get PR comments sorted by updatedAt (edit-in-place summary)

Sthrip edits its summary comment in place. To read the latest score, fetch all
PR comments and sort by `updatedAt` descending; the first comment whose body
contains `<!-- sthrip:fp:* -->` is the current summary.

```graphql
query GetPRComments($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          id
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

Parse the score with:
```
/Sthrip (\d)\/5/
```

The `<!-- sthrip:fp:* -->` marker is present only in the summary comment; plain
informational comments (e.g. over-capacity notices) do NOT carry it.

---

## Check run status

When `statusCheckEnabled` is true, Sthrip posts a `Sthrip N/5` check run.
Query to read its conclusion:

```graphql
query GetCheckRuns($owner: String!, $repo: String!, $sha: String!) {
  repository(owner: $owner, name: $repo) {
    object(expression: $sha) {
      ... on Commit {
        checkSuites(first: 20) {
          nodes {
            checkRuns(first: 20, filterBy: { appId: <GITHUB_APP_ID> }) {
              nodes {
                name
                status
                conclusion
                detailsUrl
                output {
                  title
                  summary
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

`conclusion` values: `success`, `failure`, `neutral`, `cancelled`, `skipped`,
`timed_out`, `action_required`. Sthrip uses `failure` when
`mergeBlockOnCritical=true` and a verified critical finding exists; otherwise
`neutral` (score < 5) or `success` (score = 5).
