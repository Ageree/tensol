# PR Execution Validation

## Goal

Add a default-off PR execution layer for Sthrip reviews: when enabled for a
repository, the PR reviewer can dispatch the immutable branch head to an
isolated execution worker, collect runtime evidence, persist artifacts, and
show that evidence in GitHub and the dashboard.

Competitor reference: Greptile TREX frames the feature as code-review execution
that runs the branch, mocks APIs, clicks UI, writes/runs tests, and attaches
logs, screenshots, API traces, scripts, and video evidence.

## Architecture

The API server is the control plane, not the sandbox. It decides whether PR
execution is enabled, creates the review record, dispatches to a configured
execution worker, stores bounded evidence metadata/inline summaries, then feeds
the resulting evidence summary into the existing review post.

Execution workers own untrusted-code isolation. Production execution requires a
remote worker endpoint and shared secret; no fallback runs customer code inside
the API server process.

The VPS agent exposes the first worker implementation at `/pr-execution`: it
verifies the server HMAC, checks out the immutable head SHA into a temporary
workspace, then runs dependency install and the repository's existing
typecheck/test/build/headless E2E scripts inside the configured sandbox backend.
Local/dev can use the Docker backend; production can use Vercel Sandbox
Firecracker microVMs by setting `STHRIP_PR_EXECUTION_SANDBOX_PROVIDER=vercel-sandbox`
and the standard Vercel SDK credentials. Runtime commands switch to no network
egress after dependency setup so PR code cannot reach metadata or internal
services. The worker returns bounded evidence artifacts and fails closed if the
sandbox runtime is unavailable.

Convex remains the future control-plane candidate: the schema should expose the
same execution status and artifact shapes so the dashboard can move from the
Bun API to Convex without inventing a second contract.

## Implementation Tasks

1. Data model and types
   - Add repository-level `pr_execution_enabled`.
   - Add review-level `execution_status` and `execution_summary_md`.
   - Add `review_execution_artifacts` for logs, screenshots, API traces,
     generated tests, videos, and generic files.
   - Add shared TypeScript review execution types.

2. Execution runner boundary
   - Add `PrExecutionRunner` interface and remote-worker adapter.
   - Require immutable PR head SHA, bounded artifacts, and no local execution.
   - Convert worker results into markdown evidence summary.
   - Add a signed VPS-agent `/pr-execution` worker for real headless execution.

3. PR review pipeline
   - When global and repo flags are enabled, run execution before the LLM review.
   - Persist success/failure/skipped evidence without failing the static review.
   - Append compact runtime evidence to the posted review summary.

4. API and dashboard
   - Add repo settings update support for runtime execution.
   - Return execution fields/artifacts from review detail and list responses.
   - Show Runtime evidence in review detail and a repo-level toggle in reviews.

5. Convex contract
   - Mirror execution status and artifacts in Convex validators/schema.
   - Keep Convex as metadata/control-plane only; no untrusted code execution.

6. Specs and Dox
   - Extend PR review spec with execution validation requirements.
   - Clarify that whitebox's no-new-execution non-goal does not block this
     separate, isolated PR feature.
   - Update local Dox only if durable contracts changed.

## Verification

Minimum checks:

```bash
bun run --cwd server test src/review/service.test.ts src/jobs/handlers/pr-review.test.ts src/routes/review.test.ts
bun run --cwd server test
bun run --cwd apps/site typecheck
bun run --cwd vps-agent test
HEADLESS=1 <local service + Playwright smoke for Runtime execution toggle/detail evidence>
npx gitnexus detect-changes --scope all --repo tensol
git diff --check
```

Review gates:

1. Security reviewer: execution boundary and artifact trust model.
2. Code reviewer: service/router/UI integration.
3. Dox pass: confirm documentation updates are sufficient and not stale.
