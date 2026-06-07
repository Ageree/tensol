# Phase 0 Research — Backend v2

All major technology choices were locked during brainstorming. This document records the implementation-relevant decisions made *during planning* that affect how each chosen technology is used.

## Decision 1 — Hetzner Cloud cloud-init shape

**Decision**: Provision Hetzner Cloud servers using their REST API with a `user_data` field containing a minimal cloud-init script that installs Bun and Docker, pulls the Decepticon image, deploys the `vps-agent/` binary, and starts both.

**Rationale**: Hetzner Cloud servers boot from a Linux image (Ubuntu 24.04 LTS chosen) and accept `cloud-init` user-data at creation time. The script must be short and reliable — every line of it is hard to debug after the fact. Heavy lifting (image download, dependency install) happens on the VPS itself, not on the API caller, which keeps `spawnVps()` synchronous-ish (returns quickly with a "provisioning" status, async polling drives the rest).

**Alternatives considered**:

- Building a custom Hetzner snapshot/image with everything pre-installed → faster boot but adds an offline build pipeline. Defer until median spawn time exceeds 3 minutes.
- DigitalOcean droplets → comparable API, slightly more expensive, less RU-friendly egress. Worse fit for the buyer profile.
- GCP → on the table per memory `project_tensol_runtime_readiness_2026-05-12.md` for RU egress, but adds a second provider before MVP demands it. Deferred to enterprise tier.

**Implications**:

- `vps/hetzner.ts` is `~200` lines: thin wrappers over `POST /servers`, `GET /servers/:id`, `DELETE /servers/:id` plus a cloud-init script string builder.
- The `vps-agent/` binary must be self-contained — we ship a Dockerfile that bakes the agent into an image hosted on a public registry (GHCR), the cloud-init script then `docker run`s it.
- Hetzner API token lives in `HETZNER_API_TOKEN` env; one token per environment.

## Decision 2 — Resend integration

**Decision**: Use `resend` SDK in `src/email/resend-client.ts`. Sender domain is `tensol.io` (the apex). One template: `magic-link.ts`. Env-gated alternative: when `EMAIL_PROVIDER=stdout`, the client just `console.log`s the link instead of sending — used in local development and integration tests.

**Rationale**: Resend is one SDK, one env var, no SMTP configuration. The dual-mode (stdout vs. real send) follows Constitution IV: one implementation, with a clean conditional rather than an interface and two adapters.

**Alternatives considered**:

- Postmark — similar quality, more expensive.
- AWS SES — cheapest but heavier setup (DKIM/SPF/IAM/sandbox-exit), wrong fit for solo MVP.
- Self-hosted SMTP via `nodemailer` → operationally painful; deliverability nightmare on a small mail volume.

**Implications**:

- `RESEND_API_KEY` env in prod; `EMAIL_PROVIDER=stdout` in dev / tests.
- DNS records for `tensol.io` (SPF, DKIM, return-path) must be set during deploy; tracked outside this plan.

## Decision 3 — Public webhook reachability

**Decision**: In production, the backend is reverse-proxied by an nginx or Caddy in front of the deploy host on a public subdomain (`api.tensol.io`). In local development, run `cloudflared tunnel --url http://localhost:3000` and set `TENSOL_WEBHOOK_BASE_URL` to the tunnel URL.

**Rationale**: The VPS agent must reach the backend over HTTPS to deliver scan results. A public tunnel during dev keeps the dev loop short without depending on a staging server. cloudflared is free, has no account requirement for ephemeral tunnels, and works on both macOS and Linux.

**Alternatives considered**:

- ngrok → paid for stable URLs, otherwise rotates every restart and breaks long-running scans.
- Localtunnel → works but unstable.
- Telling the VPS to push back over the cloud provider's private network → only works if both backend and VPS are in the same Hetzner project, which is not the case (backend may run anywhere).

**Implications**:

- `server/README.md` documents the cloudflared step.
- `TENSOL_WEBHOOK_BASE_URL` is read in `config.ts` and embedded into every `spawnVps()` payload sent to the VPS agent.

## Decision 4 — Audit canonical message format

**Decision**: Keep the 13-field, pipe-delimited canonical message with alpha-sorted metadata JSON established in EE-2 (commit `84963f2`, see memory `project_tensol_runtime_readiness_2026-05-12.md`). Reuse the format verbatim so any out-of-band verifier built against v1 still works.

**Canonical message** (concatenation of):

1. `event` (text identifier)
2. `ts` (ISO 8601 UTC)
3. `user_id` (or empty)
4. `project_id` (or empty)
5. `target_id` (or empty)
6. `scan_id` (or empty)
7. `vps_instance_id` (or empty)
8. `auth_proof_id` (or empty)
9. `finding_id` (or empty)
10. `severity` (or empty)
11. `outcome` (e.g. `success`, `failure`, `rejected`)
12. `metadata_json` (JSON.stringify with keys alpha-sorted)
13. `prev_signature` (hex of previous row's signature)

Fields joined by `|`. HMAC-SHA256 using `TENSOL_AUDIT_SIGNING_KEY` (base64-encoded 32 bytes).

**Rationale**: Stability of the chain is a load-bearing invariant per Constitution II. Changing the canonical message would invalidate every existing audit chain and require a versioned migration we don't want to design.

**Alternatives considered**:

- Switching to Ed25519 signatures → tempting (asymmetric, key rotation easier) but doubles signing cost and forfeits compatibility with v1 verifier code. Defer to a Constitution amendment if/when key custody policy demands.
- Canonical JSON instead of pipe-delimited → ergonomically nicer but every existing tool already parses pipes.

**Implications**:

- `src/audit/sign.ts` is a literal port of the EE-2 implementation from `packages/audit/src/signer.ts` before deletion (we delete the package but lift this file).
- `verify-chain.ts` is a thin CLI: `bun run server/src/audit/verify-chain.ts [--db path]` — exit code 0 if chain verifies, non-zero with row number if not.

## Decision 5 — In-process SQLite job queue shape

**Decision**: One `jobs` table with `id`, `type` (discriminator), `payload_json`, `status` (`pending`/`running`/`done`/`failed`), `scheduled_at`, `attempts`, `last_error`. Runner polls every 500 ms with `SELECT * FROM jobs WHERE status='pending' AND scheduled_at <= now() ORDER BY scheduled_at ASC LIMIT 1` inside an immediate transaction that flips status to `running`.

Retry on handler exception: `attempts++`, `scheduled_at = now() + (2^attempts) seconds`, status back to `pending`. Max 5 attempts then status `failed`.

**Rationale**: Constitution V (YAGNI) and III (single binary) forbid bringing Redis or BullMQ. SQLite + a single polling thread is exactly enough for the projected scale (tens of scans/week). Locking through `BEGIN IMMEDIATE` prevents two processes from picking the same row — although we only run one process today, this future-proofs against a careless second process during a botched deploy.

**Alternatives considered**:

- `LISTEN/NOTIFY` over Postgres → would require Postgres (rejected by SQLite choice).
- Setting up BullMQ over SQLite → no real implementation exists; would require Redis fallback.
- Pure setTimeout-based in-memory queue → loses state on restart, violates NFR-AVAIL-01.

**Implications**:

- `jobs/runner.ts` ≈ 80 lines. Handlers in `jobs/handlers/*.ts` each ≈ 60–100 lines.
- 500 ms polling cadence is fine — scans run in minutes, so 500 ms latency on a state transition is invisible. If we ever need sub-second responsiveness, switch to a wake-up channel (e.g., write to a local pipe on enqueue).

## Decision 6 — Frontend contract reconciliation

**Decision**: The current `apps/site/` already references certain API paths. After v2 is built, do a one-shot reconciliation: grep `apps/site/src/` for `/api/` and `/webhooks/`, align with the new OpenAPI contract, fix discrepancies in apps/site. We do **not** preserve old paths just because the front used them — the front is fluid (per memory `project_apps_site_src_untracked_high_finding.md`, large parts were untracked anyway).

**Rationale**: Trying to retrofit a clean v2 backend to a v1 contract is the kind of work this redesign exists to avoid. The frontend is the smaller, more malleable side.

**Alternatives considered**:

- Generate `apps/site` TypeScript client from OpenAPI → premature; do it manually first, generate when the contract stabilizes.
- Freeze the old paths → reintroduces v1 bloat.

**Implications**:

- A dedicated task in `/speckit-tasks` for "align apps/site fetch calls to v2 API".
- The OpenAPI doc is the single source of truth for the contract; both backend Zod schemas and frontend fetch wrappers derive from it conceptually (manual sync now, generated later).

## Open items

None. All blockers resolved. Ready for Phase 1 design artifacts.
