# Project Specification — AI Pentest Platform / CyberStrike Hybrid

> Спецификация подготовлена на основе `STACK-cyberstrike-hybrid.md`.
> Документ описывает проектные требования, архитектурные контракты, границы безопасности, данные, очереди, сервисы, UI, деплой, тестирование и критерии приемки.
> Внешние факты о сторонних моделях, репозиториях и бенчмарках считаются входными предположениями из stack-документа и должны проходить quarterly review перед производственными решениями.

## 1. Назначение продукта

### 1.1. Краткое описание

Платформа является multi-tenant SaaS / private-cloud продуктом для авторизованного автономного pentest и adversary emulation в owned или явно разрешенных средах клиента.

Основная ценность продукта:

- автономное прохождение kill chain через Decepticon engine;
- browser-first проверка современных web-приложений;
- deterministic validation перед публикацией findings;
- evidence-first отчетность;
- профессиональная дисциплина engagement: OPPLAN, RoE, ConOps, deconfliction;
- hybrid LLM routing по ролям агентов;
- российская инфраструктурная база на Yandex Cloud;
- compliance-friendly supply chain с pinned mirrors, audit logs и ownership-verified offensive capabilities.

### 1.2. Продуктовое позиционирование

Продукт позиционируется как:

- authorized pentest platform;
- exploit-validated security testing;
- adversary emulation for owned and authorized environments;
- autonomous red team with professional engagement discipline;
- evidence-first vulnerability validation and reporting platform.

Продукт не позиционируется как:

- malware tooling;
- phishing platform;
- unauthorized C2 platform;
- persistence framework;
- stealth tooling;
- credential attack platform;
- red-team-as-a-service без регистрации, авторизации, подтверждения владения и утвержденного assessment scope;
- offensive tooling company.

### 1.3. Целевые пользователи

Основные роли:

- `Platform Admin` — управляет tenants, users, verified tool catalog, deployment policies, audit retention.
- `Tenant Admin` — управляет пользователями и проектами внутри организации клиента.
- `Security Lead` — создает проекты, задает scope, утверждает assessment, принимает отчет.
- `Pentest Operator` — запускает assessments, контролирует HITL approvals, анализирует findings и evidence.
- `Developer / App Owner` — читает findings, remediation guidance, replay evidence, patch recommendations.
- `Auditor / Compliance Reviewer` — читает отчеты, framework mappings, RoE, audit log extracts.

### 1.4. Основные сценарии

1. Клиент создает проект и регистрирует targets.
2. Security Lead задает scope rules, exclusions, allowed windows, verified tool catalog access и assessment profile.
3. Coordinator формирует OPPLAN input для Decepticon.
4. Decepticon запускается как один изолированный instance на assessment.
5. Browser-worker собирает authenticated browser signals.
6. HTTP-worker и cyberstrike-worker дополняют сигнал recon / scanning данными.
7. Decepticon строит attack path, генерирует candidate findings.
8. Validator-worker воспроизводит candidate finding deterministic replay.
9. Только подтвержденные findings публикуются в UI и отчет.
10. Offensive Vaccine loop генерирует defensive recommendations и проверяет их применимость.
11. Report builder формирует PDF / HTML / JSON отчет с evidence и mappings.

## 2. Non-Negotiable Product Rules

### 2.1. Scope-first execution

Каждый tool call обязан пройти scope enforcement до выполнения.

Scope enforcement применяется на уровнях:

- API request;
- coordinator job dispatch;
- worker execution;
- Decepticon sandbox overlay;
- cyberstrike-runner MCP verified catalog policy;
- outbound firewall / egress policies;
- validator replay;
- report publication.

Запрещено выполнять действие, если target host, URL, IP, CIDR, cloud account, repository, API endpoint или callback destination не входит в разрешенный scope assessment.

### 2.2. Findings after deterministic validation only

LLM-generated, scanner-generated или agent-generated finding является `candidate`, пока validator-worker не подтвердит его replay.

Публикуемый finding обязан иметь:

- affected asset;
- vulnerability class;
- severity;
- reproducible steps;
- deterministic validation result;
- evidence package;
- timestamp;
- source observations;
- scope proof;
- confidence score;
- remediation guidance;
- framework mappings where applicable.

### 2.3. Browser-first as primary signal source

Для web-app assessments browser-worker является primary signal source, потому что современные приложения зависят от:

- client-side routing;
- JS-heavy rendering;
- SPA state;
- cookies / local storage / session storage;
- authenticated flows;
- CSRF tokens;
- dynamic forms;
- API calls observed from browser runtime.

HTTP-worker и scanners дополняют browser evidence, но не заменяют его.

### 2.4. Offensive capabilities are ownership-verified

Все инструменты каталога доступны пользователю после выполнения обязательных условий:

- пользователь зарегистрирован;
- пользователь авторизован;
- пользователь подтвердил права владения или authorization на target;
- target включен в assessment scope;
- assessment создан и утвержден внутри продукта;
- действие выполняется только по scope-bound assets;
- действие записывается в audit log.

Это включает high-impact категории:

- Sliver C2;
- webshell management;
- reverse shells;
- persistence testing;
- credential dumping simulations;
- password audit workflows;
- hash cracking workflows;
- phishing simulation workflows where customer scope explicitly includes them;
- Evilginx-like simulation flows where customer scope explicitly includes them;
- responder / relay attack simulation;
- Metasploit;
- msfvenom payload generation;
- post-exploit lateral movement testing;
- AD attack-path tooling;
- reverse engineering tooling;
- forensic tooling.

Правило продукта: инструменты не скрываются и не запрещаются по категории после ownership verification. Блокируется только запуск вне подтвержденного scope, вне testing window, без нужного target authorization или с нарушением tenant/platform policy.

### 2.5. Cost caps are not blocking guards

Budget caps не останавливают assessment.

Разрешены:

- per-assessment LLM cost tracking;
- post-hoc cost analytics;
- model usage dashboards;
- anomaly alerts;
- quarterly model mapping tuning.

Запрещено:

- прерывать assessment только из-за budget cap, если user directive сохраняет приоритет completion over cost.

## 3. System Architecture

### 3.1. High-level components

Платформа состоит из:

- `web` — React SPA console.
- `api` — Hono + Bun product API.
- `coordinator` — assessment lifecycle and orchestration service.
- `decepticon-engine` — isolated Decepticon runtime per assessment.
- `http-worker` — HTTP probing, API exploration, OOB prechecks.
- `browser-worker` — Playwright + Chromium browser automation.
- `cyberstrike-worker` — supplementary curated tools via cyberstrike-runner MCP.
- `validator-worker` — deterministic replay validators.
- `oob` — self-hosted Interactsh proof service.
- `report-builder` — report generation pipeline.
- `llm-gateway` — slim layer around LiteLLM audit and analytics.
- `postgres` — product state.
- `neo4j` — attack path knowledge graph for Decepticon.
- `object-storage` — artifacts, traces, screenshots, reports, raw logs.
- `message-queue` — async job dispatch.
- `observability` — OpenTelemetry and Sentry.

### 3.2. Product boundary versus engine boundary

Decepticon is the autonomous pentest engine.

Product platform owns:

- tenant isolation;
- auth;
- project and target management;
- scope model;
- assessment lifecycle;
- LLM audit trail;
- browser-first signal;
- supplementary tools integration;
- deterministic validation;
- final finding publication;
- reporting;
- compliance views;
- billing / cost analytics later;
- Yandex Cloud deployment and operations.

Decepticon owns:

- 16 specialist agent roles;
- kill chain progression;
- OPPLAN / RoE / ConOps generation support;
- tmux-based interactive shell management;
- Kali sandbox tool execution;
- attack path graph generation;
- Offensive Vaccine loop;
- internal agent reasoning and handoff.

### 3.3. Service trust zones

Public zone:

- `web`;
- public route to `api` through Yandex Application Load Balancer.

Private product zone:

- `api`;
- `coordinator`;
- `http-worker`;
- `browser-worker`;
- `cyberstrike-worker`;
- `validator-worker`;
- `report-builder`;
- `llm-gateway`.

Isolated assessment zone:

- one Decepticon deployment per assessment;
- Kali sandbox network;
- Decepticon internal network;
- optional lab targets for internal testing;
- Neo4j scoped to assessment or namespace.

Managed services zone:

- Yandex Managed PostgreSQL;
- Yandex Message Queue;
- Yandex Object Storage;
- Yandex Container Registry;
- Sentry / telemetry endpoint if approved.

### 3.4. Network isolation

Decepticon runtime must preserve dual-network isolation:

- `sandbox-net` contains Kali sandbox, offensive tools, optional C2 components, and target-facing execution path.
- `decepticon-net` contains agent API, LLM gateway, Decepticon control plane, DB adapters and Neo4j.

Rules:

- sandbox must not reach product DB directly;
- sandbox must not reach arbitrary internet unless scope and tool policy allow it;
- sandbox egress must be routed through controlled gateway or policy layer;
- coordinator may talk to Decepticon agent API;
- Decepticon may call llm-gateway / LiteLLM;
- cyberstrike-runner must run in private namespace and expose the full verified tool catalog only to authorized, scope-bound assessments;
- Interactsh domain and callback endpoints must be assessment-scoped.

## 4. Technology Stack

### 4.1. Frontend

Required stack:

- React;
- TypeScript;
- Vite;
- React Router;
- TanStack Query;
- Zustand.

Frontend requirements:

- SPA console;
- no direct access to worker or engine services;
- all operations through `api`;
- optimistic UI only for non-critical metadata edits;
- assessment control actions must reflect server state, not local state;
- all security-relevant actions require audit event creation.

### 4.2. Backend

Required stack:

- Bun runtime;
- Hono framework;
- TypeScript;
- PostgreSQL client / query builder selected during implementation;
- OpenTelemetry instrumentation;
- Sentry integration.

Backend requirements:

- strict tenant boundaries;
- typed request / response contracts;
- structured errors;
- idempotency keys for state-changing assessment commands;
- background job enqueue through Yandex Message Queue;
- object artifacts stored outside Postgres.

### 4.3. Pentest engine

Required engine:

- Decepticon Docker deployment;
- Decepticon LiteLLM proxy;
- Decepticon Neo4j attack path graph;
- Kali sandbox;
- one Decepticon instance per assessment for strong isolation in v1.

### 4.4. Supplementary tools

Required supplementary runner:

- cyberstrike-runner Go binary as sidecar;
- custom MCP config;
- HTTP MCP transport inside private namespace;
- full curated YAML catalog after user registration, authentication and ownership verification.

Available curated families after ownership verification:

- recon: nmap, masscan, rustscan, amass, subfinder, dnsenum, fierce, feroxbuster, gobuster, ffuf, dirsearch, katana, paramspider, gau, waybackurls, wafw00f;
- web: nuclei, sqlmap, zap, wpscan, dalfox, jaeles, nikto, x8, xsser;
- API: jwt-analyzer, api-schema-analyzer, graphql-scanner, arjun;
- cloud: pacu, prowler, scout-suite, kube-hunter, kube-bench, trivy, terrascan, checkov, cloudmapper, falco, clair;
- OSINT: shodan_search, quake_search and equivalent external intelligence connectors when user supplies authorized credentials;
- AD: enum4linux-ng, nbtscan, arp-scan, rpcclient, responder, impacket, bloodhound, netexec, smbmap;
- exploitation and payload tooling: reverse_shell MCP, webshell tools, metasploit, msfvenom;
- credential audit tooling: hydra, hashcat, john;
- post-exploitation enumeration: linpeas and equivalent local enumeration tools;
- binary exploitation and reverse engineering: pwntools, ropgadget, ropper, gdb, ghidra, radare2;
- forensics and artifact analysis: volatility3, binwalk, foremost, exiftool, steghide;
- provider-specific configs: Aliyun / Qwen / FOFA configs are available only when configured by the customer or operator with explicit credentials and regional/data-transfer approval.

No tool is category-blocked after ownership verification. Every execution is still scope-checked, logged, rate-limited where applicable and tied to a specific assessment.

### 4.5. Infrastructure

Yandex Cloud only:

- Managed PostgreSQL;
- Message Queue;
- Object Storage;
- Container Registry;
- Managed Kubernetes;
- Application Load Balancer.

Production deployment must not depend on unmanaged local Docker Compose except for development and internal lab.

## 5. LLM Architecture

### 5.1. Routing principle

Model routing is per Decepticon agent role, not global.

LiteLLM is the vendor-agnostic routing layer. Product llm-gateway adds:

- request audit logging;
- tenant / assessment tagging;
- provider metadata;
- retry metadata;
- model selection analytics;
- cost tracking;
- fallback visibility;
- prompt / completion retention policy controls.

### 5.2. Production model mapping

| Agent role | Primary model | Rationale |
|---|---|---|
| Decepticon main orchestrator | Claude Opus 4.7 | Deep reasoning, long context, OPPLAN + RoE + ConOps state |
| Soundwave planning | Claude Opus 4.7 | Planning-heavy role |
| Recon | DeepSeek V4-Flash | Frequent calls, cost-efficient long-context processing |
| Scanner | DeepSeek V4-Pro | Tool-use heavy, cost-sensitive |
| Exploit | Claude Opus 4.7 | Exploit reasoning and code generation quality |
| Exploiter | Claude Opus 4.7 | Multi-step exploitation chains |
| Detector | DeepSeek V4-Pro | Output analysis at lower cost |
| Verifier | Kimi K2.6 | Vendor-diverse independent verification |
| Patcher | DeepSeek V4-Pro | Code generation and remediation at controlled cost |
| Post-Exploit | Claude Opus 4.7 | Complex reasoning; available after ownership verification and scope approval |
| Defender | DeepSeek V4-Pro | Offensive Vaccine analysis |
| AD Operator | Claude Opus 4.7 | Complex terminal / AD workflows; available after ownership verification and scope approval |
| Cloud Hunter | DeepSeek V4-Pro | Cloud security analysis at controlled cost |
| Contract Auditor | Claude Opus 4.7 | Deep code and smart-contract reasoning |
| Reverser | Claude Opus 4.7 | Complex reverse engineering reasoning |
| Analyst | Claude Opus 4.7 | High-level synthesis and report reasoning |

### 5.3. Profiles

`production`:

- reasoning-heavy roles use Opus;
- cost-heavy roles use DeepSeek;
- verifier uses K2.6.

`cost`:

- cost-tier roles use DeepSeek V4-Flash;
- Opus only for orchestrator and critical reasoning gates;
- verifier remains independent.

`max`:

- all feasible roles use Opus;
- verifier may remain K2.6 for diversity unless explicitly overridden.

`test`:

- all roles use DeepSeek V4-Flash or local/mock model;
- no production API keys required for CI.

### 5.4. Fallback chain

Default fallback:

1. Opus 4.7;
2. Kimi K2.6;
3. DeepSeek V4-Pro.

Fallback event must record:

- original model;
- fallback model;
- provider error;
- request id;
- assessment id;
- agent role;
- retry count;
- latency;
- token usage if available.

### 5.5. LLM audit

Every LLM call must create an immutable audit record with:

- tenant id;
- project id;
- assessment id;
- Decepticon session id;
- agent role;
- provider;
- model;
- prompt hash;
- response hash;
- token counts;
- latency;
- tool calls requested;
- tool calls executed;
- fallback metadata;
- policy redaction state;
- storage pointer to raw payload if retention policy permits.

Raw prompt / completion storage must be configurable per tenant.

### 5.6. Self-hosting phase

Phase 6+ supports self-hosted DeepSeek V4 and K2.6 on Yandex GPU when:

- enterprise data residency requires it;
- latency justifies it;
- contract value justifies GPU cost;
- legal / procurement approves model license.

Opus remains international API unless enterprise on-prem arrangement exists or an alternative open-weight reasoning model replaces it.

## 6. Domain Model

### 6.1. Tenant

Tenant represents one customer organization.

Required fields:

- `id`;
- `name`;
- `slug`;
- `status`;
- `plan`;
- `data_residency_mode`;
- `llm_retention_policy`;
- `created_at`;
- `updated_at`.

Rules:

- every project belongs to one tenant;
- tenant data isolation is mandatory in every query;
- cross-tenant access is a critical security bug.

### 6.2. User

Required fields:

- `id`;
- `tenant_id`;
- `email`;
- `display_name`;
- `role`;
- `status`;
- `mfa_enabled`;
- `last_login_at`;
- `created_at`;
- `updated_at`.

Roles:

- `platform_admin`;
- `tenant_admin`;
- `security_lead`;
- `operator`;
- `developer`;
- `auditor`;
- `viewer`.

### 6.3. Project

Project groups targets and assessments.

Required fields:

- `id`;
- `tenant_id`;
- `name`;
- `description`;
- `business_owner`;
- `technical_owner`;
- `criticality`;
- `created_by`;
- `created_at`;
- `updated_at`;
- `archived_at`.

### 6.4. Target

Target is an asset authorized for testing.

Supported types:

- `web_app`;
- `api`;
- `host`;
- `cidr`;
- `cloud_account`;
- `kubernetes_cluster`;
- `repository`;
- `mobile_backend`;
- `smart_contract`.

Required fields:

- `id`;
- `tenant_id`;
- `project_id`;
- `type`;
- `name`;
- `canonical_identifier`;
- `environment`;
- `criticality`;
- `ownership_proof_status`;
- `metadata_jsonb`;
- `created_at`;
- `updated_at`.

Examples:

- web app: `https://app.example.ru`;
- API: OpenAPI document plus base URL;
- host: `192.0.2.10`;
- CIDR: `192.0.2.0/24`;
- cloud account: cloud provider account id;
- Kubernetes: cluster endpoint or uploaded kube audit context.

### 6.5. Assessment

Assessment is a controlled test run against selected targets.

Required fields:

- `id`;
- `tenant_id`;
- `project_id`;
- `name`;
- `status`;
- `profile`;
- `llm_profile`;
- `scope_summary`;
- `testing_window_start`;
- `testing_window_end`;
- `has_foothold`;
- `metasploit_allowed`;
- `post_exploit_allowed`;
- `c2_allowed`;
- `cloud_scope_allowed`;
- `ad_scope_allowed`;
- `created_by`;
- `approved_by`;
- `started_at`;
- `paused_at`;
- `completed_at`;
- `cancelled_at`;
- `failed_at`;
- `failure_reason`;
- `created_at`;
- `updated_at`.

Statuses:

- `draft`;
- `pending_approval`;
- `approved`;
- `queued`;
- `initializing`;
- `running`;
- `pausing`;
- `paused`;
- `resuming`;
- `validating`;
- `reporting`;
- `completed`;
- `cancelled`;
- `failed`;
- `expired`.

Allowed transitions:

- `draft -> pending_approval`;
- `pending_approval -> approved`;
- `approved -> queued`;
- `queued -> initializing`;
- `initializing -> running`;
- `running -> pausing`;
- `pausing -> paused`;
- `paused -> resuming`;
- `resuming -> running`;
- `running -> validating`;
- `validating -> reporting`;
- `reporting -> completed`;
- any active state -> `cancelled`;
- active states -> `failed` on unrecoverable error.

### 6.6. Scope Rule

Scope rule determines what may be tested.

Required fields:

- `id`;
- `tenant_id`;
- `assessment_id`;
- `rule_type`;
- `effect`;
- `value`;
- `normalized_value`;
- `metadata_jsonb`;
- `created_at`;
- `updated_at`.

Rule types:

- `domain`;
- `subdomain`;
- `url_prefix`;
- `ip`;
- `cidr`;
- `port`;
- `protocol`;
- `cloud_account`;
- `kubernetes_namespace`;
- `repository`;
- `time_window`;
- `rate_limit`;
- `tool_category`;
- `tool_name`;
- `http_method`;
- `path_pattern`.

Effects:

- `allow`;
- `deny`.

Deny rules override allow rules.

### 6.7. Decepticon Session

Required fields:

- `id`;
- `tenant_id`;
- `assessment_id`;
- `k8s_namespace`;
- `deployment_name`;
- `agent_api_url`;
- `neo4j_uri`;
- `litellm_config_version`;
- `engine_image_digest`;
- `status`;
- `started_at`;
- `stopped_at`;
- `last_heartbeat_at`;
- `crash_count`;
- `resume_token`;
- `metadata_jsonb`.

Rules:

- one active Decepticon session per active assessment in v1;
- restart requires preserving mission state when possible;
- session must be destroyed or archived after retention window.

### 6.8. Observation

Observation is raw or normalized signal before finding validation.

Observation sources:

- `http`;
- `browser`;
- `cyberstrike`;
- `decepticon`;
- `oob`;
- `manual`.

Common fields:

- `id`;
- `tenant_id`;
- `assessment_id`;
- `source`;
- `target_id`;
- `url`;
- `host`;
- `port`;
- `protocol`;
- `method`;
- `status_code`;
- `title`;
- `content_type`;
- `request_hash`;
- `response_hash`;
- `raw_artifact_id`;
- `normalized_jsonb`;
- `created_at`.

### 6.9. Candidate Finding

Candidate finding is not user-visible as confirmed vulnerability.

Required fields:

- `id`;
- `tenant_id`;
- `assessment_id`;
- `source`;
- `candidate_type`;
- `title`;
- `description`;
- `affected_asset`;
- `severity_suggested`;
- `confidence_suggested`;
- `evidence_refs`;
- `replay_plan_jsonb`;
- `validation_status`;
- `created_at`;
- `updated_at`.

Validation statuses:

- `queued`;
- `running`;
- `confirmed`;
- `rejected`;
- `inconclusive`;
- `needs_human_review`;
- `out_of_scope`.

### 6.10. Finding

Finding is a confirmed vulnerability.

Required fields:

- `id`;
- `tenant_id`;
- `project_id`;
- `assessment_id`;
- `target_id`;
- `title`;
- `summary`;
- `description`;
- `vulnerability_class`;
- `severity`;
- `cvss_vector`;
- `cvss_score`;
- `confidence`;
- `status`;
- `affected_asset`;
- `affected_url`;
- `affected_parameter`;
- `proof_summary`;
- `reproduction_steps_md`;
- `impact_md`;
- `remediation_md`;
- `references_jsonb`;
- `attack_techniques`;
- `nist_csf_subcategories`;
- `created_from_candidate_id`;
- `validated_by`;
- `validated_at`;
- `first_seen_at`;
- `last_seen_at`;
- `created_at`;
- `updated_at`.

Statuses:

- `open`;
- `triaged`;
- `accepted_risk`;
- `false_positive`;
- `fixed`;
- `retested`;
- `closed`.

### 6.11. Evidence

Evidence is immutable proof attached to candidate or confirmed finding.

Evidence types:

- screenshot;
- Playwright trace;
- HAR;
- HTTP request / response pair;
- command output;
- OOB callback;
- file excerpt;
- DOM snapshot;
- video;
- validator log;
- Neo4j attack path export;
- generated patch recommendation.

Required fields:

- `id`;
- `tenant_id`;
- `assessment_id`;
- `finding_id`;
- `candidate_finding_id`;
- `type`;
- `object_storage_key`;
- `sha256`;
- `size_bytes`;
- `content_type`;
- `redaction_status`;
- `metadata_jsonb`;
- `created_at`.

### 6.12. Skill Library

Skill library stores audited subset of community security skills and internal Decepticon agent docs.

Required fields:

- `id`;
- `name`;
- `source`;
- `source_commit`;
- `domain`;
- `subdomain`;
- `tags`;
- `frontmatter_jsonb`;
- `body_md`;
- `atlas_techniques`;
- `d3fend_techniques`;
- `nist_csf`;
- `nist_ai_rmf`;
- `atlas_attack`;
- `audit_status`;
- `audited_by`;
- `audited_at`;
- `created_at`;
- `updated_at`.

Audit statuses:

- `pending`;
- `approved`;
- `rejected`;
- `needs_update`;
- `deprecated`.

### 6.13. Framework Mapping

Required fields:

- `id`;
- `skill_id`;
- `framework`;
- `technique_id`;
- `technique_name`;
- `mapping_confidence`;
- `source`;
- `verified_at`;

Supported frameworks:

- MITRE ATT&CK;
- NIST CSF;
- MITRE ATLAS;
- MITRE D3FEND;
- NIST AI RMF.

## 7. PostgreSQL Schema Requirements

### 7.1. Required tables

Minimum v1 tables:

- `tenants`;
- `users`;
- `projects`;
- `targets`;
- `assessments`;
- `assessment_scope_rules`;
- `assessment_artifacts`;
- `decepticon_sessions`;
- `jobs`;
- `findings`;
- `candidate_findings`;
- `finding_evidence`;
- `observations_http`;
- `observations_browser`;
- `observations_cyberstrike`;
- `observations_decepticon`;
- `oob_events`;
- `skill_library`;
- `framework_mappings`;
- `tool_catalog`;
- `llm_audit_events`;
- `audit_events`;
- `reports`.

### 7.2. Multi-tenancy requirements

Every tenant-owned table must include:

- `tenant_id`;
- index on `tenant_id`;
- all unique constraints scoped by `tenant_id` where applicable;
- API authorization checks before query execution;
- background job tenant context.

### 7.3. Immutability requirements

The following data is append-only or immutable after creation:

- audit events;
- LLM audit events;
- raw evidence artifacts;
- OOB events;
- validator execution logs;
- report snapshots.

If correction is needed, create a new record or status transition instead of mutating proof.

### 7.4. Artifact storage contract

Large content must not be stored inline in Postgres:

- screenshots;
- HAR files;
- traces;
- raw scan output;
- videos;
- large HTTP responses;
- raw LLM payloads;
- generated PDFs.

Postgres stores metadata and object key only.

## 8. API Specification

### 8.1. API principles

All API endpoints must:

- authenticate user;
- resolve tenant context;
- enforce RBAC;
- validate request body;
- return typed JSON;
- emit audit event for state-changing security-relevant action;
- use idempotency keys for start / stop / pause / resume / approve actions.

### 8.2. Auth endpoints

Required endpoints:

- `POST /auth/login`;
- `POST /auth/logout`;
- `GET /auth/me`;
- `POST /auth/mfa/enable`;
- `POST /auth/mfa/verify`;
- `POST /auth/password/reset-request`;
- `POST /auth/password/reset-confirm`.

### 8.3. Project endpoints

Required endpoints:

- `GET /projects`;
- `POST /projects`;
- `GET /projects/:projectId`;
- `PATCH /projects/:projectId`;
- `DELETE /projects/:projectId`;
- `GET /projects/:projectId/summary`;

### 8.4. Target endpoints

Required endpoints:

- `GET /projects/:projectId/targets`;
- `POST /projects/:projectId/targets`;
- `GET /targets/:targetId`;
- `PATCH /targets/:targetId`;
- `DELETE /targets/:targetId`;
- `POST /targets/:targetId/ownership-proof`;
- `GET /targets/:targetId/observations`;

### 8.5. Assessment endpoints

Required endpoints:

- `GET /projects/:projectId/assessments`;
- `POST /projects/:projectId/assessments`;
- `GET /assessments/:assessmentId`;
- `PATCH /assessments/:assessmentId`;
- `POST /assessments/:assessmentId/submit-for-approval`;
- `POST /assessments/:assessmentId/approve`;
- `POST /assessments/:assessmentId/start`;
- `POST /assessments/:assessmentId/pause`;
- `POST /assessments/:assessmentId/resume`;
- `POST /assessments/:assessmentId/cancel`;
- `GET /assessments/:assessmentId/status`;
- `GET /assessments/:assessmentId/timeline`;
- `GET /assessments/:assessmentId/artifacts`;
- `GET /assessments/:assessmentId/engine`;

### 8.6. Scope endpoints

Required endpoints:

- `GET /assessments/:assessmentId/scope-rules`;
- `POST /assessments/:assessmentId/scope-rules`;
- `PATCH /scope-rules/:ruleId`;
- `DELETE /scope-rules/:ruleId`;
- `POST /assessments/:assessmentId/scope/validate`;
- `GET /assessments/:assessmentId/scope/effective`.

`POST /scope/validate` must answer whether a proposed action is allowed:

- URL;
- host;
- IP;
- port;
- method;
- tool;
- tool category;
- time.

### 8.7. Findings endpoints

Required endpoints:

- `GET /assessments/:assessmentId/findings`;
- `GET /findings/:findingId`;
- `PATCH /findings/:findingId/status`;
- `GET /findings/:findingId/evidence`;
- `GET /findings/:findingId/replay`;
- `POST /findings/:findingId/retest`;
- `POST /findings/:findingId/comment`;

### 8.8. Candidate finding endpoints

Required internal or operator endpoints:

- `GET /assessments/:assessmentId/candidate-findings`;
- `GET /candidate-findings/:candidateId`;
- `POST /candidate-findings/:candidateId/validate`;
- `POST /candidate-findings/:candidateId/reject`;
- `POST /candidate-findings/:candidateId/escalate-human-review`.

### 8.9. Skill library endpoints

Required endpoints:

- `GET /skills`;
- `GET /skills/:skillId`;
- `GET /skills/search`;
- `GET /skills/framework/:framework/:techniqueId`;
- `POST /skills/import`;
- `POST /skills/:skillId/audit`;

Search dimensions:

- keyword;
- domain;
- subdomain;
- tag;
- ATT&CK technique;
- NIST CSF subcategory;
- ATLAS technique;
- D3FEND technique;
- audit status.

### 8.10. Tool catalog endpoints

Required endpoints:

- `GET /tools/catalog`;
- `POST /tools/catalog`;
- `PATCH /tools/catalog/:toolId`;
- `DELETE /tools/catalog/:toolId`;
- `GET /assessments/:assessmentId/tools/effective`;

### 8.11. Reports endpoints

Required endpoints:

- `POST /assessments/:assessmentId/reports`;
- `GET /assessments/:assessmentId/reports`;
- `GET /reports/:reportId`;
- `GET /reports/:reportId/download`;
- `POST /reports/:reportId/regenerate`;

Report formats:

- PDF;
- HTML;
- JSON;
- evidence archive ZIP.

## 9. Queue and Job Specification

### 9.1. Required queues

Required queue names:

- `assessment.start`;
- `decepticon.command`;
- `decepticon.findings`;
- `recon.http`;
- `recon.browser`;
- `recon.cyberstrike`;
- `attack.http`;
- `attack.browser`;
- `attack.cyberstrike`;
- `validate.finding`;
- `report.build`.

### 9.2. Common job envelope

Every queued job must include:

```json
{
  "job_id": "uuid",
  "tenant_id": "uuid",
  "project_id": "uuid",
  "assessment_id": "uuid",
  "kind": "string",
  "idempotency_key": "string",
  "created_at": "iso-8601",
  "not_before": "iso-8601",
  "attempt": 0,
  "max_attempts": 3,
  "trace_id": "string",
  "payload": {}
}
```

### 9.3. Retry rules

Retryable:

- transient network errors;
- provider timeout;
- worker restart;
- queue visibility timeout;
- temporary K8s scheduling failure;
- browser crash with recoverable context.

Not retryable without human review:

- out-of-scope target;
- denied tool;
- invalid RoE;
- missing approval;
- destructive tool request outside confirmed target authorization;
- validator confirms exploit would modify target outside allowed bounds.

### 9.4. Idempotency

Idempotency is mandatory for:

- start assessment;
- pause assessment;
- resume assessment;
- cancel assessment;
- report generation;
- validator replay;
- Decepticon command dispatch.

## 10. Coordinator Specification

### 10.1. Responsibilities

Coordinator owns:

- assessment state machine;
- Decepticon instance lifecycle;
- OPPLAN input packaging;
- scope enforcement overlay;
- worker dispatch;
- validator dispatch;
- final finding collection;
- reliability guard enforcement;
- Decepticon health monitoring;
- mission state persistence;
- cost analytics collection;
- cleanup after completion / failure.

Coordinator does not own:

- Decepticon internal agent planning;
- exploit logic;
- browser DOM implementation details;
- report template rendering internals;
- tenant auth.

### 10.2. Assessment start flow

1. API validates assessment status is `approved`.
2. API enqueues `assessment.start`.
3. Coordinator locks assessment row.
4. Coordinator resolves effective scope.
5. Coordinator resolves verified tool catalog access.
6. Coordinator resolves LLM profile.
7. Coordinator creates K8s namespace for assessment.
8. Coordinator deploys Decepticon engine.
9. Coordinator waits for health.
10. Coordinator creates Decepticon session row.
11. Coordinator packages OPPLAN input:
    - targets;
    - scope;
    - exclusions;
    - available tools;
    - tools unavailable because target authorization, credentials, time window or regional policy is missing;
    - testing window;
    - engagement profile;
    - skill library pointers;
    - browser context pointers if available.
12. Coordinator sends start command to Decepticon.
13. Coordinator dispatches initial browser / http / cyberstrike recon jobs.
14. Assessment status becomes `running`.

### 10.3. Mission state persistence

Coordinator must periodically persist:

- Decepticon session status;
- agent objective summaries;
- current phase;
- discovered assets;
- candidate findings;
- pending validations;
- Neo4j snapshot pointer;
- last known OPPLAN state;
- last healthy heartbeat.

Persistence interval:

- default every 60 seconds;
- immediately after candidate finding;
- immediately before pause / cancel;
- immediately after phase transition.

### 10.4. Reliability guards

Default guard configuration:

```ts
interface ReliabilityGuard {
  max_wall_clock_seconds: number; // default 1800
  max_total_steps: number;        // default 4000
  per_agent_step_cap: number;     // default 100
  divergence_detector: boolean;   // default true
}
```

Divergence detection should flag:

- repeated tool calls with no new observations;
- repeated reasoning loops with same plan;
- last 50 steps produce no new evidence;
- agent requests out-of-scope targets repeatedly;
- verifier rejects same candidate repeatedly.

Guard action:

- pause stuck agent if Decepticon supports it;
- inject corrective context if safe;
- stop assessment if engine cannot be controlled;
- mark failure with evidence if unrecoverable.

### 10.5. Pause / resume

Pause must:

- stop new job dispatch;
- request Decepticon pause;
- wait for current validator replay to finish or timeout;
- persist mission state;
- mark status `paused`.

Resume must:

- validate assessment window still allows execution;
- re-check effective scope;
- restart Decepticon if needed;
- restore mission context;
- resume queued work.

### 10.6. Cancel

Cancel must:

- stop job dispatch;
- send stop to Decepticon;
- terminate assessment namespace if safe;
- preserve logs and evidence;
- mark assessment `cancelled`;
- enqueue report only if user requests partial report.

## 11. Worker Specifications

### 11.1. HTTP worker

Responsibilities:

- HTTP probing;
- API exploration;
- OpenAPI / Swagger ingestion;
- route extraction;
- SSRF prechecks;
- file-read prechecks;
- RCE prechecks;
- OOB payload dispatch through Interactsh;
- request replay;
- baseline Nuclei adapter.

Inputs:

- target URL / API schema;
- scope rules;
- rate limits;
- credentials if approved;
- verified tool catalog;
- assessment context.

Outputs:

- `observations_http`;
- candidate findings;
- artifacts;
- OOB correlation ids.

Hard requirements:

- never request out-of-scope host;
- respect robots / politeness config if specified in RoE;
- throttle per target;
- redact secrets from logs where possible;
- preserve raw request / response evidence for validators.

### 11.2. Browser worker

Responsibilities:

- Playwright browser automation;
- login flow execution;
- authenticated crawling;
- SPA route discovery;
- DOM inspection;
- form discovery;
- JS event path discovery;
- API request observation from browser;
- XSS verification;
- screenshots;
- traces;
- HAR capture.

Inputs:

- target web app;
- credentials / auth state;
- login recipe;
- scope rules;
- crawl depth;
- testing window;
- browser profile.

Outputs:

- `observations_browser`;
- screenshots;
- traces;
- HAR artifacts;
- candidate findings;
- browser context summary for Decepticon.

Hard requirements:

- browser traffic must obey scope;
- credentials must be encrypted at rest;
- session cookies must never be exposed in UI by default;
- screenshots with secrets must be redacted or marked sensitive;
- Playwright traces must be retention-controlled.

### 11.3. CyberStrike worker

Responsibilities:

- run curated CyberStrike tool YAMLs via cyberstrike-runner MCP;
- normalize output to observation schema;
- enforce verified tool catalog access;
- enforce target scope;
- enforce timeout;
- enforce RPS / politeness throttle;
- execute offensive C2 / persistence tools when the user is authorized, ownership is verified and the target is inside assessment scope.

Inputs:

- tool name;
- normalized target;
- scope;
- arguments;
- timeout;
- environment variables;
- parser config.

Outputs:

- `observations_cyberstrike`;
- artifacts;
- candidate findings.

Hard requirements:

- cannot run YAML that is not part of the verified tool catalog;
- cannot contact PRC / Aliyun / FOFA endpoints unless the customer or operator supplies explicit credentials and regional/data-transfer policy allows it;
- can run reverse-shell / webshell / persistence tooling only against verified owned targets inside the active assessment scope;
- can modify target files only when the assessment scope authorizes modification testing for that target.

### 11.4. Validator worker

Responsibilities:

- deterministic replay of candidate findings;
- XSS validation;
- SSRF validation;
- file-read validation;
- RCE validation;
- browser replay;
- OOB callback correlation;
- evidence packaging;
- candidate rejection with reason;
- confirmed finding creation.

Validators:

- `xss-validator`;
- `ssrf-validator`;
- `file-read-validator`;
- `rce-validator`.

Validation result fields:

- `status`;
- `confidence`;
- `proof_type`;
- `request_replayable`;
- `side_effect_risk`;
- `evidence_ids`;
- `reason`;
- `validated_at`.

Hard requirements:

- validator must be deterministic where possible;
- destructive validation is blocked unless explicit scope allows it;
- validator must store replay inputs and outputs;
- validator cannot publish finding without evidence;
- validator must mark ambiguous cases as `inconclusive` or `needs_human_review`.

### 11.5. OOB service

Responsibilities:

- self-hosted Interactsh;
- per-assessment callback domains or tokens;
- DNS / HTTP / SMTP interaction capture if supported;
- event correlation with payload ids;
- evidence export.

Hard requirements:

- callbacks must be tenant-isolated;
- OOB tokens must be unguessable;
- retention must be configurable;
- OOB events must be immutable.

### 11.6. Report builder

Responsibilities:

- generate PDF reports;
- generate HTML reports;
- generate JSON export;
- generate evidence archive;
- include framework mappings;
- include attack graph visualization;
- include OPPLAN / RoE / ConOps summaries where appropriate;
- include Offensive Vaccine recommendations.

Hard requirements:

- report must use confirmed findings only by default;
- candidate findings may appear only in operator appendix when requested;
- evidence links must be stable for retention window;
- sensitive artifacts must be redacted or permission-gated.

## 12. Decepticon Integration Specification

### 12.1. Deployment model

For v1:

- one Decepticon deployment per assessment;
- one K8s namespace per assessment;
- resource quotas per namespace;
- network policies per namespace;
- secrets scoped per namespace;
- image pinned by digest.

### 12.2. Engine lifecycle

Required operations:

- create deployment;
- health check;
- start mission;
- send command;
- stream status;
- stream candidate findings;
- pause;
- resume;
- stop;
- export graph;
- export logs;
- destroy deployment.

If Decepticon has no stable API for an operation:

- implement thin wrapper;
- prefer supported logs / API before Docker socket;
- log parsing is allowed only as compatibility adapter;
- wrapper must have integration tests against pinned Decepticon commit.

### 12.3. OPPLAN input contract

Coordinator must provide:

- assessment id;
- target list;
- authorized scope;
- exclusions;
- testing window;
- allowed tools;
- tools unavailable because target authorization, credentials, time window or regional policy is missing;
- engagement profile;
- foothold status;
- post-exploit permissions derived from ownership verification and assessment scope;
- C2 permissions derived from ownership verification and assessment scope;
- Metasploit permissions;
- cloud scope details;
- AD scope details;
- browser observations;
- API schemas;
- uploaded docs;
- skill library references;
- reporting requirements.

### 12.4. Candidate finding ingestion

Decepticon candidate finding must be normalized to:

- candidate type;
- affected target;
- source agent role;
- chain stage;
- evidence refs;
- replay plan;
- ATT&CK mapping if provided;
- confidence;
- severity suggestion;
- raw engine message pointer.

### 12.5. Neo4j graph export

Graph export must support:

- nodes: assets, identities, vulnerabilities, credentials if allowed, cloud resources, attack steps, defensive controls;
- edges: discovered, exploited, validated, mitigated_by, depends_on, leads_to;
- export formats: JSON for UI, image/SVG/PNG for report, raw dump for internal debugging.

## 13. Scope Enforcement Specification

### 13.1. Effective scope computation

Effective scope is computed from:

- project targets;
- assessment selected targets;
- allow rules;
- deny rules;
- verified tool catalog;
- assessment flags;
- time window;
- tenant policies;
- platform policies.

Deny rules override allow rules.

### 13.2. URL normalization

Scope engine must normalize:

- scheme;
- hostname punycode;
- default ports;
- path traversal segments;
- query handling;
- redirects;
- trailing dots;
- IPv4 / IPv6 formats.

Redirect handling:

- follow redirect only if destination is in scope or allow-visit list;
- store redirect chain;
- block cross-scope redirect by default.

### 13.3. DNS and IP resolution

For domain targets:

- resolve DNS before network execution;
- detect private IP resolution;
- detect loopback / link-local / metadata IP;
- block SSRF-like unsafe destinations unless the target itself is explicitly that internal asset.

### 13.4. Tool policy

Tool execution requires:

- tool is globally allowed;
- tool is allowed for tenant;
- tool is allowed for assessment;
- tool category matches scope flags;
- target matches scope;
- current time is within testing window;
- rate limits allow execution.

### 13.5. Audit event for denied action

Every denied action must record:

- actor service;
- attempted tool;
- target;
- reason;
- scope rule that denied it;
- assessment id;
- timestamp.

## 14. Validation Specification

### 14.1. Validation principles

Validation must prove vulnerability with minimum side effects.

Validator must prefer:

- non-destructive payloads;
- read-only proof;
- benign callback proof;
- controlled canary files;
- safe arithmetic command for RCE only when allowed;
- browser-contained proof for XSS.

### 14.2. XSS validator

Inputs:

- target URL;
- parameter / DOM sink;
- payload candidate;
- browser context;
- expected execution signal.

Proof methods:

- JavaScript callback to controlled marker;
- DOM mutation with nonce;
- alert interception only as weak fallback;
- console event;
- network callback to OOB endpoint.

Confirmed when:

- payload executes in browser context;
- execution is tied to tested parameter / sink;
- evidence includes screenshot or trace;
- replay is reproducible.

Rejected when:

- payload reflected but not executed;
- execution requires out-of-scope navigation;
- browser blocks payload due to unrelated policy;
- replay not reproducible.

### 14.3. SSRF validator

Inputs:

- target endpoint;
- suspected URL parameter / body field;
- OOB token;
- allowed callback domain.

Proof methods:

- DNS callback;
- HTTP callback;
- unique path token;
- timing proof only as weak fallback.

Confirmed when:

- OOB event includes unique token;
- event timestamp correlates with request;
- source metadata supports target-origin request;
- replay is reproducible or strong single-shot proof exists.

Safety:

- block metadata IP targets unless explicitly approved;
- do not request internal sensitive endpoints by default;
- use benign OOB endpoint.

### 14.4. File-read validator

Inputs:

- endpoint;
- parameter;
- suspected traversal or read primitive;
- safe canary path or known low-risk file.

Proof methods:

- controlled uploaded canary file;
- application-owned readable file;
- low-risk OS marker only if RoE allows.

Confirmed when:

- response contains expected canary content;
- content not obtainable through normal route;
- request / response pair is preserved.

Safety:

- avoid `/etc/passwd` default proof unless explicitly allowed;
- avoid secrets;
- redact content in evidence if sensitive.

### 14.5. RCE validator

Inputs:

- endpoint;
- injection point;
- candidate command or expression;
- allowed execution policy.

Proof methods:

- safe arithmetic output;
- echo nonce;
- OOB callback;
- temp file canary only if file modification allowed.

Confirmed when:

- command execution is tied to injection point;
- output or callback includes nonce;
- replay is reproducible;
- side effect risk is acceptable.

Safety:

- no reverse shell;
- no persistence;
- no credential access;
- no destructive command;
- no lateral movement;
- no file modification unless explicitly approved.

## 15. Frontend Product Specification

### 15.1. Navigation structure

Primary sections:

- Dashboard;
- Projects;
- Targets;
- Assessments;
- Findings;
- Evidence;
- Reports;
- Skill Library;
- Tool Policy;
- Audit Log;
- Settings.

### 15.2. Dashboard

Dashboard must show:

- active assessments;
- findings by severity;
- validation queue;
- recent OOB events;
- engine health;
- cost analytics summary;
- top vulnerable targets;
- assessment timeline summary.

### 15.3. Project view

Project view must show:

- project metadata;
- target inventory;
- assessment history;
- open findings;
- risk trend;
- reports;
- owners.

### 15.4. Assessment builder

Assessment builder must support:

- selecting targets;
- defining scope rules;
- defining exclusions;
- selecting testing window;
- selecting profile;
- selecting LLM profile;
- selecting tool policy;
- declaring foothold / post-exploit permissions as part of target authorization;
- uploading OpenAPI docs;
- uploading contextual docs;
- adding credentials / login recipes;
- submitting for approval.

Safety UX:

- high-impact tool categories must be visibly marked;
- C2 / post-exploit / Metasploit usage must show verified target authorization and active scope before execution;
- effective scope preview must be shown before start.

### 15.5. Live assessment view

Live assessment view must show:

- current status;
- Decepticon agent phase;
- timeline;
- running jobs;
- candidate findings count;
- confirmed findings count;
- browser crawl progress;
- HTTP recon progress;
- cyberstrike tool runs;
- validator queue;
- kill-switch state;
- pause / resume / cancel controls;
- HITL approvals when needed.

### 15.6. Attack graph view

Attack graph view must show:

- discovered assets;
- vulnerabilities;
- attack steps;
- validated exploit paths;
- defensive recommendations;
- filters by severity / phase / source;
- replay step details.

### 15.7. Finding detail view

Finding detail must show:

- title;
- severity;
- confidence;
- status;
- affected asset;
- affected endpoint;
- impact;
- reproduction steps;
- evidence;
- validation log;
- attack techniques;
- NIST CSF mappings;
- remediation;
- retest action;
- comments / triage history.

### 15.8. Evidence viewer

Evidence viewer must support:

- screenshots;
- HTTP request / response diff;
- HAR summary;
- Playwright trace link;
- command output;
- OOB callback details;
- redaction state;
- artifact hash.

### 15.9. Skill library UI

Skill library UI must support:

- search;
- filters by domain / tag / framework;
- audit status;
- source commit display;
- mapping display;
- skill body preview;
- import and audit workflow for admins.

### 15.10. Tool policy UI

Tool policy UI must support:

- global verified tool catalog;
- tenant catalog access;
- assessment effective catalog access;
- unavailable tool explanations when credentials, target authorization, time window or regional policy is missing;
- high-risk category labels;
- audit history.

## 16. Reporting Specification

### 16.1. Report types

Required report types:

- executive summary;
- technical pentest report;
- compliance mapping report;
- evidence archive;
- retest report;
- partial interrupted assessment report.

### 16.2. Required report sections

Technical report must include:

- engagement metadata;
- RoE summary;
- scope;
- exclusions;
- testing window;
- methodology;
- tool policy summary;
- Decepticon OPPLAN summary;
- findings summary;
- confirmed findings detail;
- evidence per finding;
- attack graph;
- Offensive Vaccine recommendations;
- remediation roadmap;
- framework mappings;
- appendix with tool versions and audit metadata.

### 16.3. Russian market templates

Phase 2+ templates:

- Russian-language report;
- GOST R oriented template;
- FSTEC-oriented mapping appendix where applicable;
- customer-ready PDF with evidence appendix.

### 16.4. Report generation rules

Rules:

- only confirmed findings in main body;
- candidate findings excluded unless appendix requested;
- raw secrets redacted;
- artifact hashes included;
- framework mappings include source and confidence;
- report snapshot immutable after generation.

## 17. Security Requirements

### 17.1. Authentication

Required:

- email/password or SSO-ready architecture;
- MFA support;
- secure session handling;
- password reset;
- account lockout / throttling.

### 17.2. Authorization

RBAC must enforce:

- tenant isolation;
- project-level access;
- assessment operation permissions;
- tool policy permissions;
- report download permissions;
- audit log access restrictions.

### 17.3. Secrets management

Secrets include:

- LLM API keys;
- target credentials;
- browser session cookies;
- cloud credentials;
- OOB tokens;
- signing keys.

Requirements:

- encrypt at rest;
- never log plaintext;
- scope to tenant and assessment;
- rotate where possible;
- delete after retention period;
- display only masked values.

### 17.4. Supply chain controls

Required:

- pinned Decepticon commit;
- pinned cyberstrike-runner commit;
- pinned skill library commit;
- mirrored images in Yandex Container Registry;
- image digest deployment;
- quarterly upstream review;
- SBOM where feasible;
- no auto-pull from upstream main.

### 17.5. Network controls

Required:

- K8s network policies;
- private namespaces;
- egress firewall;
- deny PRC endpoints for CyberStrike defaults unless customer-supplied credentials and regional/data-transfer approval exist;
- deny arbitrary internet from sandbox except target scope and required services;
- allow LLM gateway only through controlled endpoint.

### 17.6. Audit logging

Audit all:

- login / logout;
- assessment approval;
- start / pause / resume / cancel;
- scope changes;
- tool policy changes;
- high-impact tool authorization changes;
- finding status changes;
- report generation;
- denied tool calls;
- LLM provider fallback;
- secret access.

Audit event fields:

- actor user or service;
- tenant;
- project;
- assessment;
- action;
- resource type;
- resource id;
- before / after metadata where safe;
- IP / user agent for user actions;
- timestamp;
- trace id.

## 18. Compliance Requirements

### 18.1. 152-FZ posture

Personal data and customer data must remain in Yandex Cloud managed services unless tenant explicitly opts into external processing.

External LLM use must be documented:

- provider;
- data sent;
- retention controls;
- redaction controls;
- enterprise exception path.

### 18.2. Data retention

Default:

- hot Object Storage: 90 days;
- cold retention: 1 year;
- truncation / deletion after retention unless contract overrides;
- audit events retained according to legal policy.

### 18.3. Framework mappings

Findings and skills should support:

- MITRE ATT&CK;
- NIST CSF;
- MITRE ATLAS;
- MITRE D3FEND;
- NIST AI RMF.

Mapping quality:

- audited skills require spot-check;
- compliance report must expose mapping source;
- uncertain mapping must not be presented as authoritative.

## 19. Observability Specification

### 19.1. Telemetry

Use OpenTelemetry for:

- API requests;
- queue jobs;
- worker execution;
- Decepticon command dispatch;
- validator replay;
- report build;
- LLM calls;
- object storage operations.

Trace context must propagate through:

- API;
- queue envelope;
- coordinator;
- worker;
- validator;
- report builder.

### 19.2. Metrics

Required metrics:

- active assessments;
- queued assessments;
- assessment duration;
- worker job duration;
- worker failure rate;
- validator confirmation rate;
- candidate-to-confirmed ratio;
- findings by severity;
- Decepticon heartbeat latency;
- LLM calls by model;
- LLM cost by assessment;
- fallback count;
- denied scope actions;
- OOB callbacks count.

### 19.3. Alerts

Required alerts:

- Decepticon heartbeat missing;
- worker failure spike;
- validator failure spike;
- out-of-scope attempts spike;
- LLM provider outage;
- object storage write failure;
- queue backlog;
- assessment stuck beyond guard;
- K8s namespace cleanup failure.

### 19.4. Sentry

Use Sentry for:

- frontend exceptions;
- backend unhandled errors;
- worker exceptions;
- source maps;
- release tracking.

Do not send secrets or raw customer evidence to Sentry.

## 20. Deployment Specification

### 20.1. Environments

Required environments:

- `local`;
- `dev`;
- `staging`;
- `production`;
- `internal-lab`.

### 20.2. Kubernetes layout

Namespaces:

- `platform-public`;
- `platform-private`;
- `platform-observability`;
- one `assessment-{id}` namespace per running assessment.

Deployments:

- web;
- api;
- coordinator;
- http-worker;
- browser-worker;
- cyberstrike-worker;
- validator-worker;
- oob;
- report-builder;
- llm-gateway.

Assessment namespace:

- Decepticon engine;
- Kali sandbox;
- LiteLLM proxy if per-assessment;
- Neo4j if per-assessment;
- network policies;
- secrets;
- resource quotas.

### 20.3. Resource quotas

Each assessment namespace must define:

- CPU limit;
- memory limit;
- pod count limit;
- storage limit;
- network policy;
- max runtime.

### 20.4. Image policy

Images must be:

- built by CI;
- scanned;
- pushed to Yandex Container Registry;
- deployed by digest;
- pinned for third-party mirrors.

### 20.5. Rollout strategy

Product services:

- rolling deploy;
- health checks;
- readiness probes;
- rollback on failed health.

Assessment engine:

- no in-place version change during active assessment unless emergency;
- new assessments use new engine version;
- active assessments keep pinned image.

## 21. Development Phases

### 21.1. Phase 1 — Foundation

Deliverables:

- API skeleton;
- auth;
- multi-tenancy;
- projects CRUD;
- targets CRUD;
- assessments CRUD;
- scope rules;
- DB schema;
- audit events;
- skill library import pipeline;
- 50-100 audited skills;
- skill retrieval API;
- verified tool catalog model.

Acceptance:

- tenant isolation tests pass;
- CRUD tests pass;
- scope validation tests pass;
- skill search works by domain / tag / framework;
- audited skill records store source commit.

### 21.2. Phase 2 — Decepticon integration

Deliverables:

- Decepticon K8s deployment;
- dual-network isolation;
- LiteLLM hybrid config;
- coordinator lifecycle;
- Decepticon session table;
- start / stop / status integration;
- scope overlay;
- reliability guards;
- LLM audit events;
- A/B harness skeleton.

Acceptance:

- assessment starts Decepticon instance;
- health is visible in UI/API;
- out-of-scope engine action is denied;
- LLM calls are audited;
- engine can be stopped and cleaned up.

### 21.3. Phase 3 — Browser-first signal

Deliverables:

- browser-worker;
- Playwright execution;
- login flows;
- authenticated crawl;
- screenshots;
- HAR;
- traces;
- browser observations;
- feed browser context to Decepticon.

Acceptance:

- authenticated test app crawl works;
- screenshots and traces stored;
- browser scope enforcement tested;
- browser observation appears in assessment timeline.

### 21.4. Phase 4 — HTTP signal

Deliverables:

- http-worker;
- OpenAPI ingestion;
- route extraction;
- request replay;
- Nuclei baseline adapter;
- OOB precheck integration.

Acceptance:

- OpenAPI routes imported;
- HTTP probes obey scope;
- Nuclei output normalized;
- candidate findings generated where applicable.

### 21.5. Phase 5 — CyberStrike supplementary tools

Deliverables:

- cyberstrike-runner image;
- pinned commit mirror;
- custom MCP config;
- cyberstrike-worker;
- curated YAML import;
- verified catalog enforcement;
- PRC/provider egress verification based on customer-supplied credentials and regional/data-transfer policy.

Acceptance:

- allowed tool runs successfully;
- unverified tool execution is denied;
- out-of-scope target is denied;
- output normalized to observations;
- integration tests cover curated tool schema.

### 21.6. Phase 6 — Validation

Deliverables:

- OOB service;
- xss-validator;
- ssrf-validator;
- file-read-validator;
- rce-validator;
- validator queue;
- candidate-to-finding pipeline;
- Offensive Vaccine integration.

Acceptance:

- confirmed XSS requires browser replay evidence;
- SSRF proof correlates with OOB token;
- rejected candidate is not published;
- confirmed finding has evidence package.

### 21.7. Phase 7 — Reporting

Deliverables:

- findings UX;
- evidence viewer;
- report builder;
- PDF template;
- Russian report template;
- GOST R / FSTEC-oriented appendices;
- attack graph export;
- evidence archive.

Acceptance:

- report generated from confirmed findings;
- evidence links work;
- attack graph appears;
- framework mappings included;
- report snapshot immutable.

## 22. Test Strategy

### 22.1. Unit tests

Required coverage:

- scope normalization;
- allow / deny rule precedence;
- URL and IP parsing;
- RBAC checks;
- assessment state transitions;
- verified tool catalog decisions;
- validator result classification;
- skill frontmatter parser;
- framework mapping indexing.

### 22.2. Integration tests

Required integration tests:

- API + DB CRUD;
- API + queue enqueue;
- coordinator + fake Decepticon;
- worker + object storage;
- cyberstrike-worker + mock MCP runner;
- browser-worker + test app;
- validator-worker + vulnerable fixture app;
- report-builder + sample finding.

### 22.3. End-to-end tests

Required E2E scenarios:

- create project -> target -> assessment -> approve -> run -> validate -> report;
- out-of-scope target blocked at worker;
- unverified tool execution denied;
- browser authenticated finding validated;
- SSRF OOB callback validated;
- assessment pause / resume;
- assessment cancel cleanup.

### 22.4. Lab targets

Internal lab should include:

- OWASP Juice Shop;
- DVWA;
- VAmPI;
- intentionally vulnerable SSRF fixture;
- intentionally vulnerable XSS fixture;
- simple cloud misconfiguration fixture;
- AD lab for validating ownership-verified AD workflows.

### 22.5. Security tests

Required:

- tenant isolation tests;
- IDOR tests;
- auth bypass tests;
- secret leakage tests;
- SSRF in platform API tests;
- artifact access control tests;
- queue tenant-context tests;
- audit log tamper tests.

### 22.6. Performance tests

Required:

- concurrent assessments scheduling;
- worker queue throughput;
- browser crawl resource usage;
- object storage artifact volume;
- report generation with large evidence set;
- LLM audit insert throughput.

## 23. Acceptance Criteria

### 23.1. MVP acceptance

MVP is acceptable when:

- users can create project / target / assessment;
- scope can be defined and enforced;
- Decepticon instance can start and stop per assessment;
- browser-worker can crawl authenticated target;
- HTTP-worker can ingest OpenAPI and probe routes;
- at least one validator confirms a real finding;
- confirmed finding appears in UI;
- report can be generated;
- audit logs exist for critical actions;
- tenant isolation tests pass.

### 23.2. Production readiness acceptance

Production readiness requires:

- all MVP criteria;
- Yandex K8s deployment;
- managed Postgres;
- object storage artifacts;
- queue-based workers;
- network policies;
- pinned third-party images;
- LLM audit trail;
- Sentry / OpenTelemetry;
- backup and retention policy;
- report templates;
- documented operating runbooks;
- security review.

### 23.3. Enterprise readiness acceptance

Enterprise readiness requires:

- data residency mode;
- self-host DeepSeek / K2.6 option;
- advanced RBAC;
- SSO if required;
- detailed audit export;
- custom report templates;
- strict tool policy per tenant;
- formal supply-chain review;
- contract-specific RoE workflow;
- ownership-verified post-exploit mode.

## 24. Open Questions and Decisions Needed

### 24.1. Decepticon API stability

Decision needed:

- use stable Decepticon API if available;
- otherwise build wrapper over Docker/K8s/logs.

Impact:

- affects coordinator complexity;
- affects reliability of pause / resume / finding ingestion.

### 24.2. Neo4j hosting model

Decision needed:

- self-host Neo4j per assessment namespace;
- shared Neo4j with tenant / assessment isolation;
- managed compatible alternative if available.

Default v1 recommendation:

- self-host per assessment or per isolated namespace until isolation requirements are clearer.

### 24.3. Sliver and C2 authorization behavior

Decision needed:

- configure Decepticon so Sliver/C2 tooling is available in the verified tool catalog;
- ensure every Sliver/C2 execution is bound to authenticated user, verified target ownership, active assessment scope and audit logging;
- patch Decepticon if it cannot expose this policy boundary cleanly.

Requirement:

- product must not expose C2 behavior to unauthenticated users, unverified targets or out-of-scope assets.

### 24.4. CyberStrike verified catalog mechanics

Decision needed:

- use custom MCP config if supported;
- fork cyberstrike-runner if verified-catalog enforcement cannot be implemented externally.

Requirement:

- full catalog access must be technically bound to registration, authentication, ownership verification, active scope and audit logging, not only documented.

### 24.5. Skill library audit scope

Decision needed:

- exact first 50-100 skills;
- audit rubric;
- owner;
- quarterly update process.

Requirement:

- no unaudited skill should influence compliance report as authoritative mapping.

### 24.6. Model mapping validation

Decision needed:

- define lab benchmark harness;
- compare per-agent model outcomes;
- tune production mapping quarterly.

Metrics:

- confirmed finding count;
- false positive rate;
- validator rejection rate;
- time to first confirmed finding;
- token cost;
- fallback rate.

## 25. Risk Register

### 25.1. Offensive misuse risk

Risk:

- platform capabilities can be misused outside authorized scope.

Mitigations:

- strict scope enforcement;
- audit logs;
- ownership verification;
- scope-bound high-impact tools;
- tenant contracts;
- no unauthenticated or out-of-scope C2;
- deterministic validators with safety checks.

### 25.2. Supply-chain risk

Risk:

- Decepticon / CyberStrikeAI / skill library upstream changes or reputation issues.

Mitigations:

- pinned commits;
- mirrored images;
- quarterly review;
- no auto-update;
- brand distance for CyberStrikeAI;
- source audit.

### 25.3. LLM reliability risk

Risk:

- agents hallucinate, loop, or propose unsafe actions.

Mitigations:

- deterministic validation;
- scope enforcement before tools;
- reliability guards;
- vendor-diverse verifier;
- audit logs;
- A/B harness.

### 25.4. Data residency risk

Risk:

- external LLM APIs may process sensitive customer data.

Mitigations:

- configurable retention;
- redaction;
- self-host open-weight phase;
- enterprise disclosure;
- provider audit.

### 25.5. Multi-tenancy isolation risk

Risk:

- cross-tenant data leakage through API, queue, artifacts, or engine.

Mitigations:

- tenant_id everywhere;
- object key tenant prefix;
- signed artifact access;
- queue envelope tenant context;
- assessment namespace isolation;
- security tests.

## 26. Implementation Principles

### 26.1. Keep the coordinator thin

Coordinator orchestrates lifecycle and policy. It must not grow into a second pentest engine.

### 26.2. Prefer evidence over model judgment

LLM output can suggest hypotheses, but evidence and validators decide publication.

### 26.3. Prefer verified catalog and scoped execution

After ownership verification, the full tool catalog is available. Execution remains default-deny for unauthenticated users, unverified targets, out-of-scope destinations, missing credentials, disallowed egress regions and expired testing windows.

### 26.4. Preserve auditability

Every important decision must be reconstructable:

- who approved scope;
- which tool ran;
- why it was allowed;
- what evidence was generated;
- how finding was validated;
- which model made which suggestion.

### 26.5. Avoid vendor lock-in in code

Model routing must remain config-driven through LiteLLM / gateway.

### 26.6. Separate raw signal from confirmed truth

Observations, candidates, validations and findings must remain separate data layers.

## 27. Glossary

- Assessment — controlled test run against authorized targets.
- Candidate finding — suspected vulnerability awaiting deterministic validation.
- Finding — confirmed vulnerability with evidence.
- Evidence — immutable proof artifact.
- OPPLAN — operations plan.
- RoE — rules of engagement.
- ConOps — concept of operations.
- OOB — out-of-band callback proof.
- Scope rule — allow/deny rule defining legal test boundary.
- Tool catalog — verified list of tools available to authenticated users after ownership verification and bound to assessment scope.
- Decepticon session — isolated engine instance for one assessment.
- Offensive Vaccine — attack -> defend -> verify loop.
- Browser-first — browser runtime is primary signal source for web apps.
- Deterministic validator — replay logic that confirms or rejects candidate findings without relying on LLM judgment.
