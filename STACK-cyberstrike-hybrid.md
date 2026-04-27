# AI Pentest Platform Stack — Decepticon Core + CyberStrikeAI Tooling

> Активная версия стека. Decepticon = автономное ядро (16 агентов, kill chain, изоляция). CyberStrikeAI = curated tool catalog + UI patterns + MCP. K2.6 = orchestrator swarm.

## Цель

Построить XBOW-like платформу для автономного pentest / authorized adversary-emulation продукта под РФ рынок, где:

- **Decepticon** (PurpleAILAB, Apache-2.0) — autonomous Red Team agent, ядро платформы. 16 специализированных агентов, полная kill chain, профессиональная дисциплина (OPPLAN / RoE / ConOps), изолированная инфраструктура (dual Docker network), Offensive Vaccine loop.
- **CyberStrikeAI** (Ed1s0nZ, Apache-2.0) — supplementary tool breadth (100+ YAML-рецептов), MCP-интеграция, Web UI patterns, role-based testing, skill methodology library. Используется cherry-pick, без принятия offensive C2 / persistence частей.
- **Kimi K2.6** — primary orchestrator LLM с native 300-agent swarm. Подключается к Decepticon через LiteLLM proxy.

Ключевые принципы:

- один облачный провайдер: `Yandex Cloud`
- один продуктовый язык: `TypeScript + Bun` (Decepticon Python — внутри sandbox, не часть продукта; CyberStrikeAI Go-binary — tool runner sidecar)
- **`Kimi K2.6` как primary LLM** — через Decepticon's LiteLLM proxy, swarm до 300 sub-агентов
- **open-weights = self-hostable на Yandex Cloud GPU** — критично для RU-комплаенса
- browser-first как primary signal source
- findings только после deterministic validation
- продукт позиционируется как `authorized pentest platform`, не offensive tooling company

## Что мы берём из каждого проекта

### Decepticon — ядро (берём всё, адаптируем)

**Архитектура:**
- 16 specialist agents по фазам kill chain: Decepticon (main), Soundwave (planning), Recon, Scanner, Exploit, Exploiter, Detector, Verifier, Patcher, Post-Exploit, Defender, AD Operator, Cloud Hunter, Contract Auditor, Reverser, Analyst
- Dual network isolation: `sandbox-net` (Kali sandbox + C2 + targets) ↔ `decepticon-net` (LLM gateway + DB + agent API) — zero cross-network access
- Tmux-based interactive shell handling (msfconsole, sliver-client, evil-winrm — persistent sessions)
- Neo4j knowledge graph для attack path tracking
- Offensive Vaccine loop: attack → defend → verify (автоматическая генерация defensive recommendations)

**Профессиональная дисциплина:**
- OPPLAN (Operations Plan) генерация с MITRE ATT&CK mapping
- RoE (Rules of Engagement) — authorized scope, exclusions, testing window
- ConOps (Concept of Operations) — threat actor profile, TTPs
- Deconfliction Plan — для SOC coordination

**Модели через LiteLLM (перенастраиваем на K2.6):**
- Profile `eco`: K2.6 (orchestrator) → K2.6 (exploit) → K2.6-flash (recon) — production
- Profile `max`: K2.6 (all roles) — high-value targets
- Profile `test`: K2.6-flash (all) — development / CI
- Fallback: Claude Opus 4.x (verifier role / independent second opinion)

**Что адаптируем:**
- LLM provider: с Claude API → K2.6 через LiteLLM (Decepticon уже поддерживает любой provider через LiteLLM proxy)
- Web dashboard: с Decepticon built-in → наш собственный React SPA (Decepticon dashboard как reference)
- Storage: с Decepticon SQLite/Neo4j → Yandex Managed PostgreSQL + Neo4j (managed или self-hosted в K8s)
- Infra: с local Docker Compose → Yandex Managed Kubernetes

### CyberStrikeAI — supplementary (берём выборочно)

**Tool YAMLs (~55 из 100+):**

- Recon: `nmap`, `masscan`, `rustscan`, `amass`, `subfinder`, `dnsenum`, `fierce`, `feroxbuster`, `gobuster`, `ffuf`, `dirsearch`, `katana`, `paramspider`, `gau`, `waybackurls`, `wafw00f`
- Web: `nuclei`, `sqlmap`, `zap`, `wpscan`, `dalfox`, `jaeles`, `nikto`, `x8`, `xsser`
- API: `jwt-analyzer`, `api-schema-analyzer`, `graphql-scanner`, `arjun`
- Cloud: `pacu`, `prowler`, `scout-suite`, `kube-hunter`, `kube-bench`, `trivy`, `terrascan`, `checkov`, `cloudmapper`, `falco`, `clair`
- OSINT (опц., gated): `shodan_search`, `quake_search`
- AD-recon (read-only): `enum4linux-ng`, `nbtscan`, `arp-scan`, `rpcclient`

**Skill methodology docs (~18 из 23):**

`api-security-testing` / `business-logic-testing` / `cloud-security-audit` / `command-injection-testing` / `container-security-testing` / `csrf-testing` / `deserialization-testing` / `file-upload-testing` / `idor-testing` / `secure-code-review` / `sql-injection-testing` / `ssrf-testing` / `vulnerability-assessment` / `xpath-injection-testing` / `xss-testing` / `xxe-testing` / `mobile-app-security-testing`

**UI patterns (reference, не fork):**
- Attack-chain graph visualization + risk scoring + step-by-step replay
- Vulnerability management CRUD + severity tracking + status workflow
- Role-based testing dropdown (12+ predefined security roles)
- HITL (Human-in-the-Loop) sidebar — approval mode + tool allowlists
- WebShell management patterns (для будущего enterprise scope)

**MCP integration:**
- HTTP / stdio / SSE transports
- External MCP federation pattern
- Burp Suite plugin reference

### ❌ НЕ берём

**Из CyberStrikeAI:**
- `mcp-servers/reverse_shell` — C2 / persistence
- `webshell_*` tools — webshell C2
- `metasploit`, `msfvenom`, `responder`, `impacket`, `bloodhound`, `netexec`, `smbmap`, `hydra`, `hashcat`, `john` — offensive / cred attack без явного клиентского scope
- `linpeas`, `pwntools`, `ropgadget`, `ropper`, `gdb`, `ghidra`, `radare2` — binary RE / post-exploitation (Decepticon имеет собственного Reverser-агента для этого)
- `volatility3`, `binwalk`, `foremost`, `exiftool`, `steghide` — forensics (другой продукт)
- Default Aliyun / Qwen / FOFA конфиг

**Из Decepticon:**
- Sliver C2 по умолчанию — отключаем для авторизованного pentest scope без post-exploit C2 (включаем только при explicit enterprise scope с foothold-внутри-сети)
- Public demo с Metasploitable 2 — internal lab only, не в продукте

### 🔧 Заменяем

- LLM provider: с Claude API → **Kimi K2.6 (primary)** через Decepticon's LiteLLM proxy + Claude Opus 4.x (fallback / verifier)
- LLM hosting: international API endpoints (`api.moonshot.ai`) → self-hosted K2.6 на Yandex Cloud GPU когда ARR покроет инфру
- Storage: с Decepticon SQLite + Neo4j → Yandex Managed PostgreSQL + Neo4j
- UI: с Decepticon built-in dashboard → собственный React SPA (Decepticon + CyberStrikeAI dashboards как reference)
- Knowledge base: с CyberStrike Chinese-default content → переведённые / адаптированные skill MD + Decepticon Neo4j attack graphs

## Orchestrator: Kimi K2.6 через Decepticon LiteLLM

K2.6 — primary LLM с встроенным agent swarm (до 300 sub-агентов, 4000 шагов). Decepticon уже имеет LiteLLM proxy — мы перенастраиваем его на K2.6.

### Как Decepticon использует LLM

Decepticon's LiteLLM proxy управляет routing'ом моделей по агентам. Мы настраиваем:

```yaml
# .env Decepticon — model profiles через LiteLLM
DECEPTICON_MODEL_PROFILE=eco

# eco profile (перенастроенный):
# orchestrator → K2.6 (moonshot/openai-compatible endpoint)
# exploit      → K2.6
# recon        → K2.6-flash (fast/cheap)
# fallback     → Claude Opus 4.x (Anthropic)
```

Decepticon сам управляет:
- Какой агент какую модель вызывает
- Fallback при rate limit / outage
- Context window per agent (fresh context per objective — no accumulated noise)
- Prompt engineering для каждой роли

### Что K2.6 даёт из коробки

- **До 300 параллельных sub-агентов** на сессию
- **До 4000 координированных шагов**
- **256K context на каждого sub-агента**
- **PARL training** — Parallel-Agent Reinforcement Learning
- **Native tool-use**: модель сама решает когда вызвать tool

### Что Decepticon делает сам (не пишем)

- ❌ 16 specialist agents (kill chain phases) — встроены
- ❌ Interactive shell management (tmux) — встроено
- ❌ Attack path tracking (Neo4j) — встроено
- ❌ OPPLAN / RoE / ConOps generation — встроено
- ❌ Offensive Vaccine loop — встроено
- ❌ Sandbox isolation (dual network) — встроено
- ❌ Model routing / fallback — встроено (LiteLLM)

### Что мы по-прежнему пишем сами

- ✅ **Product coordinator** — assessment lifecycle, scope enforcement, mission state persistence между сессиями
- ✅ **Browser-worker** (Playwright) — browser-first signal source, наш основной сигнал
- ✅ **Deterministic validators** (xss / ssrf / file-read / rce) — финальный gate, не доверяется LLM
- ✅ **Scope enforcement** — hard-coded check на каждый tool call (Decepticon sandbox + наш allow-list)
- ✅ **CyberStrike tool bridge** — curated YAMLs как supplementary tools для Decepticon агентов
- ✅ **Cost / reliability guards** — Decepticon + K2.6 swarm monitoring, kill-switch при divergence
- ✅ **React SPA** — product UI (findings, reports, dashboard)
- ✅ **Reporting** — PDF report generation (RU + GOST R templates)
- ✅ **Auth / multi-tenancy** — Decepticon single-user, наш продукт — multi-tenant SaaS

### Swarm reliability

Decepticon имеет собственные guards (fresh context per agent objective, Kali sandbox isolation). Добавляем наши:

```typescript
interface SwarmReliabilityGuard {
  max_wall_clock_seconds: number;   // hard timeout, default 30 мин
  max_total_steps: number;          // защита от infinite loop, default 4000
  per_subagent_step_cap: number;    // один sub-agent застрял >100 шагов — выгрузить
  divergence_detector: boolean;      // последние 50 шагов без нового evidence — kill
}
```

**Budget caps намеренно нет** — приоритет: запуск, не экономия токенов. Cost tracking только для post-hoc analytics.

### LLM provider strategy

| Этап | Provider | Почему |
|---|---|---|
| **Phase 1-3 (MVP build)** | `api.moonshot.ai` через Decepticon LiteLLM | Нет инфраструктурных задач, фокус на продукте |
| **Phase 4-5 (first paying clients)** | Тот же + own LLM gateway slim layer (audit log, model routing) | Control plane для observability |
| **Phase 6+ (enterprise scale)** | Self-host K2.6 на Yandex Cloud GPU | Data-residency SLA |
| **Verifier role / fallback** | Claude Opus 4.x через Anthropic API | Independent second opinion для critical findings |

## Зафиксированный стек

### Frontend

- `React`
- `TypeScript`
- `Vite`
- `React Router`
- `TanStack Query`
- `Zustand`

### Backend (продуктовый)

- `Hono`
- `Bun`
- `Playwright + Chromium`

### Pentest Engine

- **Decepticon** (Python, Docker) — autonomous Red Team agent, 16 специалистов, kill chain, изоляция
- Decepticon LiteLLM proxy → K2.6 primary, Claude Opus fallback
- Decepticon Neo4j → attack path knowledge graph

### LLM orchestration

- **`Kimi K2.6`** (Moonshot, open-weights, Modified MIT) — primary через Decepticon LiteLLM
- `Claude Opus 4.x` (Anthropic) — verifier role / fallback
- Own gateway slim layer: audit log / model routing

### Tool execution layer

- **Decepticon sandbox** (Kali Linux Docker) — primary tool execution environment
- `cyberstrike-runner` (Go binary, sidecar) — supplementary curated tool YAMLs (~55), custom MCP config
- Запускается в private K8s namespace, доступен через MCP HTTP

### Infra

- `Yandex Managed PostgreSQL`
- `Yandex Message Queue`
- `Yandex Object Storage`
- `Yandex Container Registry`
- `Yandex Managed Kubernetes`
- `Yandex Application Load Balancer`

### Security / Testing Tools

- Decepticon built-in tools (recon → exploit → post-exploit) как primary
- `Playwright` for browser automation and validation (primary signal source)
- `Nuclei` (через cyberstrike-runner) as signal source for known issues
- `Interactsh` (self-hosted) as OOB proof service
- CyberStrike curated tools (supplementary, через MCP)

### Observability

- `Sentry`
- `OpenTelemetry`

## Сервисы v1

### 1. web

React SPA для console UI. Reference: Decepticon web dashboard + CyberStrikeAI UI patterns.

### 2. api

`Hono + Bun` API для:

- auth / multi-tenancy
- projects / targets
- assessments
- findings
- evidence
- artifacts
- scope rules
- skill library (CyberStrike methodology docs + Decepticon agent docs, queryable)
- Decepticon session management (start/stop/status)

### 3. coordinator

**Тонкий сервис.** Decepticon — основная runtime логика pentest'а. Coordinator управляет:

- **Assessment lifecycle**: создание session → формирование Decepticon OPPLAN с target / scope / available tools
- **Decepticon instance management**: запуск/остановка Decepticon Docker deployment на ассессмент (один Decepticon instance = один assessment)
- **Scope enforcement**: наш allow-list как overlay на Decepticon sandbox (target host whitelist)
- **Mission state persistence**: между Decepticon sessions (crash → resume)
- **Tool routing**: Decepticon sandbox (primary) ↔ cyberstrike-runner (supplementary) ↔ browser-worker (browser-first)
- **Validator dispatch**: candidate findings от Decepticon → deterministic validators
- **Final findings collection**: validators → БД → report
- **Reliability kill-switch**: wall-clock timeout / step cap / divergence detector
- **Post-hoc cost analytics**: audit only, не blocking

### 4. decepticon-engine

Decepticon Docker deployment (dual network isolation):

- `sandbox-net`: Kali Linux sandbox + C2 server + targets
- `decepticon-net`: LLM gateway (LiteLLM → K2.6) + agent API + Neo4j + DB
- Agent API доступен coordinator через Docker socket
- LiteLLM proxy сконфигурирован на K2.6 (primary) + Claude Opus (fallback)

### 5. http-worker

- HTTP probing
- API exploration
- OpenAPI ingestion
- SSRF / file-read / RCE prechecks
- OOB checks через Interactsh

### 6. cyberstrike-worker

Supplementary tool execution:

- вызов curated tool YAMLs через `cyberstrike-runner` MCP (инструменты не в Decepticon default set)
- нормализация tool output в общий `observation` schema
- enforcement allow-list scope
- timeout / RPS / politeness throttle
- НЕ вызывает offensive / C2 / persistence tools

### 7. browser-worker

- login flows
- authenticated crawling
- JS-heavy navigation
- DOM inspection
- XSS verification
- screenshots / traces / HAR

### 8. validator-worker

Deterministic validation (наш код, не Decepticon's Verifier агент):

- `xss-validator`
- `ssrf-validator`
- `file-read-validator`
- `rce-validator`

Принимает candidate findings от Decepticon / http-worker / cyberstrike-worker / browser-worker. Финальная находка публикуется только после re-play через validator.

### 9. oob

Self-hosted `interactsh` для callback-based proof.

## Очереди

- `assessment.start`
- `decepticon.command` (отправка команд в Decepticon sandbox)
- `decepticon.findings` (candidate findings от Decepticon)
- `recon.http`
- `recon.browser`
- `recon.cyberstrike`
- `attack.http`
- `attack.browser`
- `attack.cyberstrike`
- `validate.finding`
- `report.build`

## Данные в Postgres

Минимальные таблицы:

- `users`
- `projects`
- `targets`
- `assessments`
- `assessment_scope_rules`
- `assessment_artifacts`
- `decepticon_sessions` (link assessment ↔ Decepticon instance)
- `jobs`
- `findings`
- `finding_evidence`
- `observations_http`
- `observations_browser`
- `observations_cyberstrike`
- `observations_decepticon` (Decepticon agent output, normalized)
- `oob_events`
- `skill_library` (CyberStrike methodology docs + Decepticon agent docs)
- `tool_allowlist` (config — какие YAML tools разрешены)

## Worker Model

Принцип:

- Decepticon — primary pentest engine (autonomous, 16 агентов, kill chain)
- coordinator управляет lifecycle + scope + validation
- cyberstrike-worker — supplementary tools не в Decepticon default
- browser-worker — browser-first signal (наш основной сигнал)
- finding публикуется только после deterministic validator
- Decepticon sandbox — изолированная среда, единственный путь к offensive tooling

### Decepticon engine

Разрешено:

- Все 16 agent roles в рамках OPPLAN
- LiteLLM → K2.6 (primary) + Claude Opus (fallback)
- Kali sandbox tools (встроенные)
- Neo4j knowledge graph
- Offensive Vaccine loop (attack → defend → verify)

Ограничено (наш overlay):

- Target host whitelist (наш scope enforcement поверх Decepticon)
- Sliver C2: disabled по умолчанию, enabled только при explicit `assessment.has_foothold = true` (enterprise scope)
- Metasploit: только при explicit scope approval

### Browser worker

Разрешено:

- `Playwright`
- чтение DOM, JS, cookies, storage
- HTTP(S) только по scope и allow-visit доменам
- trace / screenshot / HAR

### HTTP worker

Разрешено:

- custom HTTP actions
- `Nuclei`
- OOB payloads в рамках scope
- helper scripts
- request replay

### CyberStrike worker

Разрешено:

- вызов tool YAML из allow-list через MCP
- stdout / stderr / parsed output → нормализация
- scope enforcement: target host обязан быть в `assessment_scope_rules`

Запрещено:

- любой YAML за пределами allow-list
- запуск reverse-shell / webshell / metasploit / impacket / bloodhound / responder
- modification файлов на target

### Validator worker

Разрешено:

- replay candidate exploit
- browser replay
- OOB verification
- evidence packaging

### Ingestion logic

Должна поддерживать:

- `OpenAPI` / `Swagger`
- route extraction
- docs upload
- source code upload
- security reports as context
- skill library lookup

## Инструменты агентов

**Decepticon built-in (primary, всегда доступны):**

- 16 specialist agents с full kill chain coverage
- Recon agents (nmap, custom recon)
- Exploit agents (interactive shells через tmux, msfconsole, sliver-client)
- Post-exploit agents (AD Operator, Cloud Hunter)
- Detector → Verifier → Exploiter → Patcher pipeline
- Defender agent (Offensive Vaccine)
- Reverser, Analyst specialists

**Browser-first (наш core signal):**

- browser actions (Playwright)
- HTTP executor
- OpenAPI parser
- validator replay
- skill library query

**CyberStrike supplementary (через cyberstrike-worker):**

- recon: masscan / rustscan / amass / subfinder / nuclei / katana / ffuf / gobuster / dirsearch
- web: sqlmap / dalfox / wpscan / nikto / wafw00f
- api: jwt-analyzer / api-schema-analyzer / graphql-scanner
- cloud (если scope cloud): trivy / kube-bench / scout-suite / prowler

**OOB:**

- Interactsh

Инструменты без явного enterprise scope — Sliver C2, Havoc, Evilginx, metasploit, mimikatz, post-exploit persistence — **не входят в default stack**. Decepticon имеет эти инструменты, но они gated за `assessment.scope_flags`.

## Compliance / Supply Chain

### Decepticon (PurpleAILAB, Южная Корея)

- Apache-2.0 license
- Активная разработка: ~11 месяцев, 2700+ stars, 8 contributors
- Профессиональная Red Team дисциплина (OPPLAN / RoE / ConOps)
- Docker-native изоляция (dual network)
- LiteLLM proxy = vendor-agnostic LLM routing (не привязаны к Claude)

**Меры:**
- Pinned upstream commit в Yandex Container Registry
- Custom LiteLLM config → K2.6 (не зависим от Claude API в продакшене)
- Decepticon sandbox egress firewall: только к нашему coordinator API + LLM gateway
- Quarterly upstream review

### CyberStrikeAI (Chinese, single-author)

- Apache-2.0 license
- 3500+ stars, активное комьюнити
- ⚠️ Репутационный риск: публично связан с атаками на FortiGate (The Hacker News, BleepingComputer, CSO Online)
- Используем ТОЛЬКО tool YAMLs + skill docs + UI reference patterns, НЕ движок

**Меры:**
- Pinned upstream commit, mirror в Yandex Container Registry
- Custom MCP config с allow-list
- No outbound к dashscope.aliyuncs.com / api.fofa.so
- Quarterly upstream review перед bump
- В продукте не упоминаем CyberStrikeAI по имени (brand distance)

### Российский рынок

- Yandex Cloud only
- 152-ФЗ compliance: персональные данные клиента в managed PG, не уходят наружу
- GOST R / FSTEC report templates — Phase 2
- Audit log полный (Sentry + OpenTelemetry + DB-side write log)

## Deployment в Yandex Cloud

### Public

- `Application Load Balancer`
- `web`
- `api`

### Private / cluster internal

- `coordinator`
- `decepticon-engine` ← Decepticon Docker deployment (sandbox-net + decepticon-net)
- `http-worker`
- `cyberstrike-worker`
- `cyberstrike-runner` ← sidecar в worker pod
- `browser-worker`
- `validator-worker`
- `oob`

### Managed Services

- `Managed PostgreSQL`
- `Message Queue`
- `Object Storage`
- `Container Registry` (с mirror'ом Decepticon + cyberstrike-runner images)

## Product Boundary

Платформа строится как:

- `authorized pentest platform`
- `exploit-validated security testing`
- `adversary emulation for owned and authorized environments`
- `autonomous red team with professional engagement discipline` (OPPLAN / RoE / ConOps от Decepticon)

Платформа не позиционируется как:

- malware tooling
- phishing platform
- offensive tooling company
- stealth / persistence platform
- C2 / red-team-as-a-service (без явного enterprise scope)

## Порядок разработки

### Phase 1 — Foundation

- `api`
- DB schema (включая `decepticon_sessions`, `tool_allowlist`, `skill_library`)
- auth / multi-tenancy
- projects / targets / assessments CRUD
- import + index CyberStrike `skills/*.md` в `skill_library`

### Phase 2 — Decepticon integration

- Decepticon Docker deployment в Yandex K8s (dual network isolation)
- LiteLLM proxy config → K2.6 (primary) + Claude Opus (fallback)
- `coordinator` service: assessment lifecycle, Decepticon instance management
- Decepticon agent API ↔ coordinator integration
- Scope enforcement overlay (target host whitelist)
- Reliability kill-switch (wall-clock timeout / step cap / divergence detector)
- Audit log каждого K2.6 запроса → Object Storage

### Phase 3 — Browser-first signal

- `browser-worker`
- login flows
- trace / screenshot capture
- browser findings → Decepticon context feed

### Phase 4 — HTTP signal

- `http-worker`
- OpenAPI ingestion
- baseline Nuclei adapter

### Phase 5 — CyberStrike supplementary tools

- `cyberstrike-runner` Docker build (pinned commit, custom MCP config с allow-list)
- `cyberstrike-worker` (Bun) с MCP client
- import + integration ~55 curated tool YAMLs
- enforcement: outbound firewall, scope check, no-egress-PRC verification

### Phase 6 — Validation

- `oob`
- `Interactsh` integration
- validator flows (xss / ssrf / file-read / rce)
- Decepticon candidate findings → deterministic validators → published findings
- Offensive Vaccine loop integration (Decepticon Defender agent → наш validation pipeline)

### Phase 7 — Reporting

- evidence model
- findings UX
- PDF report generation (RU + GOST R templates)
- Decepticon Neo4j attack graph → visual report

## Main Bet

Наша ставка — связка:

- **Decepticon** как autonomous pentest engine (16 агентов, kill chain, профессиональная дисциплина, изоляция)
- **K2.6 swarm** как reasoning layer (300 sub-агентов, 4000 шагов, через Decepticon LiteLLM)
- **browser-first testing** (primary signal)
- **OOB proof** (Interactsh)
- **deterministic validators** (final gate, наш код)
- **CyberStrike curated tools** (supplementary breadth, без offensive C2)
- **Decepticon Offensive Vaccine** (attack → defend → verify loop)
- **Decepticon Neo4j** (attack path knowledge graph)
- evidence-first findings
- supply-chain hygiene (pinned mirrors, no PRC-egress, replaceable LLM provider)

Decepticon даёт нам autonomous red team capability «из коробки» — не нужно писать 16 агентов, shell management, OPPLAN generation, attack path tracking. Мы фокусируемся на продукте: UI, validation, compliance, multi-tenancy, reporting.

## Что осталось решить (open questions)

### Decepticon-related
- **Decepticon API stability** — agent API для external control (start/stop/status/pause/inject findings). Если нет — нужен thin wrapper поверх Docker socket + log parsing.
- **Decepticon + K2.6 compatibility** — LiteLLM proxy поддерживает OpenAI-compatible endpoints, Moonshot API совместим. Но нужно протестировать tool-use формат K2.6 vs Decepticon prompt templates.
- **Multi-tenancy isolation** — один Decepticon instance на assessment = resource-intensive при масштабировании. K8s resource quotas + queue-based scheduling.
- **Sliver C2 gating** — Decepticon использует Sliver по умолчанию. Для authorized pentest без post-exploit C2 — нужно ли патчить или конфигурировать?
- **Decepticon + Neo4j** — managed Neo4j на Yandex Cloud или self-hosted в K8s? Если self-hosted — overhead на maintenance.

### CyberStrikeAI-related
- **Reputational risk mitigation** — CyberStrikeAI публично связан с атаками. В продукте используем только YAMLs + docs, но supply chain audit trail важен для enterprise клиентов.
- **Custom MCP config** — существует ли способ запустить cyberstrike-runner с произвольным allow-list, или нужен fork.
- **Tool YAML schema stability** — pinning + own integration tests на каждый curated YAML.
- **Skill library translation** — методички на китайском/английском. Перевод на русский — manual или machine?

### K2.6 swarm-related
- **Reliability на длинных swarm sessions** — kill-switch'ы обязательны. Empirical testing на лабораторных таргетах перед prod.
- **Tool description tuning** — K2.6 хорошо использует tools только при структурированных описаниях. Decepticon уже имеет tuned prompts — нужно ли адаптировать под K2.6?
- **Self-host решение** — переключение с api.moonshot.ai на Yandex GPU по compliance причинам.
- **Vendor lock mitigation** — LiteLLM proxy = model-agnostic. Переключение модели = конфиг, не код.

### Compliance / general
- **RU sanctions exposure** — Apache-2.0 / Modified MIT не блокируются. Yandex Container Registry mirror решает.
- **Self-host K2.6 на Yandex GPU** — 8x H100 кластер ~$15-25K/мес. Включается когда ARR оправдывает.
- **Audit log retention** — 90 дней hot (Object Storage), 1 год cold, потом truncate.
