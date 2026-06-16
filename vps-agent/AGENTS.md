# Purpose

`vps-agent/` is the ephemeral scanner-side agent: callback protocol, evidence
upload, findings collection, Decepticon runner integration, webhook signing,
and agent runtime.

# Ownership

- Own `vps-agent/src/**`, tests, Dockerfile, package config, and agent README.
- The agent runs in isolated scan infrastructure and reports back to the Sthrip
  API.

# Local Contracts

- Preserve callback and webhook-signing contracts with the API server.
- `/pr-execution` is the isolated PR runtime worker endpoint. It must verify
  `X-Sthrip-Execution-Signature`, run pinned `headSha` checkouts in an isolated
  workspace, cap returned artifacts, run PR-controlled install/test commands
  inside the configured sandbox backend (`docker` locally or
  `vercel-sandbox` managed Firecracker microVMs), switch branch-controlled
  runtime commands to default-deny egress after dependency setup, avoid writing
  GitHub tokens into `.git/config`, avoid host reads from branch-writable
  artifact paths, and never run inside the API server. Dedicated PR workers may
  run with `STHRIP_PR_EXECUTION_ONLY=true`; in that mode `/scan` stays
  unavailable and explicit `VERCEL_TOKEN` auth must be all-or-nothing with
  `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.
- Keep evidence and finding formats compatible with server ingestion.
- Evidence upload must use explicit S3/GCS-compatible storage env; do not add
  silent provider, endpoint, region, or credential defaults.
- Production `/scan` dispatch uses `callback_version="v2"`: `TENSOL_SIGN_KEY`
  authenticates backend-to-agent dispatch, while `TENSOL_WEBHOOK_SECRET` signs
  the outbound `/v1/webhooks/scan-complete` callback.
- V2 callbacks are terminal. Send `status="failed"` for Decepticon,
  collection, bundle, or upload failures so the backend can mark the scan
  failed and tear down the VM without waiting for the watchdog.
- Do not commit secrets, live customer data, or real scan artifacts.
- Treat Decepticon/runner config changes as security-sensitive because they
  affect what the scanner executes.

# Work Guidance

- Prefer existing parser, runner, callback, and evidence-upload helpers.
- Keep runtime failure modes explicit so scan post-mortems can survive VM or
  container teardown.

# Verification

- General agent tests: `bun run --cwd vps-agent test`.
- For Docker/runtime changes, build or smoke the relevant Docker path when
  feasible and report any skipped runtime verification.

# Child DOX Index

No child Dox docs yet.
