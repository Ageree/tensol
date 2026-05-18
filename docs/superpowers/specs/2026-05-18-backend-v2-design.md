# Tensol Backend v2 — Design (2026-05-18)

**Status:** draft (user auto-approved during brainstorming; spec-kit workflow chosen as next step)
**Author:** Claude (брейнсторм с пользователем)
**Trigger:** «весь бэкенд я считаю bloated... удалим весь бэкенд и заново его архитектурно спроектируем при помощи spec kit от github»

## Goal

Заменить текущий многослойный TS/Bun backend (apps/api + packages/{db,audit,contracts} + services/scan-runner — ~12 таблиц, ~14 commits архитектурных слоёв) **одним плоским Bun-пакетом** на ~5-7 таблиц, который служит тонкой SaaS-обёрткой над `external/decepticon/`. Сохранить три SaaS-инварианта: auth-proof, HMAC audit log, egress isolation через ephemeral VPS.

Цель UX осталась прежней (из simplification mandate 2026-05-09): URL + форма + кнопка → отчёт.

## Non-goals

- Менять `apps/site/` (фронт уже готов)
- Менять `external/decepticon/` (движок — оставляем как есть, можно `git pull` для актуала)
- Поддерживать миграцию данных со старой схемы (clean slate, в проде prod-данных нет — все запуски были smoke)
- HA / horizontal scaling сейчас (один процесс на одной машине, потолок ~10k сканов/день)
- Action-cap / cost-cap как отдельный слой (отдан Decepticon как env конфиг)

## Constraints (must-keep)

1. **Auth-proof** — нельзя начать скан без подтверждённого владения целью (DNS TXT / file-token / meta-tag)
2. **HMAC audit log** — каждая state-change операция (scan_started, decepticon_invoked, finding_emitted, …) пишется в `audit_log` с подписью; цепочка верифицируется
3. **Egress isolation** — каждый скан выполняется с ephemeral VPS с уникальным IP; никакого shared-IP воркера

## Stack decisions (locked)

| Слой | Выбор | Почему |
|------|-------|--------|
| Runtime | **Bun** | Уже знакомо, fast TS, native SQLite |
| HTTP | **Hono** | Уже знакомо, минимум boilerplate |
| ORM | **Drizzle** | Уже знакомо, типы из схемы, легкая миграция SQLite→PG позже |
| DB | **SQLite (файл)** | Один процесс, простой backup, потолок ~10k сканов/день — далеко за горизонтом |
| Auth | **Email + magic-link** | No bcrypt, no password reset, no email verify — B2B где люди логинятся редко |
| Topology | **Один Bun-бинарник** | HTTP + in-process job-runner в одном процессе; ephemeral VPS пушит progress в webhook |
| Decepticon контракт | **HTTP POST + final callback** | NO SSE, NO SSH, NO frontmatter parser. На VPS живёт мелкий Bun-сервер (~50 строк) |
| Repo layout | **Один плоский пакет `server/`** | Никаких `packages/*` |
| Spec workflow | **GitHub spec-kit CLI** | `/constitution → /specify → /plan → /tasks → /implement` |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  apps/site (фронт, без изменений)                            │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTPS, cookie-session
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  server/  — один Bun-процесс                                 │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  HTTP layer (Hono)                                      │ │
│  │   /api/auth/{request-link, verify, logout, me}          │ │
│  │   /api/projects, /api/targets                           │ │
│  │   /api/auth-proof/{challenge, verify}                   │ │
│  │   /api/scans/{start, get, list, cancel}                 │ │
│  │   /webhooks/scan-progress  ← VPS постит сюда            │ │
│  └────────────────────────────────────────────────────────┘ │
│                            │                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Job runner (in-process, polling SQLite)                │ │
│  │   • spawn-vps job (Hetzner/DO API)                      │ │
│  │   • wait-vps-ready job                                  │ │
│  │   • dispatch-to-decepticon job (HTTP POST)              │ │
│  │   • teardown-vps job                                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                            │                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Persistence (Drizzle + SQLite)                         │ │
│  │   users, sessions, projects, targets, auth_proofs,      │ │
│  │   scans, findings, audit_log, vps_instances             │ │
│  └────────────────────────────────────────────────────────┘ │
│                            │                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Crosscutting                                            │ │
│  │   • emitSignedAudit(...) — HMAC writer                  │ │
│  │   • requireAuth middleware                               │ │
│  │   • requireAuthProof middleware (scan-start gate)        │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────┘
                                   │ HTTPS
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Ephemeral VPS  (создаётся per scan, удаляется в конце)      │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │  agent.ts — Bun-сервер (~50 строк)                   │  │
│   │   POST /scan {target, profile, callbackUrl, signKey} │  │
│   │     → docker compose up decepticon                   │  │
│   │     → ждёт workspace/findings/*.md                   │  │
│   │     → собирает findings.json                          │  │
│   │     → POST callbackUrl с подписанным телом            │  │
│   │     → shutdown                                        │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                              │
│   docker compose:                                            │
│     - decepticon (Apache-2.0 движок, без изменений)          │
│     - neo4j, litellm, minio (его зависимости)                │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Компонент | Файл (предварительно) | Назначение |
|-----------|----------------------|------------|
| HTTP server | `server/src/server.ts` | Hono app, route bindings, port |
| Routes | `server/src/routes/{auth,projects,targets,scans,auth-proof,webhooks}.ts` | Один файл на ресурс |
| Job runner | `server/src/jobs/runner.ts` + `server/src/jobs/{spawn-vps,dispatch-scan,teardown-vps}.ts` | In-process, polling SQLite |
| DB | `server/src/db/schema.ts` + `server/src/db/client.ts` + `server/migrations/` | Drizzle |
| Audit | `server/src/audit/sign.ts` + `server/src/audit/emit.ts` | HMAC, тот же канонический формат что в EE-2 (13 pipe-delimited fields, alpha-sorted metadata) |
| VPS provider | `server/src/vps/provider.ts` (interface) + `server/src/vps/hetzner.ts` (impl) | Спавн + teardown |
| Magic-link | `server/src/auth/magic-link.ts` | Issue token, email send, verify, session create |
| Auth-proof | `server/src/auth-proof/challenge.ts` + `server/src/auth-proof/verify.ts` | DNS TXT / file token / meta-tag |
| VPS agent | `vps-agent/src/agent.ts` (отдельный файл, деплоится на VPS через cloud-init) | ~50 строк Bun |

Каждый файл — одна ответственность; 200-400 строк типично, 800 max.

## Data flow: scan lifecycle

1. **User создаёт project** → `POST /api/projects {name}` → row в `projects`
2. **User добавляет target** → `POST /api/projects/:id/targets {url}` → row в `targets` со status `unverified`
3. **User запрашивает auth-proof** → `POST /api/targets/:id/auth-proof/challenge` → backend генерит `tensol-verify=<random-32-bytes>`, возвращает три варианта (DNS TXT, file path, meta-tag) → row в `auth_proofs` со status `pending`
4. **User выполняет верификацию у себя на target** → нажимает «Проверить» → `POST /api/targets/:id/auth-proof/verify` → backend делает DNS/HTTP запрос к target → если совпало: `auth_proofs.status='verified'`, `targets.status='verified'`. Audit: `auth_proof_verified`
5. **User запускает скан** → `POST /api/scans {targetId, profile}` → middleware `requireAuthProof(targetId)` → если ок, создаётся `scans` row со status `queued`, job `spawn-vps` ставится в очередь. Audit: `scan_started`
6. **Job spawn-vps** — provider API создаёт VPS с cloud-init (устанавливает docker + Decepticon + agent.ts) → poll до status `running` → INSERT в `vps_instances` → audit `vps_provisioned`
7. **Job dispatch-scan** — `POST https://<vps-ip>/scan` с `{target, profile, callbackUrl: https://tensol/webhooks/scan-progress, signKey, scanId}` → VPS-агент отвечает 202 → scan.status='running'. Audit: `decepticon_invoked`
8. **VPS-agent работает** локально на своей VPS: запускает Decepticon docker, ждёт пока тот напишет `/workspace/findings/*.md`, агрегирует в один JSON: `{scanId, findings: [{severity, title, body, evidence}, ...], usage: {tokens, $}, status: 'done'}`
9. **VPS-agent делает один POST на webhook** с HMAC-подписью (signKey, выданный на шаге 7). Если webhook 200 OK — VPS-agent инициирует self-teardown (вызывает provider API delete-self)
10. **Backend webhook handler** — проверяет HMAC → INSERT findings → scan.status='completed' → audit `scan_completed` → enqueue `teardown-vps` (на случай если VPS не self-удалилась)
11. **User видит отчёт** в UI

### Failure modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| VPS не запустился за 5min | Job timeout | Mark scan `failed:vps_timeout`, teardown, audit |
| Decepticon hang | VPS-agent watchdog 30min | VPS-agent POST'ит webhook со status='failed:timeout', завершается |
| Webhook не дошёл | Backend каждые 10min проверяет stale 'running' scans | Pull VPS-agent через `GET /status`, если живой — repush; если нет — mark failed |
| Backend рестартанулся во время скана | На старте — query `vps_instances WHERE status='alive'`, для каждой GET /status, восстанавливаем job state | Webhook всё равно работает (URL не меняется) |
| HMAC signature mismatch на webhook | Reject 401 | Не теряем audit (запишем `webhook_signature_invalid`), VPS-agent retry-ит |

## Database schema (предварительно, финал — после `/plan`)

```sql
-- users
CREATE TABLE users (
  id TEXT PRIMARY KEY,        -- uuid v7
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

-- sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,        -- random 32 bytes
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- magic_link_tokens
CREATE TABLE magic_link_tokens (
  token TEXT PRIMARY KEY,     -- random 32 bytes
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- projects
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- targets
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL,       -- 'unverified' | 'verified' | 'expired'
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

-- auth_proofs
CREATE TABLE auth_proofs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id),
  challenge TEXT NOT NULL,    -- 'tensol-verify=...'
  method TEXT,                -- 'dns_txt' | 'file' | 'meta_tag' (выясняется на verify)
  status TEXT NOT NULL,       -- 'pending' | 'verified' | 'expired'
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);

-- scans
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES targets(id),
  profile TEXT NOT NULL,      -- 'recon' | 'standard' | 'max'
  status TEXT NOT NULL,       -- 'queued' | 'running' | 'completed' | 'failed'
  failure_reason TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  usage_tokens INTEGER,
  usage_usd_cents INTEGER
);

-- findings
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id),
  severity TEXT NOT NULL,     -- 'critical' | 'high' | 'medium' | 'low' | 'info'
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  evidence_json TEXT,         -- JSON blob
  created_at INTEGER NOT NULL
);

-- audit_log
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  scan_id TEXT,
  event TEXT NOT NULL,        -- 'scan_started', 'decepticon_invoked', ...
  metadata_json TEXT,
  prev_signature TEXT NOT NULL,
  signature TEXT NOT NULL     -- HMAC, 13-field canonical message
);

-- vps_instances
CREATE TABLE vps_instances (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id),
  provider TEXT NOT NULL,     -- 'hetzner' | 'do' | 'yandex'
  provider_id TEXT NOT NULL,  -- ID в провайдерском API
  ip TEXT,
  status TEXT NOT NULL,       -- 'provisioning' | 'alive' | 'tearing_down' | 'destroyed'
  sign_key TEXT NOT NULL,     -- HMAC key для webhook
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
);
```

**Indexes** на `scans.user_id`, `scans.status`, `findings.scan_id`, `audit_log.scan_id`, `vps_instances.status`.

## HTTP API surface (preview)

```
# Auth
POST   /api/auth/request-link        { email } → 204 (отправляет magic link)
GET    /api/auth/verify?token=...    → 302 /dashboard (создаёт сессию в cookie)
POST   /api/auth/logout              → 204
GET    /api/auth/me                  → { user }

# Projects
GET    /api/projects                 → [...]
POST   /api/projects                 { name } → { project }
DELETE /api/projects/:id             → 204

# Targets
GET    /api/projects/:id/targets     → [...]
POST   /api/projects/:id/targets     { url } → { target }
DELETE /api/targets/:id              → 204

# Auth-proof
POST   /api/targets/:id/auth-proof/challenge  → { challenge, methods }
POST   /api/targets/:id/auth-proof/verify     { method } → { verified }

# Scans
POST   /api/scans                    { targetId, profile } → { scan }
GET    /api/scans                    → [...]
GET    /api/scans/:id                → { scan, findings }
POST   /api/scans/:id/cancel         → 202

# Webhooks (вызывает VPS-agent, HMAC-подписан)
POST   /webhooks/scan-progress       { scanId, status, findings?, usage? } → 200
```

## Error handling

- **Validation** на границе HTTP — Zod schema per route, 400 с {error, details}
- **Auth errors** — 401 без подробностей; audit `auth_failed`
- **Auth-proof failures** — 403 со списком методов которые НЕ совпали (DNS/file/meta-tag)
- **Job runner errors** — `try/catch` вокруг каждого job step, mark scan `failed:<reason>`, audit, дальше teardown
- **VPS provider errors** — 3 retry с exponential backoff (1s, 5s, 25s); если всё ещё fail — mark scan failed
- **Webhook signature mismatch** — 401, audit, НЕ менять scan state (VPS retry)
- **Никаких silent swallows.** Каждый `catch` либо audit'ит, либо rethrow'ит выше

## Testing strategy

- **Unit** (`server/src/**/*.test.ts`, bun test) — pure functions: HMAC sign/verify, magic-link generation, auth-proof challenge format, scope normalisation
- **Integration** (`server/tests/integration/`) — Hono app + SQLite in-memory + fake VPS provider; покрывает каждый route + job
- **E2E** (вне backend, в `apps/site`) — Playwright против реального backend на localhost; критичный flow: login → create project → add target → verify auth-proof → start scan → see fake findings (через mock VPS-agent)
- **Coverage** — целевая 80% по правилам ~/.claude/rules/testing.md

Стартовый набор тестов пишется ДО реализации (TDD per global rules).

## Что удаляется

```
apps/api/                     ← Hono coordinator, scope-engine, start-decepticon-session, workspace extractor
packages/db/                  ← Drizzle PG schema + 27 миграций
packages/audit/               ← HMAC writer (логика переедет в server/src/audit/)
packages/contracts/           ← Zod schemas (логика переедет в server/src/schemas/)
packages/* (все остальные)
services/scan-runner/         ← old worker (DEPRECATED уже)
services/validator-worker/    ← already DEPRECATED
tests/integration/            ← старые ITs, перепишутся под новую структуру в server/tests/
.harness/                     ← (отдельный вопрос — build-tool, не runtime; пока не трогаем)
```

## Что НЕ трогаем

```
apps/site/                    ← фронт, готов
external/decepticon/          ← движок
docs/                         ← документация и research
PLAN-2026-05-12.md            ← (TODO решить позже)
.claude/, .object-storage/    ← инфра
package.json / bun.lock       ← пересоберём, но репо остаётся монорепой по факту (есть apps/site)
```

## Migration order

1. ✅ Этот design doc написан и закоммичен
2. Install spec-kit: `uvx --from git+https://github.com/github/spec-kit.git specify init --here --ai claude`
3. `/constitution` — зафиксировать invariants
4. `/specify` — описать WHAT (текущий doc как основа)
5. `/plan` — описать HOW (стек уже выбран, доуточнить структуру файлов)
6. `/tasks` — сгенерить таски
7. **Single commit deletion** старого бэка (за один шаг, легко откатить через `git revert`)
8. `/implement` — пишем новый `server/` по таскам, TDD
9. Подключаем фронт к новому API (он уже зовёт `/api/*`, нужно сверить контракт)
10. Smoke-scan на example.com через новую систему

## Open questions для `/specify` и `/plan`

1. **VPS-провайдер**: Hetzner / DigitalOcean / Yandex Cloud? Memory упоминает Yandex (RU egress зоны), но 2026-05-09 решение было Hetzner/DO для self-serve MVP. Уточнить в /plan.
2. **Magic-link emailer**: Resend / Postmark / SES / smtp? Из RU доступности — вопрос.
3. **Webhook reachability**: backend должен быть на публичном URL чтобы VPS-agent мог дозвониться. Для local dev — ngrok / cloudflared tunnel.
4. **Reuse audit signing key**: тот же `AUDIT_SIGNING_KEY` из старой EE-2? Или ротируем при clean-slate?
5. **Frontend contract sync**: apps/site сейчас зовёт старые endpoints. Сверка после deletion — какие пути совпадают, какие нет.

---

## Self-review (inline)

- ✅ Placeholder scan: нет TBD/TODO внутри спецификации, кроме явно помеченных open questions
- ✅ Internal consistency: schema, API surface, data flow — все согласованы
- ✅ Scope check: один backend rewrite, одна спецификация, decomposition не нужен
- ✅ Ambiguity: webhook signature method (HMAC algo) — uses same family as EE-2 (HMAC-SHA256), uniform across audit & webhook
