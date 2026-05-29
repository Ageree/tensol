# Pivot 2026-05-19 — Telegram-link auth вместо email

**Дата:** 2026-05-19
**Триггер:** Resend (и другие email-провайдеры) недоступны оператору
по «определённым причинам». User-verbatim: «telegram вместо mail».

## Что меняется в продукте

| Слой | Было (по spec.md/plan.md ревизия 2026-05-19) | Стало |
|---|---|---|
| Sign-up / sign-in | Email + magic-link через Resend | **Telegram username + deep-link через `@tensol_leadsbot`** |
| Поле формы auth | `email` | `telegram_username` (без `@` префикса допустимо) |
| Delivery магик-токена | Email от Resend | Telegram DM от бота через `sendMessage` |
| Scan-complete уведомление | Email от Resend с PDF attached | **Telegram DM от бота с PDF document + ссылкой на отчёт** |
| Deep inquiry (FR-030) | Email обязателен в форме | **Email опционален**; контактный telegram/телефон остаётся обязательным |
| Resend SDK | dep в `server/package.json` | **drop** — не нужен |

## Auth flow (новый)

```
1. User visits /login
2. Enters their Telegram username (e.g. `@kapital0` или `kapital0`)
3. Backend creates `pending_signups` row: {token, telegram_username,
   expires_at: now+15min, chat_id: null, status: 'pending'}
4. Backend responds 200 + redirect URL:
   https://t.me/tensol_leadsbot?start=<token>
5. Browser opens the deep-link; Telegram app launches bot
6. User taps "Start" → bot receives `/start <token>` update via webhook
   on backend at POST /v1/webhooks/telegram-update
7. Backend resolves token → finds pending_signups row
   - If row exists + not expired:
     - Match telegram_username case-insensitively (Telegram allows
       case-insensitive @-handles)
     - If first-time user: INSERT users row with telegram_user_id +
       telegram_username + null email
     - If returning user (telegram_user_id already in users):
       update last_login_at
     - Create sessions row, return session cookie
     - Bot replies: "Готово, можно вернуться на сайт" с кнопкой
       "Открыть Tensol" (inline keyboard with web_app URL)
     - UI side: poll GET /v1/auth/me каждые 2s, при появлении session
       cookie redirect to /dashboard
8. If token expired or wrong username — bot replies error, prompt to
   re-issue from site
```

## Scan-complete delivery (новый)

```
On scan completion:
1. Job `send-scan-complete-telegram` (replaces ...-email)
2. Resolve users.telegram_user_id by scan.user_id
3. notify/telegram.ts::sendScanComplete(chatId, scanId, pdfBuffer):
   - sendDocument with PDF (if rendered) + caption with summary
   - OR sendMessage with link to dashboard (if PDF still rendering)
4. Retry 3x on Telegram 5xx/429 with retry_after honor
5. Mark scans.notification_sent_at = now
```

## Spec FR amendments (delta to specs/002-blackbox-mvp/spec.md)

- **FR-001**: replace «email address and a one-time sign-in link»
  with «Telegram username and a one-time sign-in deep-link via
  the operator's Telegram bot»
- **FR-028**: replace «send the user an email when a scan completes»
  with «send the user a Telegram direct message when a scan completes,
  containing a link to the dashboard and the report PDF as
  attachment»
- **FR-029**: replace «retry email delivery» with «retry Telegram
  message delivery» (same semantics — exponential backoff, idempotent)
- **NEW FR-001a**: «System MUST accept a Telegram username in the
  signup form (with or without leading @), normalize to lowercase,
  and route the magic-link via the operator's Telegram bot»
- **NEW FR-001b**: «System MUST handle bot webhook updates including
  `/start <token>` commands, resolve token → user_id, and create a
  session within 5 seconds of bot interaction»
- **FR-030**: change email from required to optional. Telegram /
  phone contact stays required
- **Edge case**: If user enters @username that does NOT correspond to
  an existing Telegram account, the `/start` callback will never
  fire → token expires after 15 min → user prompted to retry. No
  way to validate username pre-emptively (Telegram doesn't expose
  username lookup API for bots).

## Data-model amendments (delta to data-model.md E1)

`users` table additions:
- `telegram_user_id INTEGER UNIQUE` (Telegram's numeric user ID,
  populated on first /start callback)
- `telegram_username TEXT` (lowercased @-handle without leading @,
  unique)
- `email TEXT` becomes NULLABLE (kept for forward-compat / future
  Deep contact)

NEW table:
- `pending_signups (id ULID, token TEXT UNIQUE, telegram_username
  TEXT, chat_id INTEGER NULL, status TEXT CHECK IN
  ('pending','resolved','expired'), created_at, expires_at)`
- Token TTL: 15 minutes (mirrors existing magic-link)
- Index `(telegram_username, status, expires_at)`

DROP: any `magic_link_tokens` table from earlier draft if it was
email-shaped.

## Plan amendments (delta to plan.md)

- DROP from Primary Dependencies: «Resend (transactional email)»
- DROP from new backend modules: `server/src/notify/email.ts`
- EXTEND `server/src/notify/telegram.ts` with `sendMagicLink(chatId,
  url)`, `sendScanComplete(chatId, scanId, pdfBuffer?)`,
  `processBotUpdate(update)` for webhook entrypoint
- NEW route: `POST /v1/webhooks/telegram-update` (Telegram bot
  webhook). Validates `X-Telegram-Bot-Api-Secret-Token` header against
  `TENSOL_TELEGRAM_WEBHOOK_SECRET` env (Telegram-side configured
  via `setWebhook`)
- NEW frontend: `apps/site/src/pages/AuthBotRedirect.tsx` — page that
  polls `/v1/auth/me` and redirects on success

## Tasks.md amendments (delta to tasks.md)

- **T002 [Setup]**: drop Resend SDK dep; keep all else
- **T024 [US1] schemas**: rename concept «email + token» → «telegram
  username + token»; same file path
- **T054 [US1] notify/email.ts**: **DELETE this task entirely**,
  merge functionality into T096 (notify/telegram.ts is extended for
  magic-link + scan-complete)
- **T055 [US1] notify/email.test.ts**: **DELETE**, tests fold into
  notify/telegram.test.ts (T097)
- **T062 [US1] send-scan-complete-email job**: rename to
  «send-scan-complete-telegram job», same code-path
- **T063 [US1] send-scan-complete-email.test.ts**: rename
- **T096 [US2] notify/telegram.ts**: **EXTEND scope** — now covers
  both Deep-inquiry notification (operator-facing) AND magic-link +
  scan-complete (user-facing)
- **T097 [US2] notify/telegram.test.ts**: expand test scope
- **NEW T024b [US1] webhook for /start command**: implement
  `POST /v1/webhooks/telegram-update` handler that processes /start
  with token. Routes signup completion
- **NEW T024c [US1] pending_signups schema + service**: insert /
  resolve / expire flow
- **NEW T078b [US1] AuthBotRedirect page**: frontend redirect page
  polling auth status

## .env amendments

NEW env var: `TENSOL_TELEGRAM_WEBHOOK_SECRET` — random 32-byte hex
for Telegram-side `setWebhook --secret_token=...` validation.

Bot must have webhook configured pointing at production URL. For
local dev, use `bot` long-polling instead of webhook (env flag
`TENSOL_TELEGRAM_LONGPOLL=true`).

DROP `RESEND_API_KEY` entirely from `server/.env` (currently
placeholder).

## Bot UX additions

Bot needs to handle (in addition to existing Deep-inquiry passthrough):
- `/start <token>` — resolve signup token (described above)
- `/start` (no token) — reply with welcome + "Visit tensol.com to
  sign in"
- `/help` — bot capabilities, support contact
- `/status` — list user's scans (auth via chat_id → user_id lookup)
- `/cancel <scan_id>` — cancel scan via bot (optional, post-MVP)

## Migration impact

No existing prod users yet (per Constitution V «no backwards-compat
with v1»). Schema migration 0010 already drops `auth_proofs`,
`targets`, `projects` — extend it to also drop `magic_link_tokens`
if that table was created. Add `pending_signups` + users-column
changes in the same migration.

## What this doc IS / IS NOT

- **IS** authoritative for implementation behavior — Driver/Subagents
  should treat this doc as overriding spec.md FR-001/FR-028/FR-029
  language where they conflict
- **IS NOT** a replacement for the canonical spec — if user wants
  to re-issue an updated spec.md, that's a separate /speckit-clarify
  pass. For MVP we keep spec.md as-is + this pivot doc as the
  delta-of-record

## References

- spec.md: specs/002-blackbox-mvp/spec.md
- plan.md: specs/002-blackbox-mvp/plan.md
- data-model.md: specs/002-blackbox-mvp/data-model.md
- tasks.md: specs/002-blackbox-mvp/tasks.md
- Telegram bot: @tensol_leadsbot (token in server/.env)
- This doc: docs/pivot-2026-05-19-telegram-auth.md
