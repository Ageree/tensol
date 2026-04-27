# AI Pentest Platform Stack — Hybrid with CyberStrikeAI Tool Catalog

> Альтернативная версия `STACK.md`, переработанная под cherry-pick из CyberStrikeAI без потери browser-first / validator-driven продуктовой ставки. Оригинал не заменяет — это вариант для оценки.

## Цель

Построить XBOW-like платформу для автономного pentest / authorized adversary-emulation продукта под РФ рынок, использующую **проверенный open-source tool catalog** (CyberStrikeAI) как fast-track для tool breadth, без принятия offensive C2 / persistence частей.

Ключевые принципы:

- один облачный провайдер: `Yandex Cloud`
- один продуктовый язык: `TypeScript + Bun` (CyberStrike Go-binary ≈ tool runner sidecar, не часть продукта)
- **`Kimi K2.6` как primary orchestrator** — встроенный agent swarm до 300 sub-агентов и 4000 шагов означает что reasoning-loop / координация / parallel decomposition **встроены в модель**, не пишутся как отдельный сервис
- **open-weights = self-hostable на Yandex Cloud GPU** — критично для RU-комплаенса (данные клиента не уходят в чужой облачный API)
- browser-first как primary signal source
- findings только после deterministic validation (валидаторы — наш код, не делегируется LLM)
- tool execution делегируется в `cyberstrike-runner` сайдкар, использующий **только curated subset** из 90 tool YAML
- skill methodology library заимствуется из CyberStrike `skills/*.md` (без C2 / phishing категорий)
- продукт позиционируется как `authorized pentest platform`, не offensive tooling company

## Что мы берём из CyberStrikeAI и что — нет

### ✅ Берём (curated subset)

**Tool YAMLs (~55 из 90):**

- Recon: `nmap`, `masscan`, `rustscan`, `amass`, `subfinder`, `dnsenum`, `fierce`, `feroxbuster`, `gobuster`, `ffuf`, `dirsearch`, `katana`, `paramspider`, `gau`, `waybackurls`, `wafw00f`
- Web: `nuclei`, `sqlmap`, `zap`, `wpscan`, `dalfox`, `jaeles`, `nikto`, `x8`, `xsser`
- API: `jwt-analyzer`, `api-schema-analyzer`, `graphql-scanner`, `arjun`
- Cloud: `pacu`, `prowler`, `scout-suite`, `kube-hunter`, `kube-bench`, `trivy`, `terrascan`, `checkov`, `cloudmapper`, `falco`, `clair`
- OSINT (опц., gated): `shodan_search`, `quake_search`
- AD-recon (read-only): `enum4linux-ng`, `nbtscan`, `arp-scan`, `rpcclient` — **только без эксплуатации**

**Skill methodology docs (~18 из 23):**

`api-security-testing` / `business-logic-testing` / `cloud-security-audit` / `command-injection-testing` / `container-security-testing` / `csrf-testing` / `deserialization-testing` / `file-upload-testing` / `idor-testing` / `ldap-injection-testing` / `secure-code-review` / `sql-injection-testing` / `ssrf-testing` / `vulnerability-assessment` / `xpath-injection-testing` / `xss-testing` / `xxe-testing` / `mobile-app-security-testing`

### ❌ НЕ берём (positioning conflict)

- `mcp-servers/reverse_shell` — C2 / persistence
- `webshell_*` tools (file ops, exec, manage) — webshell C2
- `batch_task_*` MCP server — offensive operation scheduler
- `metasploit`, `msfvenom`, `responder`, `impacket`, `bloodhound`, `netexec`, `smbmap`, `hydra`, `hashcat`, `john`, `hashpump` — offensive / cred attack без явного клиентского scope
- `linpeas`, `pwntools`, `ropgadget`, `ropper`, `one-gadget`, `libc-database`, `pwninit`, `angr`, `gdb`, `ghidra`, `radare2` — binary RE / post-exploitation
- `volatility3`, `binwalk`, `foremost`, `exiftool`, `steghide`, `zsteg` — forensics (другой продукт)
- `incident-response` skill — другой продукт
- `security-awareness-training` — другой продукт
- `cyberstrike-eino-demo` skill — vendor-specific demo
- Default Aliyun / Qwen / FOFA конфиг — заменяется RU-friendly LLM gateway

### 🔧 Заменяем

- LLM provider: с Aliyun Qwen → **Kimi K2.6 (primary)** + Claude Opus 4.x (fallback / verifier role)
- LLM hosting: international API endpoints (`api.moonshot.ai`) на этапе MVP → self-hosted K2.6 на Yandex Cloud GPU когда ARR покроет инфру
- Storage: с CyberStrike SQLite → Yandex Managed PostgreSQL (через `api`)
- UI: с CyberStrike web frontend → собственный React SPA
- Knowledge base: с CyberStrike Chinese-default content → переведённые / адаптированные skill MD

## Orchestrator: Kimi K2.6 Agent Swarm

K2.6 — это **не просто LLM, а tool-use-обученный orchestrator с встроенным agent swarm**. Это меняет архитектуру harness'а: вместо того чтобы писать координатор-сервис вручную, мы делегируем декомпозицию задач самой модели.

### Что K2.6 даёт из коробки

- **До 300 параллельных sub-агентов** на одну запущенную сессию
- **До 4000 координированных шагов** между sub-агентами
- **256K context на каждого** sub-агента (отдельная conversation thread)
- **PARL training** — Parallel-Agent Reinforcement Learning, специально для multi-agent decomposition
- **Native tool-use**: модель сама решает когда вызвать tool, какой, как обработать результат
- **HLE-Full 54.0 / SWE-Bench Verified 80.2% / Terminal-Bench 2.0 66.7%** — топовые agentic benchmarks

### Что мы НЕ пишем благодаря K2.6

- ❌ Coordinator-loop (ReAct / agentic decomposition) — встроено в модель
- ❌ Sub-agent dispatching — встроено
- ❌ Memory between parallel agents — внутри 256K context per agent + общая mission state
- ❌ Reasoning + tool-call interleaving — обучено end-to-end через PARL
- ❌ Custom orchestrator prompts на каждый класс задачи — K2.6 декомпозит сама

### Что мы по-прежнему пишем сами

- ✅ **Tool palette** (HTTP executor, Playwright browser-worker, cyberstrike-runner client, Interactsh client) — это API-обвязка, не reasoning
- ✅ **Mission state persistence** между сессиями (4000 шагов в одной сессии — много, но между ассессментами нужна БД)
- ✅ **Deterministic validators** (xss / ssrf / file-read / rce) — финальный gate, не доверяется LLM
- ✅ **Scope enforcement** — hard-coded check на каждый tool call (LLM не решает что в scope)
- ✅ **Cost / budget caps** — swarm может выжечь много токенов; budget tracking на нашей стороне
- ✅ **Quality gates** — dedup, severity calibration, evidence packaging

### Swarm reliability (not budget)

Бюджетных caps **намеренно нет** — приоритет соло-фаундера: **запуск, не экономия токенов**. Money is not the bottleneck.

Но **reliability kill-switch** остаётся, потому что застрявший swarm в loop'е портит UX независимо от стоимости:

```typescript
interface SwarmReliabilityGuard {
  max_wall_clock_seconds: number;   // hard timeout — сессия не идёт дольше этого, default 30 минут
  max_total_steps: number;          // защита от infinite loop, default 4000 (full K2.6 cap)
  per_subagent_step_cap: number;    // если один sub-agent застрял на >100 шагов — выгрузить
  divergence_detector: boolean;      // если последние 50 шагов не дали новых evidence — kill
}
```

**Sub-agent count и token spend не лимитируются.** K2.6 сама решает сколько агентов поднять. Если оптимально 300 — пусть будет 300. Если 50 — пусть 50.

**Default values** для MVP — щедрые (30 минут wall-clock, full step cap). Никаких dollar caps вообще. Cost tracking ведётся только для аналитики (post-hoc audit), не для blocking.

### LLM provider strategy

| Этап | Provider | Почему |
|---|---|---|
| **Phase 1-3 (MVP build)** | `api.moonshot.ai` international endpoint | Нет инфраструктурных задач, фокус на продукте |
| **Phase 4-5 (first paying clients)** | Тот же + own LLM gateway slim layer (audit log, model routing) | Нужен control plane для observability — НЕ для cost throttling |
| **Phase 6+ (enterprise scale)** | Self-host K2.6 на Yandex Cloud GPU когда требует data-residency SLA | Compliance / latency драйвер, не unit economics |
| **Verifier role / fallback** | Claude Opus 4.x через Anthropic API | Independent second opinion для critical findings; диверсификация vendor risk |

### Compliance hygiene

- **Open-weights** значит мы **не зависим от китайского API** в продакшене (на этапе scale всё работает на Yandex GPU)
- На этапе MVP K2.6 international endpoint **не отправляет данные в PRC** (Moonshot имеет US/EU инстансы)
- **Никакого dashscope.aliyuncs.com** в наших HTTP-флагах
- **Audit log** каждого K2.6 запроса: prompt + response + tool calls сохраняются в Object Storage для post-incident review

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

### LLM orchestration

- **`Kimi K2.6`** (Moonshot, open-weights, Modified MIT) — primary orchestrator with native 300-agent swarm
- `Claude Opus 4.x` (Anthropic) — verifier role / second opinion / fallback при K2.6 ошибках
- Own gateway slim layer: rate limit / budget tracking / audit log / model routing

### Tool execution layer

- `cyberstrike-runner` (Go binary, sidecar) — curated subset из CyberStrike с custom MCP config, который экспортит ТОЛЬКО разрешённые tool YAMLs (см. список выше)
- Запускается в private K8s namespace, доступен через MCP HTTP к http-worker'ам
- Apache-2.0 license OK; supply chain audit: pinned upstream commit, mirror в Yandex Container Registry

### Infra

- `Yandex Managed PostgreSQL`
- `Yandex Message Queue`
- `Yandex Object Storage`
- `Yandex Container Registry`
- `Yandex Managed Kubernetes`
- `Yandex Application Load Balancer`

### Security / Testing Tools

- `Playwright` for browser automation and validation (primary signal source)
- `Nuclei` (через cyberstrike-runner) as signal source for known issues
- `Interactsh` (self-hosted) as OOB proof service
- `Burp Suite` или `Caido` as analyst desk for manual triage
- CyberStrike curated tools (см. список) через MCP — secondary signal source

### Observability

- `Sentry`
- `OpenTelemetry`

## Сервисы v1

### 1. web

React SPA для console UI.

### 2. api

`Hono + Bun` API для:

- auth
- projects / targets
- assessments
- findings
- evidence
- artifacts
- scope rules
- skill library (CyberStrike methodology docs, queryable)

### 3. coordinator

**Тонкий сервис.** Большая часть оркестрации делегирована K2.6 swarm — coordinator управляет жизненным циклом ассессмента и enforcement политик, а не reasoning-loop'ом.

Отвечает за:

- создание assessment session: формирование initial K2.6 prompt с target / scope / available tools / skill hints
- запуск **одной K2.6 swarm session** на ассессмент (модель сама декомпозит на нужное число sub-агентов)
- reliability kill-switch (wall-clock timeout / step cap / divergence detector — НЕ budget cap)
- scope enforcement на каждый tool call (validator pass-through, hard-coded allow-list)
- mission state persistence (assessment crash → resume from last checkpoint)
- маршрутизация tool calls: HTTP probes → http-worker; recon → cyberstrike-worker; browser → browser-worker
- запуск validator jobs на candidate findings которые K2.6 промаркирует как requires-validation
- сбор final findings от validators → запись в БД
- post-hoc cost analytics (audit only, не blocking) — сколько токенов потратил каждый ассессмент, для будущего unit economics review

### 4. http-worker

Отвечает за:

- HTTP probing
- API exploration
- OpenAPI ingestion
- SSRF / file-read / RCE prechecks
- OOB checks через Interactsh

### 5. cyberstrike-worker

Новый worker class. Отвечает за:

- вызов curated tool YAMLs через `cyberstrike-runner` MCP (nmap / nuclei / sqlmap / ffuf / dalfox / katana / wafw00f / wpscan / etc.)
- нормализация tool output в общий `observation` schema
- enforcement allow-list scope (target host whitelist на уровне worker)
- timeout / RPS / politeness throttle на каждый tool call
- НЕ вызывает offensive / C2 / persistence tools (зашит allow-list YAML names)

### 6. browser-worker

Отвечает за:

- login flows
- authenticated crawling
- JS-heavy navigation
- DOM inspection
- XSS verification
- screenshots / traces / HAR

### 7. validator-worker

Отвечает за deterministic validation:

- `xss-validator`
- `ssrf-validator`
- `file-read-validator`
- `rce-validator`

Принимает candidate findings от http-worker / cyberstrike-worker / browser-worker. Финальная находка публикуется только после re-play через детерминистичный validator.

### 8. oob

Self-hosted `interactsh` для callback-based proof.

## Очереди

- `assessment.start`
- `recon.http`
- `recon.browser`
- `recon.cyberstrike` (новая)
- `attack.http`
- `attack.browser`
- `attack.cyberstrike` (новая, only allow-listed tools)
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
- `jobs`
- `findings`
- `finding_evidence`
- `observations_http`
- `observations_browser`
- `observations_cyberstrike` (новая — нормализованный output curated tool calls)
- `oob_events`
- `skill_library` (CyberStrike methodology docs, indexed for agent retrieval)
- `tool_allowlist` (config — какие YAML tools разрешены этой инсталляции)

## Worker Model

Принцип:

- coordinator выбирает worker type и цель
- worker получает широкую свободу внутри своего класса
- сеть, scope и ресурсы ограничиваются политикой
- finding публикуется только после validator
- cyberstrike-runner — изолированный сайдкар, единственный путь к CyberStrike tool layer

### Browser worker

Разрешено:

- `Playwright`
- чтение DOM, JS, cookies, storage
- HTTP(S) только по scope и allow-visit доменам
- trace / screenshot / HAR

### HTTP worker

Разрешено:

- custom HTTP actions
- `Nuclei` (либо встроенный, либо через cyberstrike-runner — единый вариант)
- OOB payloads в рамках scope
- helper scripts
- request replay

### CyberStrike worker

Разрешено:

- вызов tool YAML из allow-list через cyberstrike-runner MCP
- stdout / stderr / parsed output → нормализация в `observation_cyberstrike`
- scope enforcement: target host обязан быть в `assessment_scope_rules`

Запрещено:

- любой YAML за пределами allow-list (hard-coded check на уровне worker)
- запуск reverse-shell / webshell / metasploit / impacket / bloodhound / responder
- любой tool YAML с `requires_foothold: true` без явного `assessment.has_foothold = true` flag
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
- skill library lookup (методички из CyberStrike по категории текущей задачи)

## Инструменты агентов

Агенты должны использовать не "все подряд", а стабильный tool catalog:

**Core (всегда доступны):**

- browser actions (Playwright)
- HTTP executor
- OpenAPI parser
- artifact parser
- validator replay
- skill library query

**Curated CyberStrike subset (через cyberstrike-worker):**

- recon: nmap / amass / subfinder / nuclei / katana / ffuf / gobuster / dirsearch
- web: sqlmap / dalfox / wpscan / nikto / wafw00f
- api: jwt-analyzer / api-schema-analyzer / graphql-scanner
- cloud (если scope cloud): trivy / kube-bench / scout-suite / prowler

**OOB:**

- Interactsh

Инструменты вида `Sliver`, `Havoc`, `Evilginx`, `metasploit`, `mimikatz`, любые post-exploit C2 / persistence — **не входят в core stack**.

## Compliance / Supply Chain

### China supply chain (CyberStrikeAI specific)

CyberStrikeAI — Chinese single-author проект (Ed1s0nZ, Apache-2.0). Принимаем меры:

- **Pinned upstream commit** в Yandex Container Registry (mirror), не latest
- **Custom MCP config** заменяет default `pent_claude_agent` (с C2) на curated allow-list
- **LLM provider switch**: Aliyun / Qwen → собственный gateway (GLM 5.1 / Kimi K2.6 international endpoints)
- **FOFA disabled by default** — gated behind explicit per-project consent
- **No outbound** к dashscope.aliyuncs.com / api.fofa.so из cyberstrike-runner namespace (egress firewall в K8s)
- **Quarterly upstream review**: changelog audit перед bump'ом pinned commit

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
- `http-worker`
- `cyberstrike-worker` ← новый
- `cyberstrike-runner` ← новый sidecar в worker pod
- `browser-worker`
- `validator-worker`
- `oob`

### Managed Services

- `Managed PostgreSQL`
- `Message Queue`
- `Object Storage`
- `Container Registry` (с mirror'ом cyberstrike-runner image)

## Product Boundary

Платформа строится как:

- `authorized pentest platform`
- `exploit-validated security testing`
- `adversary emulation for owned and authorized environments`

Платформа не позиционируется как:

- malware tooling
- phishing platform
- offensive tooling company
- stealth / persistence platform
- C2 / red-team-as-a-service platform (без явного enterprise scope с foothold-внутри-сети)

## Порядок разработки

### Phase 1 — Foundation

- `api`
- DB schema (включая `tool_allowlist`, `skill_library`)
- auth
- projects / targets / assessments CRUD
- import + index CyberStrike `skills/*.md` в `skill_library`

### Phase 2 — K2.6 swarm integration + thin coordinator

- intégration с `api.moonshot.ai` (auth, retry policy — без rate limit)
- Tool catalog как K2.6 function definitions (HTTP / browser / cyberstrike-runner / Interactsh)
- Reliability kill-switch (wall-clock timeout / step cap / divergence detector — без budget cap)
- thin `coordinator` service (assessment lifecycle, job routing, state persistence)
- queues
- audit log of every K2.6 request → Object Storage (для post-hoc cost analytics)

### Phase 3 — Browser-first signal

- `browser-worker`
- login flows
- trace / screenshot capture

### Phase 4 — HTTP signal

- `http-worker`
- OpenAPI ingestion
- baseline Nuclei adapter

### Phase 5 — CyberStrike adoption

- `cyberstrike-runner` Docker build (pinned commit, custom MCP config с allow-list)
- `cyberstrike-worker` (Bun) с MCP client
- import + integration ~55 curated tool YAMLs
- enforcement: outbound firewall, scope check, no-egress-PRC verification
- A/B сравнение Nuclei (через cyberstrike) vs наш baseline на тестовых таргетах

### Phase 6 — Validation

- `oob`
- `Interactsh` integration
- validator flows (xss / ssrf / file-read / rce)
- candidate finding → validator → published finding pipeline

### Phase 7 — Reporting

- evidence model
- findings UX
- PDF report generation (RU + GOST R templates)

## Main Bet

Наша ставка не на "ещё один сканер", а на связку:

- coordinator
- short-lived workers
- **browser-first testing** (primary signal)
- **OOB proof**
- **deterministic validators** (final gate)
- evidence-first findings
- **proven open-source tool breadth** (CyberStrike curated subset, без offensive C2)
- **methodology library** (CyberStrike skills, переиндексированные для русскоязычного агента)
- supply-chain hygiene (pinned mirror, no PRC-egress, replaceable LLM provider)

Это и есть ближайший практичный путь к XBOW-like продукту для solo founder, с **fast-track тулсета через CyberStrike и без потери RU-комплаенса / browser-first / validator-driven позиционирования**.

## Что осталось решить (open questions)

### CyberStrike-related
- **CyberStrike upstream maintenance signals** — частота коммитов, contributor count, response time на issues. До Phase 5 — обязательный аудит.
- **Custom MCP config** — exists ли уже способ запустить cyberstrike-runner с произвольным allow-list, или нужен fork. Если fork — публиковать его как Sentinel-fork (Apache-2.0 совместимо).
- **Tool YAML schema stability** — будут ли upstream breaking changes между версиями. Pinning + own integration tests на каждый curated YAML.
- **Skill library translation** — методички CyberStrike на китайском/английском. Перевод на русский — manual или machine? Влияет на UX качества.

### K2.6 swarm-related
- **Reliability на длинных swarm sessions** — Moonshot сами признают «agents for days... exposes the limits of enterprise orchestration». Дисциплинированные kill-switch'ы (wall-clock / steps / divergence) обязательны. Empirical testing на лабораторных таргетах перед prod.
- **Tool description tuning** — K2.6 хорошо использует tools только если их описания структурированы. Каждый tool — это итерации (как XBOW делал с Anthropic). Plan: tool descriptions versioned, A/B тесты на лабе.
- **Self-host решение** — переключение с api.moonshot.ai на Yandex GPU self-host **по причинам compliance** (RU клиенты требуют data-residency) или **скорости** (latency self-host ниже), не по cost-economics. Когда первые enterprise клиенты захотят SLA с data-residency — тогда self-host.
- **Vendor lock mitigation** — design tools / validators / mission state model-agnostic. Если Moonshot меняет API breaking — переключиться на Claude Opus или GPT-5.4 за неделю, а не за месяц.
- **Post-hoc cost analytics** — audit log токенов на ассессмент сохраняется не для blocking, а для понимания «сколько реально стоит каждый прогон» — данные для будущего pricing decisions, не для runtime ограничений.

### Compliance / general
- **RU sanctions exposure** — Apache-2.0 / Modified MIT не блокируются, но import GitHub из РФ может потребовать прокси. Yandex Container Registry mirror решает.
- **Self-host K2.6 на Yandex GPU** — Yandex Cloud имеет H100 / A100 в обойме, но 8x H100 кластер — ~$15-25K/мес. Включается в roadmap когда ARR оправдывает.
- **Audit log retention** — каждый K2.6 запрос с tool calls = много данных. Retention policy: 90 дней hot (Object Storage), 1 год cold (Glacier-style), потом truncate.
