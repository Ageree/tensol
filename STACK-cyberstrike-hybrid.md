# AI Pentest Platform Stack — Decepticon Core + CyberStrikeAI Tooling + Hybrid LLM

> Активная версия стека. Decepticon = автономное ядро (16 агентов, kill chain, изоляция). CyberStrikeAI = curated tool catalog + UI patterns + MCP. Hybrid LLM mix через Decepticon LiteLLM: Opus 4.7 reasoning + DeepSeek V4 cost + K2.6 verifier diversity.

## Цель

Построить XBOW-like платформу для автономного pentest / authorized adversary-emulation продукта под РФ рынок, где:

- **Decepticon** (PurpleAILAB, Apache-2.0) — autonomous Red Team agent, ядро платформы. 16 специализированных агентов, полная kill chain, профессиональная дисциплина (OPPLAN / RoE / ConOps), изолированная инфраструктура (dual Docker network), Offensive Vaccine loop.
- **CyberStrikeAI** (Ed1s0nZ, Apache-2.0) — supplementary tool breadth (100+ YAML-рецептов), MCP-интеграция, Web UI patterns, role-based testing, skill methodology library. Используется cherry-pick curated tool catalog; high-impact tools доступны после регистрации, авторизации, подтверждения владения target и запуска assessment в рамках scope.
- **Hybrid LLM mix через Decepticon LiteLLM proxy** — каждая роль агента получает оптимальную модель: Claude Opus 4.7 для reasoning-heavy ролей (1M ctx, SWE-Pro 64.3%, MCP-Atlas 77.3%), DeepSeek V4-Pro/Flash для cost-heavy ролей (1M ctx, 10x дешевле, open-weights MIT), Kimi K2.6 для verifier (vendor diversity, open-weights backup). K2.6 native swarm избыточен внутри Decepticon's 16 агентов — модель используется как обычный single-agent LLM.

Ключевые принципы:

- один облачный провайдер: `Yandex Cloud`
- один продуктовый язык: `TypeScript + Bun` (Decepticon Python — внутри sandbox, не часть продукта; CyberStrikeAI Go-binary — tool runner sidecar)
- **Hybrid LLM mix** через Decepticon's LiteLLM proxy — model-per-role, не one-size-fits-all
- **open-weights backup для compliance** — DeepSeek V4 (MIT) + K2.6 (Modified MIT) self-hostable на Yandex Cloud GPU; Opus 4.7 — international API только до enterprise data-residency phase
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

**Модели через LiteLLM (hybrid per-agent mapping):**

| Decepticon agent role | Primary model | Why |
|---|---|---|
| Decepticon (main orchestrator) | **Opus 4.7** | 1M ctx для OPPLAN+RoE+ConOps, MCP-Atlas 77.3%, deep reasoning |
| Soundwave (planning) | **Opus 4.7** | планирование = глубокий reasoning |
| Recon | **DeepSeek V4-Flash** | частые вызовы, 1M ctx, cost-efficient, open-weights |
| Scanner | **DeepSeek V4-Pro** | tool-use heavy, cost matters |
| Exploit | **Opus 4.7** | SWE-Verified 87.6% — best at exploit code |
| Exploiter | **Opus 4.7** | multi-step chains require deep reasoning |
| Detector | **DeepSeek V4-Pro** | output analysis, cost-efficient |
| Verifier | **Kimi K2.6** | **vendor diversity** от Opus orchestrator, agentic-trained, open-weights |
| Patcher | **DeepSeek V4-Pro** | code generation, cost |
| Post-Exploit | **Opus 4.7** | сложный reasoning, доступен после ownership verification + scope approval |
| Defender (Offensive Vaccine) | **DeepSeek V4-Pro** | analysis, cost |
| AD Operator | **Opus 4.7** | Terminal-Bench 69.4%, доступен после ownership verification + scope approval |
| Cloud Hunter | **DeepSeek V4-Pro** | cost, decent security analysis |
| Contract Auditor | **Opus 4.7** | SWE-Pro 64.3% + GPQA 94.2% |
| Reverser | **Opus 4.7** | deep reasoning, complex code analysis |
| Analyst | **Opus 4.7** | Finance Agent SOTA, HLE leader |

**Profiles:**
- Profile `production`: hybrid mix as above (10 ролей Opus + 6 DeepSeek + 1 K2.6)
- Profile `cost`: все cost-tier ролей на DeepSeek V4-Flash, Opus только для orchestrator + verifier
- Profile `max`: все ролей на Opus 4.7 — для high-value clients где budget не релевантен
- Profile `test`: все на DeepSeek V4-Flash — для development / CI прогонов

**Fallback chain** (если primary unavailable): Opus 4.7 → K2.6 → DeepSeek V4-Pro

**Что адаптируем:**
- LLM provider: с Decepticon Claude-only default → hybrid mix через LiteLLM (Decepticon proxy поддерживает любые OpenAI-совместимые providers)
- Web dashboard: с Decepticon built-in → наш собственный React SPA (Decepticon dashboard как reference)
- Storage: с Decepticon SQLite/Neo4j → Yandex Managed PostgreSQL + Neo4j (managed или self-hosted в K8s)
- Infra: с local Docker Compose → Yandex Managed Kubernetes

### Anthropic-Cybersecurity-Skills — knowledge base (берём, primary skill library)

**Repo:** https://github.com/mukul975/Anthropic-Cybersecurity-Skills (Apache-2.0, mukul975, community-driven, **NOT affiliated with Anthropic PBC**)

**Что приносит:**

- **754 production-grade skills** в **26 security domains** (vs 23 у CyberStrikeAI)
- **Format = agentskills.io standard** (YAML frontmatter + structured markdown body) — native для Claude Opus 4.7 / K2.6 / DeepSeek tool-use
- **5 framework mappings на каждой skill:** MITRE ATT&CK v18, NIST CSF 2.0, MITRE ATLAS v5.4, MITRE D3FEND v1.3, NIST AI RMF 1.0
- **Полное покрытие 14/14 ATT&CK tactics** (Reconnaissance → Impact)
- **Top categories:** Cloud Security (60), Threat Hunting (55), Threat Intelligence (50), WebApp Security (42)
- **Progressive disclosure** — frontmatter ~30 токенов для filtering, full skill 500-2000 токенов когда нужен deep workflow
- **Active maintenance** — v1.2.0 (April 6, 2026), 152 commits, 48-hour PR review SLA
- **Apache 2.0** license

**Skill structure (agentskills.io standard):**

```
skill-name/
├── SKILL.md               # YAML frontmatter + workflow body
├── references/
│   ├── standards.md       # framework mappings details
│   └── workflows.md       # technical procedures
├── scripts/               # helper automation
└── assets/                # templates, checklists
```

**Frontmatter fields:** `name`, `description` (keyword-rich), `domain`, `subdomain`, `tags`, `atlas_techniques`, `d3fend_techniques`, `nist_ai_rmf`, `nist_csf`

**Markdown body sections:** When-to-Use → Prerequisites → Workflow (step-by-step с конкретными командами) → Verification (success confirmation methods)

**Real example:** `performing-memory-forensics-with-volatility3` → maps to ATT&CK T1003, NIST CSF DE.CM-01, ATLAS AML.T0047, D3FEND D3-MA — automatic compliance reporting.

**Что мы берём:**

- ~50-100 audited skills (не все 754) — cherry-pick по релевантности для web pentest + cloud + AD + threat hunting workflows
- Index в `skill_library` table с frontmatter metadata для fast retrieval
- Framework mappings в `findings.framework_refs` для auto-generated compliance reports

**Что НЕ берём:**

- Все 754 без quality audit — слишком много untested
- Skills вне текущего product scope (threat awareness training, incident response procedures) — откладываем до relevant phase

**Caveat — supply chain:**

- Single-author репо (mukul975), 5.8K stars, community-driven но не корпоративный
- License Apache-2.0 OK, но pinned commit + own mirror в Yandex Container Registry обязательно
- "Anthropic" в имени misleading — в нашем product / marketing brand этого проекта **не упоминаем** (избегаем confusion с Anthropic PBC)
- Quality audit subset перед import — обязательный Phase 1 deliverable

### CyberStrikeAI — supplementary (берём выборочно)

**Tool YAMLs (~55 из 100+):**

- Recon: `nmap`, `masscan`, `rustscan`, `amass`, `subfinder`, `dnsenum`, `fierce`, `feroxbuster`, `gobuster`, `ffuf`, `dirsearch`, `katana`, `paramspider`, `gau`, `waybackurls`, `wafw00f`
- Web: `nuclei`, `sqlmap`, `zap`, `wpscan`, `dalfox`, `jaeles`, `nikto`, `x8`, `xsser`
- API: `jwt-analyzer`, `api-schema-analyzer`, `graphql-scanner`, `arjun`
- Cloud: `pacu`, `prowler`, `scout-suite`, `kube-hunter`, `kube-bench`, `trivy`, `terrascan`, `checkov`, `cloudmapper`, `falco`, `clair`
- OSINT: `shodan_search`, `quake_search` (если пользователь подключил authorized credentials)
- AD-recon (read-only): `enum4linux-ng`, `nbtscan`, `arp-scan`, `rpcclient`

**Skill methodology docs — НЕ берём.** CyberStrike skills (23 freeform markdown на китайском/английском) **заменены** на Anthropic-Cybersecurity-Skills (754 skills в agentskills.io стандарте) — см. секцию ниже. Один skill library проще двух, и Anthropic-format native для LLM consumption.

**UI patterns (reference, не fork):**
- Attack-chain graph visualization + risk scoring + step-by-step replay
- Vulnerability management CRUD + severity tracking + status workflow
- Role-based testing dropdown (12+ predefined security roles)
- HITL (Human-in-the-Loop) sidebar — approval mode + verified tool catalog
- WebShell management patterns для ownership-verified post-exploit workflows

**MCP integration:**
- HTTP / stdio / SSE transports
- External MCP federation pattern
- Burp Suite plugin reference

### ✅ High-impact tools — берём, но только после ownership verification

Все инструменты каталога доступны пользователю, если выполнены условия: регистрация, авторизация, подтверждение владения / authorization на target, активный assessment, target внутри scope, audit log на каждое действие.

**Из CyberStrikeAI / supplementary catalog берём также:**
- `mcp-servers/reverse_shell` — только для verified owned targets внутри active assessment scope
- `webshell_*` tools — только для verified owned targets внутри active assessment scope
- `metasploit`, `msfvenom`, `responder`, `impacket`, `bloodhound`, `netexec`, `smbmap`, `hydra`, `hashcat`, `john` — доступны для authorized AD / credential audit / exploitation workflows в рамках подтвержденного scope
- `linpeas`, `pwntools`, `ropgadget`, `ropper`, `gdb`, `ghidra`, `radare2` — доступны для post-exploitation / binary RE workflows в рамках подтвержденного scope
- `volatility3`, `binwalk`, `foremost`, `exiftool`, `steghide` — доступны для forensic / artifact analysis workflows
- Aliyun / Qwen / FOFA configs — доступны только если пользователь или оператор явно подключил credentials и regional/data-transfer policy это разрешает

**Из Decepticon:**
- Sliver C2 доступен как часть verified tool catalog, но каждый запуск должен быть привязан к authenticated user, verified target ownership, active assessment scope и audit log.
- Public demo с Metasploitable 2 — internal lab only, не в продукте.

### 🔧 Заменяем

- LLM provider: с Decepticon Claude-only default → **hybrid mix** через LiteLLM proxy (Opus 4.7 reasoning + DeepSeek V4 cost + K2.6 verifier)
- LLM hosting: international API endpoints (`api.anthropic.com`, `api.deepseek.com`, `api.moonshot.ai`) → self-hosted DeepSeek V4 + K2.6 на Yandex Cloud GPU когда требует enterprise data-residency SLA (Opus 4.7 closed-weights — international API only, либо Anthropic on-prem deal для enterprise)
- Storage: с Decepticon SQLite + Neo4j → Yandex Managed PostgreSQL + Neo4j
- UI: с Decepticon built-in dashboard → собственный React SPA (Decepticon + CyberStrikeAI dashboards как reference)
- Knowledge base: с CyberStrike Chinese-default content → переведённые / адаптированные skill MD + Decepticon Neo4j attack graphs

## LLM strategy: hybrid mix через Decepticon LiteLLM

Decepticon's LiteLLM proxy = vendor-agnostic routing per agent role. Используем это как стратегическое преимущество — каждая роль получает оптимальную модель по reasoning quality / cost / compliance trade-offs.

### Доступные модели (April 2026 frontier)

| Модель | Релиз | Context | Цена $/M (in/out) | Open-weights | Highlights |
|---|---|---|---|---|---|
| **Claude Opus 4.7** | 16 апр 2026 | 1M / 128K out | $5 / $25 | ❌ Anthropic | SWE-Verified **87.6%**, SWE-Pro **64.3%**, MCP-Atlas **77.3%**, GPQA 94.2% |
| **DeepSeek V4-Pro** | 24 апр 2026 | 1M / 384K out | **$1.74 / $3.48** (10x cheaper) | ✅ MIT | 1.6T MoE / 49B active, sparse attention (27% FLOPs vs V3.2 @1M) |
| **DeepSeek V4-Flash** | 24 апр 2026 | 1M / 384K out | даже дешевле | ✅ MIT | 284B / 13B active — fast/cost roles |
| **Kimi K2.6** | начало 2026 | 256K (× 300 swarm) | средняя | ✅ Modified MIT | HLE-Full **54.0** (best agentic с tools), PARL-trained |

**Почему GPT-5.5 не в стеке**: $30/M output (дороже Opus при $25), US-vendor closed-weights (та же compliance проблема что Opus), Terminal-Bench 82.7% king только на coding-agent benchmark, нет уникального преимущества для pentest workload.

### Per-agent role mapping (production profile)

См. секцию «Decepticon — ядро» выше — там полная таблица 16 ролей. TL;DR:

- **Reasoning-heavy ролей (~10): Opus 4.7** — orchestrator / soundwave / exploit / exploiter / post-exploit / ad-operator / contract-auditor / reverser / analyst
- **Cost-heavy ролей (~6): DeepSeek V4-Pro/Flash** — recon / scanner / detector / patcher / defender / cloud-hunter
- **Verifier role (1): K2.6** — vendor diversity для independent second opinion

### Почему этот mix

**Opus 4.7 для orchestrator + reasoning roles**:
- 1M context идеально для OPPLAN + ConOps + RoE + полная mission state
- MCP-Atlas 77.3% — лучший на tool-use в pentest-подобной workload
- SWE-Verified 87.6% — критично для exploit / contract-auditor агентов

**DeepSeek V4 для cost roles**:
- 10x дешевле Opus → recon / scanner делают 100s вызовов на ассессмент, разница огромная
- 1M context с sparse attention → можно держать длинный scan output без compression
- Open-weights MIT → self-hostable на Yandex GPU когда compliance потребует

**K2.6 для verifier**:
- **Vendor diversity** — verifier independent от orchestrator (Anthropic vs Moonshot — разные тренировочные данные, разные failure modes)
- Open-weights backup — защита если Opus станет недоступен
- HLE-Full 54.0 — agentic-trained, хорошо на adversarial reasoning

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
- ✅ **Scope enforcement** — hard-coded check на каждый tool call (Decepticon sandbox + verified target/scope policy)
- ✅ **CyberStrike tool bridge** — curated YAMLs как supplementary tools для Decepticon агентов
- ✅ **Reliability guards** — Decepticon agent monitoring, kill-switch при divergence
- ✅ **Per-agent A/B testing harness** — для tuning model-to-role mapping на лабораторных таргетах
- ✅ **React SPA** — product UI (findings, reports, dashboard)
- ✅ **Reporting** — PDF report generation (RU + GOST R templates)
- ✅ **Auth / multi-tenancy** — Decepticon single-user, наш продукт — multi-tenant SaaS

### Reliability guards (не budget caps)

Decepticon имеет собственные guards (fresh context per agent objective, Kali sandbox isolation). Добавляем наши:

```typescript
interface ReliabilityGuard {
  max_wall_clock_seconds: number;   // hard timeout, default 30 мин
  max_total_steps: number;          // защита от infinite loop, default 4000
  per_agent_step_cap: number;       // один agent застрял >100 шагов — выгрузить
  divergence_detector: boolean;      // последние 50 шагов без нового evidence — kill
}
```

**Budget caps намеренно нет** — приоритет: запуск, не экономия токенов. Cost tracking только для post-hoc analytics.

### LLM provider strategy (по фазам)

| Этап | Provider mix | Почему |
|---|---|---|
| **Phase 1-3 (MVP build)** | `api.anthropic.com` (Opus) + `api.deepseek.com` + `api.moonshot.ai` через Decepticon LiteLLM | Нет инфраструктурных задач, фокус на продукте |
| **Phase 4-5 (first paying clients)** | Тот же + own LLM gateway slim layer (audit log, model routing, fallback chain) | Control plane для observability |
| **Phase 6+ (enterprise data-residency)** | Self-host DeepSeek V4 + K2.6 на Yandex Cloud GPU; Opus 4.7 — Anthropic on-prem deal или alternative open-weight reasoning model | Compliance / latency драйверы |
| **Vendor lock mitigation** | LiteLLM model-agnostic — переключение модели = config change, не code rewrite | Защита от deprecation / pricing changes |

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
- Decepticon LiteLLM proxy → hybrid model mix (Opus 4.7 / DeepSeek V4 / K2.6)
- Decepticon Neo4j → attack path knowledge graph

### LLM orchestration (hybrid mix)

- **`Claude Opus 4.7`** (Anthropic, 1M ctx) — reasoning-heavy ролей: orchestrator, exploit, exploiter, post-exploit, ad-operator, contract-auditor, reverser, analyst, soundwave
- **`DeepSeek V4-Pro/Flash`** (DeepSeek, MIT open-weights, 1M ctx) — cost-heavy ролей: recon, scanner, detector, patcher, defender, cloud-hunter
- **`Kimi K2.6`** (Moonshot, Modified MIT open-weights) — verifier role (vendor diversity + open-weights backup)
- Decepticon LiteLLM proxy управляет routing, fallback, retry — vendor-agnostic
- Own gateway slim layer: audit log / model routing analytics / fallback chain

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
- skill library (Anthropic-Cyber-Skills audited subset + Decepticon agent docs, queryable, with framework mapping retrieval)
- Decepticon session management (start/stop/status)

### 3. coordinator

**Тонкий сервис.** Decepticon — основная runtime логика pentest'а. Coordinator управляет:

- **Assessment lifecycle**: создание session → формирование Decepticon OPPLAN с target / scope / available tools
- **Decepticon instance management**: запуск/остановка Decepticon Docker deployment на ассессмент (один Decepticon instance = один assessment)
- **Scope enforcement**: verified target/scope policy как overlay на Decepticon sandbox (target host whitelist)
- **Mission state persistence**: между Decepticon sessions (crash → resume)
- **Tool routing**: Decepticon sandbox (primary) ↔ cyberstrike-runner (supplementary) ↔ browser-worker (browser-first)
- **Validator dispatch**: candidate findings от Decepticon → deterministic validators
- **Final findings collection**: validators → БД → report
- **Reliability kill-switch**: wall-clock timeout / step cap / divergence detector
- **Post-hoc cost analytics**: audit only, не blocking

### 4. decepticon-engine

Decepticon Docker deployment (dual network isolation):

- `sandbox-net`: Kali Linux sandbox + C2 server + targets
- `decepticon-net`: LLM gateway (LiteLLM → hybrid mix Opus 4.7 / DeepSeek V4 / K2.6) + agent API + Neo4j + DB
- Agent API доступен coordinator через Docker socket
- LiteLLM proxy конфиг: per-agent role → optimal model (см. таблицу в «Decepticon» секции). Fallback chain: Opus → K2.6 → DeepSeek V4-Pro

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
- enforcement verified target/scope policy
- timeout / RPS / politeness throttle
- вызывает offensive / C2 / persistence tools только после регистрации, авторизации, ownership verification и внутри active assessment scope

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
- `skill_library` (Anthropic-Cyber-Skills audited subset + Decepticon agent docs; columns: `name`, `domain`, `subdomain`, `tags[]`, `frontmatter_jsonb`, `body_md`, `atlas_techniques[]`, `d3fend_techniques[]`, `nist_csf[]`, `nist_ai_rmf[]`, `atlas_attack[]`, `audit_status`)
- `framework_mappings` (denormalized index for fast filtering: `skill_id`, `framework`, `technique_id` — для compliance report generation)
- В `findings`: добавить колонки `attack_techniques[]`, `nist_csf_subcategories[]` — auto-populated from used skills для compliance reports
- `tool_catalog` (verified catalog — какие YAML tools доступны после регистрации, авторизации, ownership verification и scope binding)

## Worker Model

Принцип:

- Decepticon — primary pentest engine (autonomous, 16 агентов, kill chain)
- coordinator управляет lifecycle + scope + validation
- cyberstrike-worker — supplementary full verified tool catalog не в Decepticon default
- browser-worker — browser-first signal (наш основной сигнал)
- finding публикуется только после deterministic validator
- Decepticon sandbox — изолированная среда, единственный путь к offensive tooling

### Decepticon engine

Разрешено:

- Все 16 agent roles в рамках OPPLAN
- LiteLLM → hybrid mix (Opus 4.7 reasoning + DeepSeek V4 cost + K2.6 verifier), per-agent role mapping
- Kali sandbox tools (встроенные)
- Neo4j knowledge graph
- Offensive Vaccine loop (attack → defend → verify)

Ограничено (наш overlay):

- Target host whitelist (наш scope enforcement поверх Decepticon)
- Sliver C2: доступен после регистрации, авторизации, ownership verification и active assessment scope
- Metasploit: доступен после регистрации, авторизации, ownership verification и active assessment scope

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

- вызов любого tool YAML из verified catalog через MCP
- stdout / stderr / parsed output → нормализация
- scope enforcement: target host обязан быть в `assessment_scope_rules`

Запрещено:

- любой YAML за пределами verified catalog
- запуск любого инструмента по unverified / out-of-scope target
- modification файлов на target без authorization на modification testing в assessment scope

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
- high-impact после ownership verification: reverse_shell MCP / webshell tools / metasploit / msfvenom / responder / impacket / bloodhound / netexec / smbmap / hydra / hashcat / john / linpeas / pwntools / ropgadget / ropper / gdb / ghidra / radare2 / volatility3 / binwalk / foremost / exiftool / steghide

**OOB:**

- Interactsh

Все high-impact инструменты входят в verified catalog. Пользователь получает доступ после регистрации, авторизации, подтверждения владения target и запуска assessment в рамках scope. Блокируется не категория инструмента, а unauthenticated / unverified / out-of-scope execution.

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
- Custom MCP config с verified catalog policy
- No outbound к dashscope.aliyuncs.com / api.fofa.so без customer-supplied credentials и regional/data-transfer approval
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
- unauthorized C2 / red-team-as-a-service без регистрации, авторизации, ownership verification и assessment scope

## Порядок разработки

### Phase 1 — Foundation

- `api`
- DB schema (включая `decepticon_sessions`, `tool_catalog`, `skill_library`, `framework_mappings`)
- auth / multi-tenancy
- projects / targets / assessments CRUD
- **Anthropic-Cybersecurity-Skills audit + import** — ручная проверка ~50-100 skills (web pentest + cloud + AD + threat hunting subset) на актуальность команд / качество verification steps; pinned upstream commit; mirror в Yandex Container Registry; index в `skill_library` table с frontmatter metadata + framework mappings
- Skill retrieval API — query by domain / tag / ATT&CK technique / keyword

### Phase 2 — Decepticon integration

- Decepticon Docker deployment в Yandex K8s (dual network isolation)
- LiteLLM proxy config → **hybrid mix**: Opus 4.7 (10 reasoning ролей) + DeepSeek V4 (6 cost ролей) + K2.6 (verifier), fallback chain Opus → K2.6 → DeepSeek
- API keys provisioning: Anthropic + DeepSeek + Moonshot
- `coordinator` service: assessment lifecycle, Decepticon instance management
- Decepticon agent API ↔ coordinator integration
- Scope enforcement overlay (target host whitelist)
- Reliability kill-switch (wall-clock timeout / step cap / divergence detector)
- Per-agent A/B testing harness — для empirical tuning model-to-role mapping на лабораторных таргетах
- Audit log каждого LLM запроса (any provider) → Object Storage

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

- `cyberstrike-runner` Docker build (pinned commit, custom MCP config с verified catalog policy)
- `cyberstrike-worker` (Bun) с MCP client
- import + integration ~55 curated tool YAMLs
- enforcement: outbound firewall, scope check, provider egress verification based on customer-supplied credentials and regional/data-transfer policy

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
- **Hybrid LLM mix** через Decepticon LiteLLM (Opus 4.7 reasoning + DeepSeek V4 cost + K2.6 verifier diversity) — model-per-role, не one-size-fits-all
- **browser-first testing** (primary signal)
- **OOB proof** (Interactsh)
- **deterministic validators** (final gate, наш код)
- **CyberStrike curated tools** (supplementary breadth, включая high-impact tools после ownership verification)
- **Decepticon Offensive Vaccine** (attack → defend → verify loop)
- **Decepticon Neo4j** (attack path knowledge graph)
- evidence-first findings
- supply-chain hygiene (pinned mirrors, controlled provider egress, vendor-agnostic LLM routing через LiteLLM)

Decepticon даёт нам autonomous red team capability «из коробки» — не нужно писать 16 агентов, shell management, OPPLAN generation, attack path tracking. Hybrid LLM mix даёт оптимальный quality-cost trade-off per agent role. Мы фокусируемся на продукте: UI, validation, compliance, multi-tenancy, reporting.

## Что осталось решить (open questions)

### Decepticon-related
- **Decepticon API stability** — agent API для external control (start/stop/status/pause/inject findings). Если нет — нужен thin wrapper поверх Docker socket + log parsing.
- **Decepticon + K2.6 compatibility** — LiteLLM proxy поддерживает OpenAI-compatible endpoints, Moonshot API совместим. Но нужно протестировать tool-use формат K2.6 vs Decepticon prompt templates.
- **Multi-tenancy isolation** — один Decepticon instance на assessment = resource-intensive при масштабировании. K8s resource quotas + queue-based scheduling.
- **Sliver C2 authorization boundary** — Decepticon использует Sliver по умолчанию. Нужно убедиться, что Sliver/C2 доступен только authenticated users с verified target ownership, active assessment scope и audit log.
- **Decepticon + Neo4j** — managed Neo4j на Yandex Cloud или self-hosted в K8s? Если self-hosted — overhead на maintenance.

### CyberStrikeAI-related
- **Reputational risk mitigation** — CyberStrikeAI публично связан с атаками. В продукте используем только YAMLs (НЕ skills — те из Anthropic-Cyber-Skills), но supply chain audit trail важен для enterprise клиентов.
- **Custom MCP config** — существует ли способ запустить cyberstrike-runner с verified catalog policy, или нужен fork.
- **Tool YAML schema stability** — pinning + own integration tests на каждый curated YAML.

### Anthropic-Cybersecurity-Skills-related
- **Quality audit volume** — 754 skills нужно аудитить subset. Plan: cherry-pick 50-100 наиболее релевантных (web pentest + cloud + AD), ручная проверка command accuracy / tool versioning / verification step соответствия. Audit owner = founder в Phase 1; на rolling basis quarterly review.
- **Brand confusion** — имя "Anthropic-Cybersecurity-Skills" может ввести клиента в заблуждение про связь с Anthropic PBC. В нашем UI / docs / marketing этот проект упоминается только как "skill library (community Apache-2.0)" — без mention "Anthropic" в названии источника. Внутренние code paths могут use full name.
- **Framework mapping accuracy** — mapping skill ↔ ATT&CK / NIST / ATLAS / D3FEND зависит от author'а репо. Для compliance report клиенту мы должны быть уверены что mapping корректен. Минимум: spot-check 20% audited skills против official MITRE/NIST docs.
- **Update cadence** — repo обновляется (v1.2.0 April 2026, 152 commits). Plan: pinned commit с quarterly bump после diff review. Не auto-pull main.
- **Single-author bus factor** — mukul975 как single maintainer. Mitigation: own fork в Yandex Container Registry на случай если upstream исчезнет; периодический snapshot всего репо в archive.

### Hybrid LLM mix-related
- **Per-agent model A/B testing** — benchmarks ≠ specific pentest workload. Лабораторный harness для empirical tuning: который ролей реально benefit от Opus vs которые работают на DeepSeek без потери quality? Plan: A/B на DVWA / Juice Shop / VAMPI с обоими моделями, diff finding count + FP rate.
- **Tool description tuning per model** — Opus 4.7 / DeepSeek V4 / K2.6 могут по-разному реагировать на одни и те же tool descriptions. Возможна необходимость per-model prompt variants. Decepticon уже имеет tuned prompts для Claude — нужно проверить совместимость.
- **Reliability на длинных sessions** — все три модели могут диагностически расходиться. Kill-switch'ы (wall-clock / step cap / divergence detector) обязательны независимо от выбора модели.
- **Self-host triggers** — DeepSeek V4 + K2.6 self-hostable на Yandex GPU. Opus 4.7 closed-weights — international API only до Anthropic on-prem deal. Решение по self-host: enterprise data-residency SLA или latency goal, не cost.
- **Vendor lock mitigation** — LiteLLM proxy = model-agnostic. Переключение модели = конфиг, не код. Уже встроено архитектурно.
- **Frontier model churn** — все 4 модели <2 недель на market (Apr 16-24, 2026). Через 2-3 месяца landscape может измениться. Quarterly review of per-role model choice обязательно.
- **Cost analytics** — без budget caps (per user directive 2026-04-27), но audit log сохраняется per-assessment для post-hoc cost economics. Полезно для будущего pricing decisions.

### Compliance / general
- **RU sanctions exposure** — Apache-2.0 / Modified MIT не блокируются. Yandex Container Registry mirror решает.
- **Self-host K2.6 на Yandex GPU** — 8x H100 кластер ~$15-25K/мес. Включается когда ARR оправдывает.
- **Audit log retention** — 90 дней hot (Object Storage), 1 год cold, потом truncate.
