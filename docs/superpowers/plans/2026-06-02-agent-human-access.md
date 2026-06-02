# Agent and Human Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sthrip usable by humans through the dashboard and by AI agents through CLI and MCP.

**Architecture:** Keep the existing `/v1/review` dashboard API stable, then add a narrow `/v1/agent` API protected by hashed bearer tokens. The CLI and MCP server are thin clients over the same agent API, so human and agent access share one contract and one test surface.

**Tech Stack:** Bun, Hono, Drizzle/SQLite, React/Vite, newline-delimited MCP stdio JSON-RPC.

---

## Existing Baseline

- Human dashboard already uses `apps/site/src/pages/Reviews.tsx`, `ReviewDetail.tsx`, `api-client.ts`, and `/v1/review`.
- Dirty baseline already adds `reviews.mode`, `research_enabled`, `exploit_enabled`, and mode-aware whitebox launch.
- Auth is currently session-cookie only via `createRequireAuth`; this is not a stable agent contract.
- There is no external job status endpoint; agents can poll review detail but cannot inspect job attempts/error by `job_id`.
- Root policy says no new dependencies without explicit request, so MCP will be implemented as a minimal stdio JSON-RPC server using the official newline-delimited stdio transport shape.

## Public Contracts To Add

### Agent Tokens

- `POST /v1/agent/tokens` (cookie-authenticated dashboard route): create a token for the current user.
- `GET /v1/agent/tokens` (cookie-authenticated): list token metadata.
- `DELETE /v1/agent/tokens/:id` (cookie-authenticated): revoke token.
- Token plaintext is returned only once. Store only SHA-256 token hash and prefix metadata.

### Agent API

Bearer token header: `Authorization: Bearer sthrip_<random>`.

- `GET /v1/agent/health` -> `{ ok, service, user, features }`.
- `GET /v1/agent/reviews` -> same review list semantics as dashboard, plus `mode`.
- `GET /v1/agent/reviews/:id` -> review detail and findings, owner-scoped.
- `GET /v1/agent/reviews/:id/findings` -> findings-only view.
- `POST /v1/agent/whitebox` -> start whitebox scan using `{ repo_id? repo? ref? mode? }`.
- `GET /v1/agent/jobs/:id` -> owner-scoped job status for jobs associated with the caller's review.

### CLI

Entry: `bun run src/cli/index.ts ...` from `server`.

- `health`
- `reviews list`
- `reviews get <id>`
- `whitebox start --repo owner/name [--ref ref] [--mode fast|deep]`
- `jobs get <id>`

Config comes from `STHRIP_API_URL` and `STHRIP_API_TOKEN`.

### MCP

Entry: `bun run src/mcp/server.ts` from `server`.

Tools:

- `sthrip_health`
- `sthrip_list_reviews`
- `sthrip_get_review`
- `sthrip_list_findings`
- `sthrip_start_whitebox`
- `sthrip_get_job`

The MCP server reads `STHRIP_API_URL` and `STHRIP_API_TOKEN`, uses stderr for logs, and writes only JSON-RPC messages to stdout.

## Tasks

### Task 1: Agent Token Storage And Auth

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/migrations/0015_agent_tokens.sql`
- Create: `server/src/agent/tokens.ts`
- Create: `server/src/agent/auth.ts`
- Test: `server/src/agent/tokens.test.ts`

- [ ] Write failing tests for token creation, SHA-256 hash storage, prefix metadata, authenticate success, revoked-token rejection, malformed-token rejection.
- [ ] Add `agent_api_tokens` table and Drizzle schema.
- [ ] Implement token generation as `sthrip_` + at least 32 bytes of random entropy encoded url-safe.
- [ ] Implement `createAgentToken`, `listAgentTokens`, `revokeAgentToken`, `authenticateAgentToken`.
- [ ] Run `bun test src/agent/tokens.test.ts`.

### Task 2: Agent Routes And Job Status

**Files:**
- Create: `server/src/routes/agent.ts`
- Modify: `server/src/server.ts`
- Test: `server/src/routes/agent.test.ts`

- [ ] Run GitNexus impact for `createApp` before changing route assembly.
- [ ] Write failing route tests for token CRUD with cookie auth, bearer-auth health, list/get reviews, findings-only, whitebox launch, job status, and cross-user denial.
- [ ] Implement `/v1/agent/*` route factory with two auth lanes: cookie auth for token management and bearer auth for agent operations.
- [ ] Add owner-scoped `GET /jobs/:id` by resolving the job payload's `reviewId` and checking the review owner.
- [ ] Mount the route in `createApp`.
- [ ] Run `bun test src/routes/agent.test.ts src/routes/review.test.ts src/routes/config-feature-flags.test.ts`.

### Task 3: CLI Client

**Files:**
- Create: `server/src/agent/client.ts`
- Create: `server/src/cli/index.ts`
- Test: `server/src/agent/client.test.ts`
- Test: `server/src/cli/index.test.ts`
- Modify: `server/package.json`

- [ ] Write failing tests for request URL construction, bearer headers, JSON error handling, and CLI command output.
- [ ] Implement a small fetch client around the `/v1/agent` API.
- [ ] Implement CLI argument parsing without new dependencies.
- [ ] Add package scripts `agent:cli` and `agent:mcp`.
- [ ] Run `bun test src/agent/client.test.ts src/cli/index.test.ts`.

### Task 4: MCP Stdio Server

**Files:**
- Create: `server/src/mcp/protocol.ts`
- Create: `server/src/mcp/server.ts`
- Test: `server/src/mcp/protocol.test.ts`
- Test: `server/src/mcp/server.test.ts`

- [ ] Write failing tests for `initialize`, `tools/list`, `tools/call`, invalid tool handling, and stdout cleanliness.
- [ ] Implement newline-delimited JSON-RPC stdio handling.
- [ ] Map each MCP tool to `server/src/agent/client.ts`.
- [ ] Ensure logs go to stderr only.
- [ ] Run `bun test src/mcp/protocol.test.ts src/mcp/server.test.ts`.

### Task 5: Dashboard Token Onboarding And Mode Visibility

**Files:**
- Modify: `apps/site/src/lib/api-client.ts`
- Modify: `apps/site/src/pages/Settings.tsx`
- Modify: `apps/site/src/pages/Reviews.tsx`
- Modify: `apps/site/src/pages/ReviewDetail.tsx`
- Modify: `apps/site/src/i18n.ts`
- Test: `apps/site/src/lib/api-client.test.ts`

- [ ] Run GitNexus impact for modified frontend symbols before edits.
- [ ] Write failing client tests for token create/list/revoke and mode fields.
- [ ] Add API client methods for `/v1/agent/tokens`.
- [ ] Add Settings panel to create, copy once, list, and revoke agent tokens.
- [ ] Show `mode` in review list/detail.
- [ ] Keep layout compact and dashboard-like; no marketing page.
- [ ] Run `bun test src/lib/api-client.test.ts` and `bunx tsc --noEmit` in `apps/site`.

### Task 6: Independent Verification And Fix Loop

**Files:**
- All files changed by Tasks 1-5.

- [ ] Spawn an independent verifier with no forked context to review server/API contracts.
- [ ] Spawn an independent verifier with no forked context to exercise CLI/MCP tests.
- [ ] Spawn an independent frontend verifier for dashboard/token UI.
- [ ] Run server focused tests, site typecheck/client tests, and a final `git diff --check`.
- [ ] Run `gitnexus_detect_changes(scope: "all")` and review affected processes.
- [ ] Fix every material verifier finding, then rerun the relevant tests.
