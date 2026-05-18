# Quickstart — Backend v2 local dev

Prerequisites: Bun ≥ 1.1, Docker, `cloudflared` (for public webhook tunneling), a Hetzner Cloud API token (use a project with a $20 spending limit while developing).

## 1. Install

```bash
cd server
bun install
```

## 2. Configure env

Create `server/.env.local`:

```ini
# Auth
TENSOL_AUDIT_SIGNING_KEY=<bun -e "console.log(crypto.randomBytes(32).toString('base64'))">
TENSOL_SESSION_COOKIE_SECRET=<bun -e "console.log(crypto.randomBytes(32).toString('base64'))">

# Email (use stdout for dev)
EMAIL_PROVIDER=stdout

# VPS provider
HETZNER_API_TOKEN=<your-token>
HETZNER_LOCATION=hel1
HETZNER_SERVER_TYPE=cx22
HETZNER_IMAGE=ubuntu-24.04
HETZNER_SSH_KEY_NAME=tensol-dev

# VPS-agent image (built once and pushed to GHCR)
TENSOL_VPS_AGENT_IMAGE=ghcr.io/tensol/vps-agent:latest

# Webhook reachability
TENSOL_WEBHOOK_BASE_URL=<filled-in-after-cloudflared>

# Server
PORT=3000
NODE_ENV=development
```

## 3. Initialize DB

```bash
cd server
bun run drizzle-kit push
mkdir -p data
```

## 4. Start the public tunnel

In a separate terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://<name>.trycloudflare.com` URL from the output and put it in `TENSOL_WEBHOOK_BASE_URL` in `server/.env.local`. Restart the server after editing.

## 5. Run the server

```bash
cd server
bun run dev
```

You should see:

```
[server] audit chain verified (rows: 0)
[server] reconciler: 0 in-flight scans
[server] job runner started (poll 500ms)
[server] listening on http://0.0.0.0:3000
```

## 6. Sign in (dev)

In the frontend (`apps/site`, `bun run dev` separately), submit your email. In the backend terminal you'll see the magic link printed to stdout — copy it into your browser.

## 7. First scan

1. Create a project.
2. Add target `https://example.com` (or any URL you can put a DNS TXT on).
3. Get challenge → publish the TXT record → click verify.
4. Click *Start scan* with profile `recon`.

You'll see, in order:

```
[jobs] spawn_vps: started for scan 01HX...
[jobs] spawn_vps: server 12345678 created, ip 95.X.X.X, status=provisioning
[jobs] spawn_vps: server 12345678 alive, status=alive
[jobs] dispatch_scan: posting to https://95.X.X.X/scan
[jobs] dispatch_scan: 202 accepted
... (12-25 minutes) ...
[webhook] /webhooks/scan-progress: scan 01HX... status=done, 7 findings
[jobs] teardown_vps: deleting server 12345678
```

If the agent hangs, the watchdog kicks in after 30 minutes and marks the scan failed.

## 8. Verify the audit chain

```bash
cd server
bun run src/audit/verify-chain.ts --db data/tensol.db
# → "chain ok: 42 rows verified"
```

## Tests

```bash
cd server
bun test                    # all unit + integration tests
bun test --coverage         # with coverage report
bun test tests/integration/auth.test.ts   # one suite
```

E2E (against running backend on port 3000):

```bash
cd apps/site
bun run test:e2e
```
