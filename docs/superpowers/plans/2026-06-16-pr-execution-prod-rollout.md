# PR Execution Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship TREX-style Vercel Sandbox PR execution to production behind a safe, gradual rollout.

**Architecture:** The API server remains a control plane only: it signs execution payloads and calls a dedicated internal worker URL. The production worker runs as a separate container on the GCP API VM, uses Vercel Sandbox for untrusted branch execution, receives only explicit worker credentials, and returns bounded artifacts to the API for persistence/display.

**Tech Stack:** Bun/Hono, SQLite migrations, Docker Compose on GCP Compute Engine, Vercel Sandbox SDK, Vercel-hosted Vite site, Playwright headless verification.

---

### Task 1: Worker Credentials And PR-Only Runtime

**Files:**
- Modify: `vps-agent/src/pr-execution.ts`
- Modify: `vps-agent/src/agent.ts`
- Modify: `vps-agent/tests/pr-execution.test.ts`
- Modify: `vps-agent/tests/agent.test.ts`
- Modify: `vps-agent/.env.example`

- [ ] **Step 1: Add a failing credential passthrough test**

Add a Vercel Sandbox test that runs `runPrExecution` with explicit credentials:

```ts
const fake = makeSandbox();
await runPrExecution({
  input: INPUT,
  sandboxProvider: "vercel-sandbox",
  vercelSandbox: {
    createSandbox: fake.createSandbox,
    token: "vercel_test_token",
    teamId: "team_test",
    projectId: "prj_test",
  },
});
expect(fake.createParams[0]).toMatchObject({
  token: "vercel_test_token",
  teamId: "team_test",
  projectId: "prj_test",
});
```

Run: `bun test vps-agent/tests/pr-execution.test.ts`
Expected: FAIL before implementation because the credential fields are not accepted/passed.

- [ ] **Step 2: Add the minimal credential type fields and passthrough**

Extend the Vercel sandbox options with `token`, `teamId`, and `projectId`, and include only provided non-empty values in `Sandbox.create(...)`.

Run: `bun test vps-agent/tests/pr-execution.test.ts`
Expected: PASS.

- [ ] **Step 3: Add PR-only startup validation**

Add `STHRIP_PR_EXECUTION_ONLY=true` handling in `vps-agent/src/agent.ts` so the dedicated worker can boot without scan-only env (`TENSOL_SIGN_KEY`, `TENSOL_SCAN_ID`). Require `STHRIP_PR_EXECUTION_WORKER_SECRET` in PR-only mode, reject partial Vercel credential triples, and never log secret values.

Run: `bun test vps-agent/tests/agent.test.ts`
Expected: PASS with coverage for PR-only `/healthz`, `/pr-execution`, and `/scan` disabled/unavailable behavior.

- [ ] **Step 4: Verify agent build**

Run: `bunx tsc --noEmit --project vps-agent/tsconfig.json`
Expected: no type errors.

### Task 2: Separate Production Worker

**Files:**
- Modify: `infra/prod/docker-compose.prod.yml`
- Modify: `infra/prod/deploy.sh`
- Modify: `infra/prod/.env.prod.example`
- Create: `infra/prod/.env.pr-execution-worker.example`
- Modify: `infra/prod/README.md`

- [ ] **Step 1: Add `pr-execution-worker` compose service**

Build `vps-agent/Dockerfile` as `tensol-pr-execution-worker:latest`, run it with `STHRIP_PR_EXECUTION_ONLY=true`, mount only `/opt/tensol/.env.pr-execution-worker`, do not publish any port, and healthcheck `http://127.0.0.1:8080/healthz` inside the container.

Run: `docker compose -f infra/prod/docker-compose.prod.yml config`
Expected: config renders both `server` and `pr-execution-worker` services.

- [ ] **Step 2: Wire API to internal worker URL**

Set API production env template values:

```dotenv
STHRIP_PR_EXECUTION_ENABLED=false
STHRIP_PR_EXECUTION_WORKER_URL=http://pr-execution-worker:8080/pr-execution
STHRIP_PR_EXECUTION_WORKER_SECRET=REPLACE_ME_32_HEX_BYTES
```

Set separate worker env template values:

```dotenv
STHRIP_PR_EXECUTION_WORKER_SECRET=REPLACE_ME_32_HEX_BYTES
STHRIP_PR_EXECUTION_SANDBOX_PROVIDER=vercel-sandbox
VERCEL_TOKEN=REPLACE_ME_VERCEL_ACCESS_TOKEN
VERCEL_TEAM_ID=team_REPLACE_ME
VERCEL_PROJECT_ID=prj_REPLACE_ME
```

Expected: default global flag stays dark while the worker can be deployed and directly smoke-tested.

- [ ] **Step 3: Add deploy preflight for Vercel Sandbox credentials**

In `deploy.sh`, create/check `/opt/tensol/.env.pr-execution-worker`, fail early when its `STHRIP_PR_EXECUTION_SANDBOX_PROVIDER=vercel-sandbox` and neither managed `VERCEL_OIDC_TOKEN` nor the complete `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` triple is present, and require `STHRIP_PR_EXECUTION_WORKER_SECRET` to match `/opt/tensol/.env.prod`.

Run: `bash -n infra/prod/deploy.sh`
Expected: no syntax errors.

### Task 3: API Migration And Site Deploy

**Files:**
- Existing: `server/migrations/0017_pr_execution_artifacts.sql`
- Existing: `server/scripts/migrate.ts`
- Existing: `apps/site/vercel.json`

- [ ] **Step 1: Commit and push reviewed branch**

Run:

```bash
git add .
git commit -m "Enable isolated PR execution rollout"
git push -u origin codex/trex-execution-layer
```

Expected: pushed commit SHA is available to the production VM deploy script.

- [ ] **Step 2: Deploy API and run migration on the GCP VM**

Run from local operator shell:

```bash
gcloud compute ssh sthrip-api-prod \
  --project=tensol-scanners \
  --zone=europe-west1-b \
  --command 'sudo REPO_BRANCH=codex/trex-execution-layer REPO_REF=<commit-sha> /opt/tensol/repo/infra/prod/deploy.sh'
```

Expected: deploy logs show server image build, PR worker image build, `bun run scripts/migrate.ts`, compose up, and Caddy reload.

- [ ] **Step 3: Deploy site to Vercel**

Run from `apps/site`:

```bash
vercel deploy --prod --scope team_CaXiSOIjyP75I8ktaKpwPY9k
```

Expected: deployment is READY and aliased to `https://sthrip.dev`.

### Task 4: Gradual Flags

**Files:**
- Production env: `/opt/tensol/.env.prod`
- Production database: `/opt/tensol/data/tensol.db`

- [ ] **Step 1: Verify dark deploy**

Run:

```bash
curl -fsS https://api.sthrip.dev/v1/config/feature-flags
```

Expected: `pr_execution_enabled` is `false` after deploy.

- [ ] **Step 2: Smoke the worker directly from the VM network**

Run on the VM:

```bash
NOW=$(date +%s)
EXP=$((NOW + 300))
NONCE=$(openssl rand -hex 16)
BODY=$(printf '{"type":"pr_execution","iat":%s,"exp":%s,"nonce":"%s","aud":"sthrip-pr-worker","input":{"reviewId":"prod-smoke","repoId":"octocat-hello","owner":"octocat","name":"Hello-World","prNumber":1,"headSha":"7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"}}' "$NOW" "$EXP" "$NONCE")
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$STHRIP_PR_EXECUTION_WORKER_SECRET" -hex | awk '{print "sha256="$2}')
docker exec tensol-server wget -qO- --header="content-type: application/json" --header="x-sthrip-execution-signature: $SIG" --post-data="$BODY" http://pr-execution-worker:8080/pr-execution
```

Expected: JSON status is `passed` and includes runtime artifacts.

- [ ] **Step 3: Enable global flag, then one repository**

Set `STHRIP_PR_EXECUTION_ENABLED=true` in `/opt/tensol/.env.prod`, redeploy compose, and set `review_repos.pr_execution_enabled=1` for one controlled repository.

Expected: `/v1/config/feature-flags` reports `pr_execution_enabled: true`; only the selected repository dispatches runtime execution.

### Task 5: Real Production Verification

**Files:**
- Existing: `apps/site/e2e/real-prod-smoke.spec.ts`
- Existing: `apps/site/playwright.real-prod.config.ts`

- [ ] **Step 1: Run local gates**

Run:

```bash
bunx tsc --noEmit --project vps-agent/tsconfig.json
bun run --cwd vps-agent test
bun run --cwd server test
bun run --cwd apps/site build
bun run --cwd server check:no-secrets
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Run production headless smoke**

Run:

```bash
bunx playwright test --config apps/site/playwright.real-prod.config.ts
```

Expected: production site/API smoke passes headlessly.

- [ ] **Step 3: Verify runtime evidence in a real production review**

Trigger a PR review on the controlled repository after global + repo flags are on, then inspect:

```sql
select execution_status, execution_summary_md from reviews order by created_at desc limit 3;
select kind, label, byte_size from review_execution_artifacts order by created_at desc limit 10;
```

Expected: latest production review has `execution_status` in `passed` or `failed` and at least one bounded runtime artifact; dashboard review detail renders the evidence.
