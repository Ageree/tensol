# Tensol Blackbox MVP — Design Document

**Date**: 2026-05-19
**Status**: design approved by user, awaiting spec-author handoff
**Author**: Lead (this session)
**Method**: `superpowers:brainstorming` skill (9 clarifying questions + 3
proposed approaches + 5 design sections, all user-approved). Next step:
`speckit-specify` to author the implementation spec (per user explicit
instruction overriding skill default of `writing-plans`).

---

## 0. Pivot context

Triggered by user discovering competitor **Zauth Vector**
(`zauth.inc / Vector` product, two-tier blackbox pentest at $15 / $49).
After confirming that Tensol's Decepticon engine **already covers all 11
of Vector's listed capabilities + more** (proven by the 38-min Juice Shop
full-chain run on 2026-05-19 that produced 9 CVSS-scored findings
including critical SQLi auth bypass with admin-JWT PoC), user decided to
pivot toward matching Vector's *product packaging* — not its engine.

User-verbatim mandate:

> «давай пока тоже будем делать только blackbox тестирование, начнем с
> малого я тоже хочу чтобы клиент вводил только сайт и нажимал оплатить
> и все запускался скан. Используй superpowers brainstorming для
> уточнения всех моментов у меня а потом specify для написания
> супердетальных и подробных и обширных спеков по дальнейшей разработке
> моего продукта».

After seeing screenshots of Vector's actual 5-step wizard flow
(Attack Surface → Test Accounts → Safety → Verify Domain → Launch), user
revised the initial "URL → pay → scan" simple form toward the wizard
pattern.

---

## 1. Top-level architecture

### 1.1 Service topology

```
                         ┌────────────────────┐
                         │   apps/site (Bun)   │  React+Vite, port 5175
                         │  Wizard 4-step UI   │  (Quick) + DeepInquiry form
                         └────────┬───────────┘
                                  │ HTTPS REST
                         ┌────────▼───────────┐
                         │  server (Bun+Hono)  │  port 3001
                         │  - auth (magic-link)│
                         │  - scan_orders      │
                         │  - dns-verify       │
                         │  - free-tier quota  │
                         │  - deep-inquiries   │
                         │  - notify/telegram  │
                         │  - notify/email     │
                         │  - yandex provisn   │
                         │  - findings ingest  │
                         │  - reports/pdf      │
                         │  + SQLite + audit   │
                         └─┬──────────────┬───┘
                           │              │ Telegram Bot API   ┌─────────────┐
                           │              └───────────────────▶│ @tensol_lead│
                           │                                   │ schat 496…  │
                           │ Yandex API + SSH                  └─────────────┘
              ┌────────────▼────────────┐
              │  Yandex Cloud           │
              │  ru-central1-{a,b,d}    │
              │                         │
              │  ephemeral VM/scan      │
              │  ┌───────────────────┐  │
              │  │ cloud-init        │  │
              │  │ → docker compose  │  │
              │  │   up Decepticon   │  │
              │  │ → vps-agent runs  │  │
              │  │ → HMAC webhook    │  │
              │  │ → tar.gz evidence │  │
              │  │ → S3 OS upload    │  │
              │  │ → self-shutdown   │  │
              │  └───────────────────┘  │
              └─────────────────────────┘
```

### 1.2 Approach: C — clean-slate wizard

User chose **C** (drop expert-mode pages, wizard replaces all) over
recommended **B** (isolated new flow). Risk accepted in exchange for
cleaner end-state.

**Drop** from `apps/site/src/pages/`:
- `Targets.tsx`, `AuthorizeTarget.tsx` (+test)
- `Builder.tsx`, `Approval.tsx`
- `Projects.tsx`

**Drop** from `server/src/`:
- `targets/`, `projects/` services
- Routes `/targets`, `/projects`
- `targets` + `projects` DB tables (migration drops them)

**Keep / reuse**:
- `Marketing.tsx`, `Pricing.tsx`, `Contact.tsx`, `Method.tsx`, `Trust.tsx`,
  `Blog.tsx`, `Legal.*` — marketing pages (copy updates per §2.6)
- `Login.tsx` + magic-link auth — unchanged
- `Dashboard.tsx` — rewritten as "your scans" list
- `Live.tsx` — reused as in-scan progress view
- `Findings.tsx`, `Reports.tsx` — reused for final output
- `Settings.tsx` — reused (profile)
- `server/src/{auth,db,audit,lib,scans,findings}` — foundation unchanged
  (the `scans` service has Phase-C-pending OAuth-dispatch path documented
  in `[[project-tensol-oauth-local-smoke-phase-A-complete-2026-05-19]]`,
  which becomes obsolete — this design supersedes it)

### 1.3 Estimated effort

5–6 weeks total, single developer:
- Wizard + state machine: 1 week
- Yandex provider impl + cloud-init + ops cron: 1.5 weeks
- DNS verify + free-tier quota + scan-orders flow: 1 week
- Reports PDF + email + Telegram notify: 0.5 week
- Test suite (~200 tests): ~2 weeks
- Polish + landing copy + Mythos positioning for Deep: 0.5 week

---

## 2. Components

### 2.1 Decisions locked (9/9)

| # | Decision | User answer |
|---|---|---|
| 1 | MVP tier scope | Two tiers (Quick + Deep) |
| 2 | Pricing model | Flat per-scan, RUB. «Flat price но я думаю поменять цены чтобы экономика билась и я зарабатывал с этого реально» |
| 3 | Ownership verify | DNS TXT before launch (same as Vector) |
| 4 | UX | 5-step wizard initially → revised to **4-step Quick wizard** after Deep moved to lead-gen flow |
| 5 | Auth gate | Full signup before wizard (magic-link, existing) |
| 6 | Payment gw | YooKassa (RU-first) — **deferred**: user has ИП but YooKassa registration in progress. Interim = Free Quick only, NO YooKassa code path in MVP launch. Feature flag `TENSOL_YOOKASSA_LIVE` gates payment UI |
| 7 | Dispatch | Yandex Cloud ephemeral VM per scan — day 1, no `local-dispatch` rail |
| 8 | Output | Dashboard live progress + Findings detail + downloadable PDF + email notification |
| 9 | Test Accounts feature | Originally "full encrypted storage". **Revised**: Deep moved to lead-gen, Test Accounts collected via inquiry form/personal contact off-platform. NO encrypted storage in MVP |

User-verbatim §2 pivot:

> «Изменим - есть два трека - первый quick он будет бесплатным первое
> время Deep надо будет расписать что это хаккинг близкий к уровню
> mythos и мне надо будет связаться с клиентом прежде чем начинать его
> и заявка будет отправляться так же мне в телеграмм через бота»

### 2.2 Two product tracks

| | **Quick** (self-serve) | **Deep** (lead-gen) |
|---|---|---|
| Positioning | Free quick surface scan | Mythos-level AI hacking (full kill chain) |
| UX | 4-step wizard on site | Pricing CTA → form → Telegram-to-operator |
| Pipeline | Auto: VM spawn → Decepticon recon → findings → PDF | Manual: operator receives Telegram → contacts client → off-platform scope/price/schedule → manual scan trigger off-MVP |
| Billing | Free (post-MVP: YooKassa via feature flag) | 100% manual, outside MVP system |
| Decepticon assistant_id | `d18311c3-263f-5ee8-ab45-fe337084e45e` (`recon`) | N/A in MVP. Future: `b4beb031-…` (`decepticon` orchestrator) |
| Default rate limit | 1 per 7 days per user | N/A |

### 2.3 Backend modules — new

| Module | Purpose | LOC est |
|---|---|---|
| `server/src/scan-orders/service.ts` | Lifecycle of scan_orders (draft → dns_pending → dns_verified → vm_provisioning → running → completed/failed/cancelled) | ~350 |
| `server/src/dns-verify/service.ts` | Generate `tensol-verify=<hex>` tokens, query authoritative DNS via dns.cloudflare.com bypass, poll-loop | ~120 |
| `server/src/free-tier/service.ts` | `canUserStartFreeQuick(userId)` + `consumeFreeQuickQuota(userId)` atomic via `BEGIN IMMEDIATE` | ~80 |
| `server/src/deep-inquiries/service.ts` | createInquiry, listInquiries, status transitions; emits Telegram | ~150 |
| `server/src/notify/telegram.ts` | Thin wrapper around `@tensol_leadsbot` Bot API. ENV: `TENSOL_TELEGRAM_BOT_TOKEN`, `TENSOL_TELEGRAM_CHAT_ID` (= 496866748 from prior session) | ~80 |
| `server/src/notify/email.ts` | Resend API wrapper, `sendScanCompleteEmail(orderId, pdfBuffer?)` with attachment-or-link fallback | ~100 |
| `server/src/vps/provider.ts` | `CloudProvider` TS interface: `spawnVm`, `teardownVm`, `getStatus`, `pollOperation`. Drops the Hetzner-only name | ~60 |
| `server/src/vps/yandex.ts` | Concrete Yandex Cloud implementation. **Async operation pattern** per Yandex API design guide (every state-change returns `Operation`, must poll). Idempotency-Key on every spawn | ~250 |
| `server/src/vps/cloud-init.ts` | Shared cloud-init builder. Renders bash script with `TENSOL_*` env vars, SSH key, webhook secret | ~120 |
| `server/src/findings/ingest.ts` | Parse YAML frontmatter from `/workspace/findings/*.md`, INSERT findings rows, emit audit-per-finding. Reuses the proven format from 2026-05-19 Juice Shop run | ~150 |
| `server/src/reports/pdf.ts` | Puppeteer-headless renders HTML template (handlebars) → Buffer. Cover + executive summary + per-finding detail with CVSS/CWE/MITRE/PoC | ~180 |

### 2.4 Backend modules — modified

| Module | Change |
|---|---|
| `server/src/db/schema.ts` | Drop `targets`, `projects` tables. Add `scan_orders`, `deep_inquiries`, `scan_events`, `findings` (if not present). Extend `users` with `free_quick_consumed_at`, `free_quick_quota_resets_at` columns |
| `server/src/scans/service.ts` | Simplify — `startScan` becomes a downstream consumer of `scan-orders/launchScan`. Remove auth-proof-required gate (DNS verify supersedes) |
| `server/src/audit/emit.ts` | Add event types: `scan_order_created`, `dns_verified`, `dns_verify_failed`, `free_quota_consumed`, `vm_provisioning`, `vm_ready`, `scan_started`, `finding_ingested`, `scan_completed`, `scan_failed`, `vm_teardown`, `pdf_rendered`, `email_sent`, `inquiry_received`, `inquiry_telegram_sent`, `webhook_invalid_signature` |

### 2.5 Frontend pages — new

```
apps/site/src/pages/
  scan-wizard/
    ScanWizardContainer.tsx         — stepper + state + REST calls
    Step1AttackSurface.tsx          — domain input + auto-subdomain probe
                                       + global headers (key/value rows)
    Step2Safety.tsx                 — RPS slider (10/50/200/500),
                                       Safe/Default/Aggressive presets
    Step3VerifyDomain.tsx           — TXT instruction card +
                                       live poll status indicator +
                                       Contact Support fallback button
    Step4Launch.tsx                 — summary card + green "Запустить
                                       бесплатный Quick" CTA. When
                                       TENSOL_YOOKASSA_LIVE=true:
                                       Pay-via-YooKassa CTA instead
  DeepInquiry.tsx                    — hybrid form (anonymous OR
                                       pre-filled if logged in). Fields:
                                       company, contact_name, position,
                                       email, phone, domains_text,
                                       desired_date, budget_band,
                                       scope_text, consent_accepted
  DeepInquiryThankYou.tsx            — success page «Заявка получена.
                                       Свяжемся в течение 24 часов»
```

### 2.6 Frontend pages — modified

| Page | Change |
|---|---|
| `Marketing.tsx` | Hero CTAs: «Попробовать Quick бесплатно» + «Запросить Deep аудит». Add Vector-style 6-criterion explainer block (existing /pricing FAQ from 2026-05-11 memory) |
| `Pricing.tsx` | Two cards. Quick = "Бесплатно (пока тестируем рынок)" + free-quota note. Deep = "Mythos-уровень AI-хакинга — стоимость индивидуально" + Inquiry CTA. Remove the existing Plus/Premium pricing |
| `Dashboard.tsx` | Table of user's scan_orders (status, primary_domain, tier, date, action button). Plus `+ New Scan` floating CTA |
| `Live.tsx` | SSE-subscribed progress page for `scan_id`. Phase progress (recon → ... → completed). Live findings feed |
| `Findings.tsx` | Severity distribution chart + filterable table + drill-down to single finding (CVSS / CWE / MITRE / full PoC) |
| `Reports.tsx` | List completed scans + Download PDF button per row |
| `Settings.tsx` | Profile + free-quota status display ("Доступен через X дней") |
| `Login.tsx` | Unchanged. Magic-link flow |
| `App.tsx`, `i18n.ts` | New routes + new translation keys for wizard + inquiry |

### 2.7 Database schema deltas

```sql
-- DROP
DROP TABLE targets;
DROP TABLE projects;

-- ADD
CREATE TABLE scan_orders (
  id              TEXT PRIMARY KEY,           -- ULID
  user_id         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','dns_pending','dns_verified',
                                    'vm_provisioning','running','completed',
                                    'failed','cancelled')),
  tier            TEXT NOT NULL CHECK (tier IN ('quick','deep')),
  primary_domain  TEXT NOT NULL,
  attack_surface_json TEXT NOT NULL DEFAULT '[]',
                  -- [{domain:"foo.com", primary:true, headers:[{k,v}]}]
  safety_rps      INTEGER NOT NULL DEFAULT 50,
  dns_verify_token TEXT NOT NULL,
  dns_verified_at INTEGER,
  vps_instance_id TEXT,
  scan_id         TEXT REFERENCES scans(id),
  failure_reason  TEXT,
  cancelled_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_scan_orders_user ON scan_orders(user_id, created_at DESC);
CREATE INDEX idx_scan_orders_status ON scan_orders(status, updated_at)
  WHERE status IN ('dns_pending','vm_provisioning','running');

CREATE TABLE deep_inquiries (
  id              TEXT PRIMARY KEY,           -- ULID
  user_id         TEXT REFERENCES users(id),  -- NULL if anonymous
  company         TEXT NOT NULL,
  contact_name    TEXT NOT NULL,
  position        TEXT,
  email           TEXT NOT NULL,
  phone           TEXT NOT NULL,
  domains_text    TEXT NOT NULL,
  desired_date    INTEGER,
  budget_band     TEXT,
                  -- 'under_X','X_Y','Y_Z','open'
  scope_text      TEXT NOT NULL,
  consent_accepted_at INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','contacted','converted',
                                    'declined','dropped')),
  telegram_sent_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE scan_events (
  id          TEXT PRIMARY KEY,
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,  -- vm_provisioning|vm_ready|agent_started|
                              -- finding_detected|phase_changed|completed|failed
  payload_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_scan_events_scan ON scan_events(scan_id, created_at);

-- ALTER users
ALTER TABLE users ADD COLUMN free_quick_consumed_at INTEGER;
ALTER TABLE users ADD COLUMN free_quick_quota_resets_at INTEGER;
```

### 2.8 vps-agent contract (env vars from cloud-init)

```
TENSOL_SCAN_ORDER_ID         — for webhook callback identity
TENSOL_TIER                  — quick|deep, selects Decepticon assistant_id
TENSOL_PRIMARY_DOMAIN        — target.com
TENSOL_ATTACK_SURFACE_JSON   — full JSON from scan_orders
TENSOL_SAFETY_RPS            — passed to Decepticon system prompt as
                                "respect rate limit ≤ X req/sec"
TENSOL_WEBHOOK_URL           — https://api.tensol.com/v1/webhooks/scan-complete
TENSOL_WEBHOOK_SECRET        — HMAC key for signed callback
TENSOL_EVIDENCE_S3_BUCKET    — Yandex Object Storage bucket name
TENSOL_EVIDENCE_S3_KEY_ID    — IAM access key (scoped: write-only,
                                limited to scan-specific prefix)
TENSOL_EVIDENCE_S3_SECRET    — IAM secret
DECEPTICON_MODEL_PROFILE     — eco (per [[tensol-oauth-local-smoke-phase-A-complete-2026-05-19]])
DECEPTICON_MODEL_PROVIDER    — api (production uses API keys, NOT OAuth
                                — that path requires operator's keychain
                                and is for local-dev only)
ANTHROPIC_API_KEY            — production API key
```

On completion, vps-agent:
1. Reads `/workspace/findings/*.md` + `evidence/*`
2. Archives evidence to tar.gz
3. Uploads tar.gz to Object Storage at
   `s3://${BUCKET}/scans/${SCAN_ORDER_ID}/evidence.tar.gz`
4. Sends HMAC-signed `POST ${WEBHOOK_URL}` with:
   ```json
   {
     "scan_order_id": "01ARZ…",
     "completed_at": "2026-05-19T08:53:43Z",
     "decepticon_events_count": 759,
     "findings": [
       {"raw_yaml_frontmatter": {...}, "body_md": "...", "evidence_keys": [...]},
       ...
     ],
     "evidence_archive_url": "s3://.../evidence.tar.gz",
     "duration_seconds": 2280
   }
   ```
5. Triggers self-shutdown via `sudo shutdown -h +1`
6. Backend's teardown job removes the VM afterward (Yandex Operation
   delete)

---

## 3. Data flow + state machines

### 3.1 Quick scan happy path (sequence)

See `§3.1` of the brainstorm — verbatim sequence diagram preserved in
the live design draft. Summary:

1. Visit `/` → CTA → magic-link signup
2. `/scan/new` → Wizard step 1: enter domain + auto-subdomain probe
3. Step 2: pick RPS (default 50)
4. Step 3: request DNS verify → backend returns
   `tensol-verify=<hex>` token, status → `dns_pending`
5. Frontend polls `GET /v1/scan-orders/:id/dns-verify/check` every 5s
   for up to 30 min. Backend resolves TXT via direct `dns.cloudflare.com`
   bypass (not system resolver). On success → status `dns_verified`.
6. Step 4: «Запустить бесплатный Quick» click →
   `POST /v1/scan-orders/:id/launch`. Backend:
   - free-tier check (atomic)
   - consume quota
   - INSERT scans row
   - INSERT jobs(`spawn_yandex_vm`)
   - audit `scan_started`
7. Worker picks job → Yandex API `POST compute/v1/instances`
   with `Idempotency-Key: <scan_order_id>` → returns `Operation`
8. Worker polls `GET /operation/:id` every 2s until `done: true`
9. Once VM RUNNING, cloud-init bootstraps Decepticon + vps-agent
10. vps-agent streams events → backend SSE
    (`vm_ready` → `agent_started` → `finding_detected` × N →
    `scan_completed`)
11. vps-agent sends HMAC-signed `POST /v1/webhooks/scan-complete`
12. Backend validates HMAC → `findings/ingest.ts` parses YAML+body →
    INSERT findings + audit-per-finding
13. status → `completed`. Enqueue PDF render job + email job +
    teardown job
14. Email delivered with PDF attached
15. Teardown job: `DELETE /compute/v1/instances/:id` + poll operation
    → VM destroyed

### 3.2 Deep inquiry happy path (sequence)

1. Visit `/pricing` → «Запросить Deep»
2. `/deep-inquiry` form (anonymous or auto-prefilled if logged in)
3. Submit → `POST /v1/deep-inquiries`
4. Backend validates schema → INSERT deep_inquiries → emit Telegram
   message to `@tensol_leadsbot` chat_id 496866748:
   ```
   🟢 NEW DEEP INQUIRY
   Компания: <company>
   Контакт: <name> (<position>)
   Email: <email>
   Тел: <phone>
   Домены: <domains>
   Дата: <desired_date>
   Бюджет: <budget_band>
   Scope: <scope_text>
   ID: <id>
   ```
5. UPDATE `telegram_sent_at`, audit `inquiry_telegram_sent`
6. Redirect client to `/deep-inquiry/thank-you`
7. (off-platform) Operator receives Telegram, contacts client manually
8. Manual status transitions in DB: `new → contacted → converted`
   (or `declined` / `dropped`)

### 3.3 State machines

#### scan_orders.status

```
                draft (POST /scan-orders)
                  │
                  ▼     attack-surface + safety filled
                draft
                  │
                  │  POST /dns-verify/request
                  ▼
            dns_pending
              │  │
              │  │ check loop (max 30 min)
              │  ▼
              │  success → dns_verified ── POST /launch ──▶
              │                                            │
              ▼  timeout / cancel                          │
            failed/cancelled                               ▼
                                                     vm_provisioning
                                                          │
                                                          │ spawnVm success
                                                          ▼
                                                       running
                                                       │   │
                                          webhook ok ──┘   └── webhook timeout
                                                              (90 min)
                                                          │   │
                                                          ▼   ▼
                                                   completed  failed
                                                       │
                                                       │ async (PDF + email + teardown)
                                                       ▼
                                                   teardown_pending → done
```

#### deep_inquiries.status

```
   new (POST /deep-inquiries)
    │  (manual operator action)
    ▼
  contacted
    │  ┌───────────┬──────────┐
    ▼  ▼           ▼          ▼
 converted    declined    dropped (no response)
```

### 3.4 Async invariants

1. **DNS poll** — frontend-triggered only in MVP. If client closes
   tab, order stays in `dns_pending` until they return.
2. **Webhook security** — HMAC signature mandatory, secret from
   cloud-init env, validated on every webhook.
3. **Scan timeout** — cron every 5 min: if `status=running AND
   now-started_at > 90 min` → mark `failed`, force-teardown VM.
4. **Free-tier race** — `consume_free_quick_quota` in `withTx` with
   `BEGIN IMMEDIATE`; atomic check + update.
5. **SSE reconnect** — `scan_events` table holds full history.
   On reconnect, dump events since last seen + tail new ones.
6. **Idempotent VM spawn** — Yandex `Idempotency-Key: <scan_order_id>`.
   Retries don't double-spawn.
7. **PDF render fallback** — if Puppeteer fails, status stays
   `completed`, email sent without attachment + dashboard link, retry
   3× background, then give up.

---

## 4. Error handling, abuse prevention, edge cases

### 4.1 Error matrix

| Where it breaks | Client sees | Backend action | Where it's logged |
|---|---|---|---|
| DNS TXT not found in 30 min | "Не удалось найти запись. [Retry] [Contact support]" | status=`failed` reason=`dns_timeout`. Quota NOT consumed | audit `dns_verify_failed`, `dns_check_attempts` log |
| Free-quota exhausted | "Ваш бесплатный Quick доступен через X дней. Запросить Deep?" CTA → /deep-inquiry | 429 with `retry_after_seconds` | audit `free_quota_blocked` |
| Yandex API unreachable (provision fails) | "Не удалось запустить VM. Бесплатный Quick автоматически возвращён." | Retry 3× → status=`failed` reason=`vm_spawn_failed`. **Revert** `consumed_at` to null. Telegram alert to operator | audit `vm_spawn_failed` + Telegram |
| VM crashes mid-scan | "Скан прервался. Бесплатный Quick возвращён." | Cron timeout 90 min → mark failed, force-teardown, refund quota | audit `scan_timeout` + Telegram |
| Decepticon returns 0 findings | "Сканирование завершено, уязвимостей не обнаружено. Запросите Deep для углубленного анализа." | status=`completed`, empty findings. PDF + email still sent | normal completion audit |
| Webhook with invalid HMAC | (silent) | 401, reject. Telegram alert | audit `webhook_invalid_signature` |
| PDF render fails | "Готово, PDF недоступен — [View online]" | status remains `completed`. Background retry 3×. Email without attachment | audit `pdf_render_failed` |
| Email send fails | (not visible, dashboard works) | Retry 3×, then 1-hour cron retry, then give up | audit `email_send_failed` |
| Browser disconnects during scan | On reconnect, sees current state | Order state persistent in DB | — |
| YooKassa webhook late/dup (post-MVP) | Idempotency dedup | (post-MVP) | (post-MVP) |
| Client revokes TXT after verified | Scan continues, verification is snapshot-in-time | No revoke logic in MVP | — |
| Client cancels < 3 min after start | "Скан отменён. Quick возвращён" | DELETE /scans/:id → cancelled. Force-teardown. Refund quota | audit `scan_cancelled` |
| Client cancels ≥ 3 min | "Скан отменён, квота не возвращается" | DELETE /scans/:id → cancelled. Force-teardown. NO refund | audit `scan_cancelled` |

### 4.2 Abuse prevention

| Threat | Mitigation |
|---|---|
| Scanning sites you don't own | DNS TXT verification — protects ~95% of cases. Shared-hosting subdomain abuse blocked (TXT must be on the exact entered domain). DNS poisoning mitigated by using `dns.cloudflare.com` / `dns.google` directly, not system resolver |
| Multi-account quota abuse | 1 free / 7 days per user_id (not email). Single email = single magic-link verified account. CAPTCHA / phone verification deferred unless abuse spikes |
| DDoS via our scanner | Safety RPS slider client-set. Decepticon respects rate limit in system prompt. Yandex VM has egress throttling. Actual RPS logged in evidence. Client confirmed DNS ownership = client authorized = ToS-covered |
| Account takeover | Magic-link auth (existing). HTTPS-only session cookies. CSRF middleware. Rate-limit 1 magic-link/60s |
| Credentials leak via Telegram (Deep) | Deep inquiry form does NOT collect credentials in MVP. Credentials negotiated off-platform via secure channel (Signal/PGP/in-person) |
| Webhook spoofing | HMAC-signed, secret only in backend + cloud-init env. Additional: IP allowlist for Yandex ru-central1 ranges |

### 4.3 Refund / quota-revert rules

| Case | Quota refunded? |
|---|---|
| DNS timeout | ✅ yes |
| User cancelled before VM start | ✅ yes |
| User cancelled < 3 min after VM start | ✅ yes |
| User cancelled ≥ 3 min | ❌ no (LLM tokens already spent) |
| VM spawn failed (our infra) | ✅ yes |
| Webhook timeout | ✅ yes |
| Decepticon returned 0 findings | ❌ no (valid result) |
| PDF render failed, findings exist | ❌ no |

When YooKassa goes live: same rules but `POST /v3/refunds` instead of
quota-revert.

### 4.4 Data safety

- **Evidence archives** (HTTP responses, JWT decoded, nmap output) in
  Yandex Object Storage, private bucket, per-scan keypath. Signed URLs
  with 7-day TTL. Lifecycle policy auto-deletes after 30 days
- **Findings.md** in SQLite. May contain client session tokens from
  their site. Mitigation: VM-level FDE on Yandex VM hosting backend
- **PII** in `deep_inquiries`: company name + ИНН + phone + email +
  contact name. РФ 152-ФЗ compliance:
  - Consent checkbox in form (required, audited)
  - Privacy policy in `/legal/privacy`
  - Right-to-delete via `support@` email
  - Telegram message body sanitized: regex-strip anything looking like
    a password before logging server-side

---

## 5. Testing strategy

### 5.1 Approach

- **Unit + IT (mocked)** = run on every push, fast (~3 sec)
- **PR-merge to main** = full suite incl. real Yandex (~15 min)
- **Nightly cron** = smoke test against operator-controlled
  `juice-shop.tensol.dev` instance, real path end-to-end

Budget: ~₽5-15k/month CI Yandex spend, justified by catching cloud-init
bugs + Yandex API drift before clients see them.

### 5.2 Test counts

| Tier | Count | Hours |
|---|---|---|
| Unit (Bun test) | ~125 | ~25h |
| Integration (mocked Yandex) | ~55 | ~25h |
| Integration (real Yandex) | ~15 | ~5h |
| E2E (Playwright) | 4 | ~12h |
| Contract (webhook) | 2 | ~3h |
| Fixtures | — | ~4h |
| **Total** | ~200 | ~74h (~2 weeks) |

Coverage targets: line ≥ 90%, funcs ≥ 92%, branch ≥ 80%.

### 5.3 Unit-level

`scan-orders/service.ts`, `free-tier/service.ts`, `dns-verify/service.ts`,
`deep-inquiries/service.ts`, `notify/telegram.ts`, `vps/provider.ts`,
`vps/yandex.ts` (mocked), `vps/cloud-init.ts`, `findings/ingest.ts`,
`reports/pdf.ts`, `notify/email.ts`, all schemas.

### 5.4 Integration level

Every HTTP endpoint, full request-response cycle, real SQLite, mocked
external services (Yandex/Telegram/Resend/Puppeteer). 70 tests cover:

- `POST /v1/auth/magic-link` (existing)
- `POST /v1/scan-orders` + `PATCH .../attack-surface, /safety`
- `POST /v1/scan-orders/:id/dns-verify/request`
- `GET /v1/scan-orders/:id/dns-verify/check`
- `POST /v1/scan-orders/:id/launch`
- `DELETE /v1/scan-orders/:id`
- `GET /v1/scans/:id` + `/events` (SSE) + `/findings` + `/report.pdf`
- `POST /v1/webhooks/scan-complete` (HMAC validation)
- `POST /v1/deep-inquiries` + `GET .../:id/thank-you`

### 5.5 Real-Yandex integration (15 tests)

Run only on PR-merge + nightly. Each spawns a real `tensol-test-<uuid>`
VM in dedicated test folder. `beforeAll`/`afterAll` enforce teardown.
Tests:
- spawnVm + pollOperation happy path
- spawnVm + Idempotency-Key dedup (same key returns same instance)
- spawnVm + Yandex 429 → backoff retry
- teardownVm idempotent
- getStatus through full lifecycle (provisioning → running → stopped)
- IAM token refresh on 401
- Cloud-init renders + boots (use minimal `ubuntu-2204-lts` image, no
  Decepticon — just verify cloud-init reaches a marker file)
- Webhook callback from real VM via real network
- Cleanup cron: pre-seed orphan VM, verify cron kills it

### 5.6 E2E (Playwright)

4 tests covering:
1. **Quick happy path** (real Yandex if PR-merge, mocked otherwise) —
   signup → wizard → DNS → launch → SSE → findings → PDF download
2. **Deep inquiry happy path** — anonymous form → Telegram mock called
3. **Free quota blocked** — fixtured user, expect 429 + CTA
4. **DNS verification timeout** — fast-forward clock, expect status
   `failed` reason `dns_timeout`

### 5.7 Contract test

`vps-agent/test/webhook-contract.test.ts`:
- vps-agent builds HMAC-signed payload
- Backend mock validates signature + Zod schema
- Reverse direction: backend builds expected payload → vps-agent's
  `verify-signature` succeeds

Catches drift between vps-agent and backend.

### 5.8 Yandex Cloud test infra (one-time setup)

- Dedicated folder `tensol-tests`
- Quota: 5 VMs concurrent, 10 vCPU total, 20 GB RAM total
- Service account `tensol-test-runner` with roles `compute.editor` +
  `vpc.user` + `storage.viewer`
- SA JSON key in GitHub Secrets (`YANDEX_TEST_SA_KEY_JSON`)
- Pre-provisioned: VPC + subnet in `ru-central1-a`, SSH key pair
- Yandex Cloud Budget alert at ₽5k/month → Telegram

### 5.9 Cleanup cron

`scripts/cleanup-orphan-vms.ts`:
- Runs every 15 min in production CI
- `compute list --filter='name CONTAINS "tensol-test-" AND createdAt < now-30min'`
- Deletes each, idempotent
- Alerts if > 0 orphans found (signals test missing `afterAll`)

VM naming: `tensol-test-<run-id>-<test-name>-<uuid8>`.

### 5.10 Out of scope for MVP

- k6 load testing
- Real YooKassa (deferred until live)
- Real Decepticon stack inside IT tests (smoke covers it)
- PDF visual regression
- Safari/Edge browser compat

---

## Open questions for spec author (`speckit-specify`)

1. **Pricing**: User said «flat price но я думаю поменять цены чтобы
   экономика билась» — exact ₽ values TBD. Spec must include
   cost-model worksheet (LLM cost per scan × profile × margin) so user
   can finalize on real numbers.
2. **YooKassa go-live trigger**: `TENSOL_YOOKASSA_LIVE=true` env flip
   activates Pay button. What's the exact migration story for any
   in-flight `scan_orders` at that moment? (probably trivial — Quick
   continues free, new Deep orders gain payment path)
3. **Subdomain auto-discovery in Step 1**: how aggressive? Cert
   transparency logs? Brute-force wordlist? Or just `www.<domain>` +
   user-added entries? Vector seems to do CT-log lookup
4. **Audit chain for deep_inquiries**: do they extend the same HMAC
   chain as scans, or separate? Recommend same chain for unified
   verify-chain CLI
5. **Mythos copy for Deep marketing**: positioning draft is in §2.6
   sketch; final marketing copy needs editor pass before launch

---

## Reference memories

- `[[tensol-blackbox-mvp-brainstorm-2026-05-19]]` — this brainstorm,
  in-flight state across multiple stop-hook checkpoints
- `[[tensol-oauth-local-smoke-phase-A-complete-2026-05-19]]` — proved
  Decepticon engine works on OAuth, 9 findings on Juice Shop
- `[[tensol-deployment-topology-2026-05-19]]` — Hetzner OUT, Yandex
  for RU, foreign-TBD
- `[[claude-oauth-creds-keychain-only-2026-05-19]]` — keychain
  extraction (used only for local dev, not for prod cloud VMs)
- `[[decepticon-image-env-var-drift-2026-05-19]]` — env var contract
  for production cloud deployment
- `[[xbow-gtm-and-mythos-2026-05-06]]` — Mythos positioning context

---

## Approval log

- Section 1 architecture: «принимаем, переходи к секции 2»
- Section 2 components (revised after Free Quick + Deep lead-gen
  pivots): «Да, переходим к секции 3»
- Section 3 data flow: «да»
- Section 4 error handling + abuse + refunds: «принимаю»
- Section 5 testing strategy with real Yandex: «реальный yandex…
  Real Yandex только на PR-merge + nightly»

---

*End of design document. Next: `speckit-specify` to author
implementation spec.*
