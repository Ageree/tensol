# Tensol — Telegram lead relay

Tiny Bun HTTP server that receives JSON lead submissions from `/contact` and
forwards them as Markdown messages to a Telegram chat via the bot API.

This script is **standalone** — it is not part of the Vite bundle. Deploy it
on a small VPS, a serverless function (Yandex Cloud Function, Vercel, fly.io),
or run it next to the static site behind nginx.

---

## Prerequisites

- [Bun](https://bun.sh) `>= 1.1` on the host that will run the relay.
- A Telegram bot — talk to [@BotFather](https://t.me/BotFather), copy the token.
- A Telegram chat / channel where the bot is a member; you need its numeric
  `chat_id`. Easiest ways to obtain it:
  - DM your bot something, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates`
    and read `message.chat.id`.
  - Add [@userinfobot](https://t.me/userinfobot) to the target group, it
    posts the chat id and removes itself.

---

## Environment variables

| Variable              | Required | Default | Notes                                                        |
|-----------------------|----------|---------|--------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`  | yes      | —       | `123456:ABC-DEF…` — keep this secret, never commit it.        |
| `TELEGRAM_CHAT_ID`    | yes      | —       | Numeric. For supergroups it looks like `-100123456789`.       |
| `PORT`                | no       | `8787`  | TCP port the relay listens on.                                |
| `ALLOWED_ORIGIN`      | no       | `*`     | Comma-separated list, e.g. `https://tensol.dev,http://localhost:5175`. |

Put them in `apps/site/scripts/.env` (gitignored) when developing locally.

---

## Run locally

```bash
cd apps/site
chmod +x scripts/telegram-relay.ts   # one-time, optional
TELEGRAM_BOT_TOKEN=123:abc \
TELEGRAM_CHAT_ID=-100123456789 \
ALLOWED_ORIGIN=http://localhost:5175 \
bun scripts/telegram-relay.ts
# [telegram-relay] listening on http://localhost:8787
```

Smoke-test with curl:

```bash
curl -i http://localhost:8787/healthz

curl -i http://localhost:8787/api/contact \
  -H 'content-type: application/json' \
  -d '{"name":"Alex","email":"alex@acme.com","company":"Acme","role":"CISO","size":"501–5000","scope":"Two prod web apps","urgency":"Within a week","phone":"","consent":true}'
```

You should see the message arrive in your Telegram chat instantly.

---

## Wire to the site

In `apps/site/.env.local`:

```
VITE_CONTACT_ENDPOINT=http://localhost:8787/api/contact
VITE_CONTACT_TELEGRAM_HANDLE=tensol_lead_bot
VITE_CONTACT_MAILTO=nikto256@gmail.com
```

If `VITE_CONTACT_ENDPOINT` is unset or unreachable, the form falls back to
opening `https://t.me/<handle>?text=…` in a new tab and surfaces a
`mailto:` link as the third escape hatch.

---

## Deploy hints

### systemd (Debian/Ubuntu VPS)

`/etc/systemd/system/tensol-relay.service`:

```ini
[Unit]
Description=Tensol Telegram lead relay
After=network-online.target

[Service]
Type=simple
User=tensol
WorkingDirectory=/srv/tensol/apps/site
EnvironmentFile=/srv/tensol/apps/site/scripts/.env
ExecStart=/usr/local/bin/bun scripts/telegram-relay.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tensol-relay
```

Front it with nginx + TLS (Let's Encrypt) at `https://relay.tensol.dev/api/contact`
and point `VITE_CONTACT_ENDPOINT` there.

### Yandex Cloud Function

The relay is small enough to run as a single Bun function. Wrap the request
handler exported by `Bun.serve` and re-export it as the function entrypoint,
or use a Node 20 runtime with the equivalent `node:http` server (the logic
is identical — fetch + JSON in/out).

Set the env vars in the function configuration. Bind the function to an
HTTPS trigger and use that URL as `VITE_CONTACT_ENDPOINT`.

### Docker (any host)

```Dockerfile
FROM oven/bun:1
WORKDIR /app
COPY scripts/telegram-relay.ts ./
EXPOSE 8787
CMD ["bun", "telegram-relay.ts"]
```

Run with `-e TELEGRAM_BOT_TOKEN=… -e TELEGRAM_CHAT_ID=… -p 8787:8787`.

---

## Failure modes

- Bot not in chat → Telegram returns 400, relay responds 502 — site falls
  back to the `t.me` deep-link.
- Bad payload → relay responds 400, site shows validation errors.
- Network outage → site catches the fetch error and shows the fallback row.

The relay never echoes the bot token or chat id in its responses.
