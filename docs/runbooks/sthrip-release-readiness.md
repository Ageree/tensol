# Sthrip Release Readiness Runbook

**Updated:** 2026-06-13 (Europe/Moscow)

This runbook is the local, non-destructive release-readiness gate for Sthrip.
It covers the work that can be proven without changing production secrets,
granting cloud IAM, pushing commits, or deploying.

## Scope

- Public product identity stays Sthrip on `sthrip.dev` / `api.sthrip.dev`.
- Public/product UI stays English-only.
- `/legal/terms`, `/legal/privacy`, `/legal/refund`, and `/legal/dpa` stay
  reachable for billing/domain review.
- `/billing` may use the existing OxaPay credit checkout until a billing
  provider migration is explicitly requested.
- Paddle copy may describe Paddle as merchant-of-record/payment administrator
  for orders it processes, but do not claim Paddle checkout is live until the
  checkout integration is actually migrated.
- Legacy `TENSOL_*`, `useTensol`, and `api.tensol.ru` compatibility markers
  are not public-brand proof and should not be renamed for cosmetics during
  readiness work.

## Local Gates

Run from the repository root unless a command says otherwise.

```bash
git status --short --branch
bash server/scripts/license-audit.sh
TENSOL_AUDIT_SIGNING_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  bun run --cwd server verify-chain --db :memory:
bun test server/test/audit/new-events.test.ts server/src/audit/verify-chain.test.ts
bunx tsc -p server/tsconfig.json --noEmit
bun run --cwd apps/site typecheck
bun run --cwd apps/site build
```

The full server regression gate is:

```bash
bun run --cwd server test
```

Use targeted tests first when iterating on PR-review readiness:

```bash
bun test server/src/routes/review-webhook.test.ts \
  server/src/jobs/handlers/pr-review.test.ts \
  server/src/review/service.test.ts
```

## Branding Sweep

Use this command for public frontend surfaces:

```bash
rg -n "Tensol|CyberStrike|tensol\\.ru|tensol\\.dev|api\\.tensol|app\\.tensol|YooKassa|ЮKassa|руб|₽|[А-Яа-яЁё]" \
  apps/site/src apps/site/public apps/site/index.html apps/site/vercel.json \
  -g '!**/*.test.ts' -g '!**/*.test.tsx'
```

Allowed matches must be internal compatibility names, implementation comments,
or legacy API fallback markers. Public HTML, marketing copy, dashboard copy,
legal copy, route labels, and metadata must be English-only and Sthrip-branded.

Check retired booking surfaces separately:

```bash
rg -n "deep-inquiry|DeepInquiry|Book a scope|scope call|booking" \
  apps/site/src apps/site/e2e apps/site/public apps/site/index.html apps/site/vercel.json
```

Allowed matches are API-client compatibility types/tests only. Do not restore
the old public `/deep-inquiry` funnel without an explicit product decision.

## CI Gates

`.github/workflows/ci.yml` server job should run, in order:

1. `bun install --frozen-lockfile`
2. `bash server/scripts/license-audit.sh`
3. `bun run verify-chain --db :memory:`
4. `bunx tsc -p tsconfig.json --noEmit`
5. `bun test`

The site job should keep running the TypeScript gate before production deploys.
For Vercel production deploys, also verify the deployed `https://sthrip.dev`
HTML has `lang="en"`, Sthrip title/favicon markers, and no Cyrillic public
metadata.

## External Blockers

These are not local release-readiness failures unless the required credentials
and authority are available in the session.

- Real PR review trigger:
  Requires `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_APP_WEBHOOK_SECRET`, and an installed Sthrip GitHub App on a test
  repo. Completion evidence is a GitHub-originating 2xx delivery with verified
  signature, `installation.id` match, completed `pr_review` job, and a
  check/comment/review result.
- Real blackbox VM smoke:
  Requires a GCP identity with Compute/IAM permissions, a public callback URL,
  and explicit evidence/report storage config. Completion evidence is a GCP VM
  reaching `RUNNING`, vps-agent start, backend callback, terminal scan/order,
  and no leaked VM/process.
- Paddle production checkout:
  Requires approved Paddle account/configuration and an explicit migration
  task. Completion evidence is Paddle checkout end to end, signed webhook
  crediting entitlement, and discoverable policy pages.

Do not replace these with fake payloads or PAT shortcuts for final acceptance.
Local signed webhook tests are useful regression tests, not live-proof.

## Cleanup Checks

After any live smoke attempt:

```bash
gcloud compute instances list --project=tensol-scanners
lsof -nP -iTCP:3000 -sTCP:LISTEN || true
pgrep -af 'localtunnel|cloudflared|ssh .*tensol-scan|bun .*src/server.ts' || true
```

No GCP VM, tunnel, local server, SSH process, or temporary DNS record should be
left behind.
