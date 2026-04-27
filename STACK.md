# AI Pentest Platform Stack

## Цель

Построить XBOW-like платформу для автономного pentest/adversary-emulation продукта под РФ рынок.

Ключевые принципы:

- один облачный провайдер: `Yandex Cloud`
- один язык и runtime: `TypeScript + Bun`
- browser-first проверка
- findings только после валидации
- продукт позиционируется как `authorized pentest platform`, а не offensive tooling company

## Зафиксированный стек

### Frontend

- `React`
- `TypeScript`
- `Vite`
- `React Router`
- `TanStack Query`
- `Zustand`

### Backend

- `Hono`
- `Bun`
- `Playwright + Chromium`

### Infra

- `Yandex Managed PostgreSQL`
- `Yandex Message Queue`
- `Yandex Object Storage`
- `Yandex Container Registry`
- `Yandex Managed Kubernetes`
- `Yandex Application Load Balancer`

### Security / Testing Tools

- `Playwright` for browser automation and validation
- `Nuclei` as signal source for known issues and exposure checks
- `Interactsh` as OOB proof service
- `Burp Suite` or `Caido` as analyst desk for manual triage

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

### 3. coordinator

Отвечает за orchestration:

- создание assessment plan
- постановка задач в очередь
- budget / retries / stop conditions
- сбор результатов
- запуск validator jobs

### 4. http-worker

Отвечает за:

- HTTP probing
- API exploration
- OpenAPI ingestion
- Nuclei integration
- SSRF / file-read / RCE prechecks
- OOB checks через Interactsh

### 5. browser-worker

Отвечает за:

- login flows
- authenticated crawling
- JS-heavy navigation
- DOM inspection
- XSS verification
- screenshots / traces / HAR

### 6. validator-worker

Отвечает за deterministic validation:

- `xss-validator`
- `ssrf-validator`
- `file-read-validator`
- `rce-validator`

### 7. oob

Self-hosted `interactsh` для callback-based proof.

## Очереди

- `assessment.start`
- `recon.http`
- `recon.browser`
- `attack.http`
- `attack.browser`
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
- `oob_events`

## Worker Model

Принцип:

- coordinator выбирает worker type и цель
- worker получает широкую свободу внутри своего класса
- сеть, scope и ресурсы ограничиваются политикой
- finding публикуется только после validator

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

## Инструменты агентов

Агенты должны использовать не "все подряд", а стабильный tool catalog:

- browser actions
- HTTP executor
- OpenAPI parser
- `Nuclei`
- `Interactsh`
- artifact parser
- validator replay

Инструменты вида `Sliver`, `Havoc`, `Evilginx` не входят в core stack.

## Deployment в Yandex Cloud

### Public

- `Application Load Balancer`
- `web`
- `api`

### Private / cluster internal

- `coordinator`
- `http-worker`
- `browser-worker`
- `validator-worker`
- `oob`

### Managed Services

- `Managed PostgreSQL`
- `Message Queue`
- `Object Storage`
- `Container Registry`

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

## Порядок разработки

### Phase 1

- `api`
- DB schema
- auth
- projects / targets / assessments CRUD

### Phase 2

- `coordinator`
- queues
- job lifecycle

### Phase 3

- `browser-worker`
- login flows
- trace / screenshot capture

### Phase 4

- `http-worker`
- OpenAPI ingestion
- `Nuclei` adapter

### Phase 5

- `oob`
- `Interactsh` integration
- validator flows

### Phase 6

- evidence model
- findings UX
- report generation

## Main Bet

Наша ставка не на "еще один сканер", а на связку:

- coordinator
- short-lived workers
- browser-first testing
- OOB proof
- deterministic validators
- evidence-first findings

Это и есть ближайший практичный путь к XBOW-like продукту для solo founder.
