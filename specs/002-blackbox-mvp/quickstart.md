# Quickstart — Blackbox MVP

**Audience**: a new contributor who needs to bring this feature up locally
from scratch and run the happy-path E2E.

**Pre-reqs**: Bun ≥ 1.1, Docker Desktop, Playwright deps installed, a
valid Yandex Cloud test folder (or skip the real-Yandex tests with the
flag in §6).

---

## 1. Repository setup

```bash
cd "/Users/saveliy/Documents/пентест ИИ"
git checkout 002-blackbox-mvp
bun install                              # root
cd server && bun install && cd -
cd apps/site && bun install && cd -
cd vps-agent && bun install && cd -
```

## 2. Environment

Copy `.env.example` to `.env` in `server/`, `apps/site/`, and
`vps-agent/`. Fill in the following for local dev:

`server/.env`:
```
TENSOL_DB_URL=file:./local.db
TENSOL_HMAC_SECRET=dev-only-not-real
TENSOL_WEBHOOK_SECRET=dev-only-not-real
TENSOL_PORT=3001
TENSOL_YOOKASSA_LIVE=false

# Resend (transactional email)
RESEND_API_KEY=re_dev_...

# Telegram (lead-gen notifications)
TENSOL_TELEGRAM_BOT_TOKEN=...
TENSOL_TELEGRAM_CHAT_ID=496866748

# Yandex Cloud (real spawn — leave blank for tests with fake provider)
YANDEX_SA_KEY_JSON=base64-encoded-service-account-key
YANDEX_TEST_FOLDER_ID=b1g...
YANDEX_TEST_NETWORK_ID=enp...
YANDEX_TEST_SUBNET_ID=e9b...
YANDEX_TEST_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..."
```

`apps/site/.env`:
```
VITE_API_BASE=http://localhost:3001
```

## 3. Database setup

```bash
cd server
bun run db:migrate                       # applies 0010_blackbox_mvp + all prior
bun run db:generate                      # only after schema.ts edits
cd -
```

## 4. Run the stack

In three terminals (each via tmux per project convention):

```bash
# T1 — backend
cd server && tmux new-session -d -s be 'bun run dev'

# T2 — frontend
cd apps/site && tmux new-session -d -s fe 'bun run dev'

# T3 — vps-agent (only needed if running the real-Yandex IT)
cd vps-agent && tmux new-session -d -s va 'bun run dev:fake-target'
```

(The `dev` placeholder is the literal `package.json` script name —
the project convention is to launch dev servers via tmux so logs are
accessible.)

Open http://localhost:5175 and sign in via magic-link. Resend test-mode
emails appear in the Resend dashboard.

## 5. Happy-path manual smoke

1. Sign up at http://localhost:5175 with your dev email.
2. Click "Try Quick free".
3. Enter a domain you control (e.g. your own `*.tensol.dev` subdomain).
4. Accept auto-discovered subdomains, click Next.
5. Pick Safety = Default (50 rps), click Next.
6. Copy the TXT instruction, paste into your DNS provider, save.
7. Wait for the live poll to flip to "Verified" (typically 30s–5min).
8. Click "Запустить бесплатный Quick".
9. Watch Live page for events.
10. Wait for scan completion. Findings should appear in the list.
11. Click "Скачать PDF" — PDF downloads.
12. Check the dev email inbox — completion email with PDF attached.

For testing without real DNS, use the dev-mode flag:
```
TENSOL_DEV_DNS_BYPASS=true
```
which makes DNS verification always succeed after 5 seconds.

## 6. Test suites

Per-push (mocked Yandex, fast):
```bash
cd server && bun test
cd apps/site && bun test
cd vps-agent && bun test
```

PR-merge / nightly (real Yandex):
```bash
cd server && TENSOL_TEST_REAL_YANDEX=1 bun test
```

Real-Yandex tests spawn VMs in your test folder. Cleanup is automatic,
but if a test crashes mid-flight, run `bun run cleanup-orphan-vms` to
remove leftovers.

E2E (Playwright):
```bash
cd apps/site && bun run e2e
```

## 7. Resetting local state

```bash
cd server
rm local.db
bun run db:migrate
```

## 8. Useful commands

| Command | What |
|---|---|
| `bun run verify-chain` (in `server/`) | Verifies the audit log HMAC chain end-to-end |
| `bun run cleanup-orphan-vms` (in `server/`) | Force-deletes any `tensol-test-*` VMs > 30 min old in the test folder |
| `bun run debug:scan-order <id>` (in `server/`) | Dumps a scan_order's full lifecycle JSON for debugging |
| `bun run dev:fake-target` (in `vps-agent/`) | Runs vps-agent against a local Juice Shop docker container instead of real recon |

## 9. Common gotchas

- **Email magic-link doesn't arrive**: check `RESEND_API_KEY` is set,
  and that the email domain is verified in Resend. In dev, use Resend's
  test mode (any `from: onboarding@resend.dev`).
- **DNS verification stays "Not found"**: many DNS providers have TTL
  of 5–60 minutes for new TXT records. Use `dig +short TXT <yourdomain>
  @1.1.1.1` to confirm propagation outside the platform.
- **Yandex spawn fails with `quotaExceeded`**: your test folder quota
  (5 VMs default) is full. Run cleanup-orphan-vms.
- **PDF render fails locally**: Puppeteer needs `@sparticuz/chromium-min`
  binary. Re-run `bun install` if the postinstall failed.
- **Webhook signature verification fails**: clock skew between
  vps-agent's VM and the backend. Real Yandex VMs sync NTP at boot, so
  this typically self-resolves after ~10s; in local dev, run
  `sudo sntp -sS time.cloudflare.com` if needed.
