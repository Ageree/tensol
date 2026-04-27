# План реализации CyberStrike Hybrid

Источник плана:
- `PROJECT-SPECS-cyberstrike-hybrid.md` — продуктовые правила, архитектура, доменная модель, API, очереди, воркеры, security, deployment, тесты и acceptance criteria.
- `STACK-cyberstrike-hybrid.md` — выбранный стек, external components, phased roadmap, supply-chain constraints и открытые решения.

## 1. Цель реализации

Построить multi-tenant SaaS / private-cloud платформу для authorized autonomous pentest / adversary emulation в owned или явно разрешенных средах. Система должна объединять:

- Decepticon как автономное pentest-ядро с kill chain, OPPLAN / RoE / ConOps, Neo4j attack graph и Offensive Vaccine loop.
- Собственный product layer: tenancy, auth, projects, targets, assessments, scope enforcement, queue orchestration, validation, findings, evidence, reporting, audit, compliance.
- Browser-first signal через Playwright как primary signal для web assessments.
- HTTP worker и CyberStrike curated tools как supplementary signal.
- Deterministic validators как обязательный gate перед публикацией findings.
- Hybrid LLM routing через LiteLLM / llm-gateway: Opus для reasoning-heavy ролей, DeepSeek для cost-heavy ролей, Kimi K2.6 для verifier diversity.
- Yandex Cloud deployment с managed PostgreSQL, Message Queue, Object Storage, Container Registry, Managed Kubernetes и Application Load Balancer.

## 2. Непереговорные инварианты

1. Scope-first execution:
   - Любое действие перед выполнением проходит scope enforcement.
   - Проверка применяется на API, coordinator dispatch, worker execution, Decepticon overlay, cyberstrike-runner policy, outbound egress, validator replay и report publication.
   - Deny override allow.
   - Out-of-scope действие не ретраится автоматически и фиксируется в audit event.

2. Findings only after deterministic validation:
   - Все LLM / scanner / agent findings сначала являются candidate findings.
   - UI и reports по умолчанию показывают только confirmed findings.
   - Candidate может попасть только в operator appendix по явному запросу.

3. Browser-first for web:
   - Для web_app assessments browser-worker является primary signal source.
   - HTTP / scanners дополняют browser evidence, но не заменяют его.

4. Ownership-verified high-impact tools:
   - High-impact tooling доступен не по категории, а по факту: authenticated user, verified ownership / authorization, active approved assessment, target in scope, allowed time window, allowed tool policy, audit logging.
   - Sliver / C2 / reverse shell / webshell / metasploit / credential audit / AD flows не должны быть доступны unauthenticated, unverified или out-of-scope.

5. Cost caps не блокируют assessment:
   - Cost tracking, analytics и anomaly alerts допустимы.
   - Assessment не останавливается только из-за budget cap.

6. Auditability:
   - Каждое security-relevant решение реконструируемо: кто, что, когда, почему было разрешено или запрещено, какие evidence созданы, какой validator подтвердил, какая модель участвовала.

## 3. Архитектурная декомпозиция

### 3.1. Monorepo layout

Рекомендуемая структура:

```text
apps/
  web/                 React + Vite SPA
  api/                 Hono + Bun product API
services/
  coordinator/         assessment lifecycle and orchestration
  http-worker/         HTTP probing, OpenAPI, OOB prechecks
  browser-worker/      Playwright browser-first signal
  cyberstrike-worker/  MCP client + curated tool execution
  validator-worker/    deterministic validators
  report-builder/      PDF/HTML/JSON/evidence archive
  llm-gateway/         LiteLLM audit wrapper and analytics
packages/
  config/              shared config loader
  contracts/           zod/openapi DTOs, queue envelopes, event schemas
  db/                  schema, migrations, repositories
  authz/               RBAC, tenancy guard, ownership checks
  scope-engine/        normalization, effective scope, allow/deny decisions
  audit/               append-only audit helpers
  object-storage/      artifact API
  queue/               Yandex MQ abstraction and local adapter
  telemetry/           OpenTelemetry, Sentry setup
  validators/          shared validator primitives
  reports/             report domain models/templates
  skill-library/       skill parser, importer, framework mapping index
infra/
  docker/
  k8s/
  terraform-or-pulumi/
  litellm/
  cyberstrike/
  decepticon/
tests/
  fixtures/
  integration/
  e2e/
  lab/
docs/
  runbooks/
  adr/
```

Правило: общая бизнес-логика lives in packages; сервисы тонкие, запускают use cases и публикуют telemetry.

### 3.2. Service responsibility boundaries

- `api`: auth, tenant resolution, RBAC, CRUD, state-changing commands, idempotency, audit events, queue enqueue.
- `coordinator`: assessment state machine, Decepticon lifecycle, scope overlay, OPPLAN input, worker dispatch, mission state, reliability guards, cleanup.
- `decepticon-engine`: isolated runtime per assessment; не расширяется продуктовой логикой.
- `llm-gateway`: audit + tagging + retention policy + cost analytics + fallback visibility; не принимает product decisions.
- `browser-worker`: Playwright crawl / auth / traces / HAR / DOM / JS evidence.
- `http-worker`: HTTP probing, OpenAPI route extraction, safe prechecks, request replay, Nuclei adapter.
- `cyberstrike-worker`: MCP invocation over verified catalog only; normalizes output.
- `validator-worker`: deterministic replay and finding publication gate.
- `oob`: self-hosted Interactsh event correlation.
- `report-builder`: immutable reports and evidence archives.

## 4. Foundation phase

### 4.1. Repository and tooling

Deliverables:
- Initialize Bun workspace with TypeScript strict mode.
- Add shared lint, format, typecheck, test commands.
- Add local env profiles: `local`, `dev`, `staging`, `production`, `internal-lab`.
- Add typed config validation with fail-fast startup.
- Add Docker Compose for local development only: Postgres, object-storage emulator, queue emulator, mock Decepticon, mock MCP runner.
- Add CI jobs: lint, typecheck, unit tests, migration check, image build, SBOM/scanning placeholder.

Acceptance:
- `bun install`, `bun run lint`, `bun run typecheck`, `bun test` work from repo root.
- Service config refuses to boot with missing secrets in non-local env.
- CI can build every service image independently.

### 4.2. Database schema and migrations

Implement migrations for:
- `tenants`
- `users`
- `projects`
- `targets`
- `assessments`
- `assessment_scope_rules`
- `assessment_artifacts`
- `decepticon_sessions`
- `jobs`
- `candidate_findings`
- `findings`
- `finding_evidence`
- `observations_http`
- `observations_browser`
- `observations_cyberstrike`
- `observations_decepticon`
- `oob_events`
- `skill_library`
- `framework_mappings`
- `tool_catalog`
- `llm_audit_events`
- `audit_events`
- `reports`

Schema rules:
- Every tenant-owned table has `tenant_id`, `created_at`, `updated_at`, tenant index, tenant-scoped unique constraints.
- Append-only tables use insert-only repositories: audit events, LLM audit events, raw evidence metadata, OOB events, validator logs, report snapshots.
- Large payloads never go inline in Postgres; only metadata + object key + sha256.
- Use explicit status enums for assessment, candidate validation, findings, skill audit, tool policy.
- Add optimistic version columns where concurrent updates are expected: assessments, targets, tool policy, scope rules.

Acceptance:
- Migration applies from empty DB and rolls forward in CI.
- Tenant isolation query tests fail closed if tenant context is absent.
- Append-only repository tests reject update/delete code paths.

### 4.3. Auth, tenancy and RBAC

Implement:
- Email/password login, logout, session handling.
- SSO-ready provider abstraction, but SSO can remain disabled in MVP.
- MFA enable/verify flow.
- Password reset request/confirm.
- User roles: platform_admin, tenant_admin, security_lead, operator, developer, auditor, viewer.
- Tenant resolver middleware.
- RBAC policy matrix for projects, targets, assessments, findings, evidence, reports, skills, tool catalog, audit logs.
- Project-level membership / access model if needed before enterprise.

Acceptance:
- Auth endpoints covered by integration tests.
- IDOR tests prove users cannot read or mutate cross-tenant resources.
- Auditor can read reports/audit but cannot start assessments.
- Developer can read assigned findings but cannot change scope or tool policy.

### 4.4. Audit subsystem

Implement:
- `audit_events` append-only writer.
- Standard event envelope: actor, tenant, project, assessment, action, resource type/id, safe before/after metadata, IP/user-agent, trace_id, timestamp.
- Mandatory audit middleware for state-changing API actions.
- Service actor model for coordinator/workers.
- Denied-action audit helper used by scope engine and tool policy.

Acceptance:
- Login/logout, assessment approval, start/pause/resume/cancel, scope changes, tool policy changes, high-impact tool authorization changes, finding status changes, report generation, denied tool calls, LLM fallback and secret access all produce audit events.

### 4.5. Projects, targets and assessments CRUD

Implement endpoints:
- Projects: list/create/get/update/delete/summary.
- Targets: list/create/get/update/delete/ownership-proof/observations.
- Assessments: list/create/get/update/submit/approve/start/pause/resume/cancel/status/timeline/artifacts/engine.

Assessment state machine:
- Enforce all documented transitions.
- Use idempotency keys for start, pause, resume, cancel.
- Require approval before enqueueing `assessment.start`.
- Require target ownership proof before high-impact categories become available.

Acceptance:
- Invalid transitions are rejected with typed errors.
- Replayed idempotency keys return stable result.
- Assessment cannot start outside approved state.
- Assessment cannot include unverified high-impact permissions.

## 5. Scope engine phase

### 5.1. Effective scope computation

Implement `packages/scope-engine`:
- Inputs: project targets, selected assessment targets, allow rules, deny rules, verified tool catalog, assessment flags, time window, tenant policy, platform policy.
- Outputs: effective normalized scope and decision API.
- Deny rules override allow rules.
- Decision includes: allowed boolean, reason, matching allow/deny rule ids, normalized target, tool policy result, time window result.

Rule types:
- domain, subdomain, url_prefix, ip, cidr, port, protocol, cloud_account, kubernetes_namespace, repository, time_window, rate_limit, tool_category, tool_name, http_method, path_pattern.

Acceptance:
- Unit tests cover normalization, allow/deny precedence, time window, rate limits, tool category flags, cloud/ad/post-exploit/c2 flags.

### 5.2. URL / DNS / IP normalization

Implement:
- Scheme normalization.
- Hostname punycode and trailing dot handling.
- Default port normalization.
- Path traversal segment normalization.
- IPv4/IPv6 canonicalization.
- Redirect chain policy.
- DNS resolution before network execution.
- Blocking of loopback, link-local, metadata IP and private IP destinations unless explicitly in scope.

Acceptance:
- SSRF-style unsafe destinations are blocked by default.
- Redirect to cross-scope destination is blocked and audited.
- Domain target resolving to private IP is blocked unless the private IP/CIDR is explicitly authorized.

### 5.3. Scope enforcement integration points

Integrate scope decisions into:
- API `POST /assessments/:id/scope/validate`.
- Coordinator before enqueueing jobs.
- Worker before network/tool execution.
- Decepticon OPPLAN unavailable-tools list.
- Decepticon sandbox egress policy generation.
- CyberStrike MCP invocation guard.
- Validator replay guard.
- Report publication guard.

Acceptance:
- E2E out-of-scope target is blocked at API, worker and validator paths.
- Denied actions are immutable audit events.

## 6. Skill library and framework mappings

### 6.1. Skill import pipeline

Implement:
- Parser for agentskills.io frontmatter + markdown body.
- Source commit capture.
- Import command for pinned upstream snapshot.
- Audit workflow: pending -> approved/rejected/needs_update/deprecated.
- Metadata indexing: domain, subdomain, tags, ATT&CK, D3FEND, NIST CSF, NIST AI RMF, ATLAS.
- Search API by keyword/domain/subdomain/tag/framework/audit status.

MVP import scope:
- 50-100 audited skills, prioritized by web pentest, cloud, AD and threat hunting.
- No unaudited skill may influence authoritative compliance reporting.

Acceptance:
- Skill search works by domain, tag and framework technique.
- Audited skill stores source commit and audit owner/time.
- Compliance report can display mapping source and confidence.

### 6.2. Audit rubric

For every imported skill verify:
- License/source commit captured.
- Commands are current and scoped.
- Prerequisites are explicit.
- Verification section is actionable.
- Framework mappings are spot-checked.
- Dangerous steps are marked as requiring ownership verification and scope.
- Brand display avoids misleading "Anthropic" product endorsement.

Acceptance:
- At least 20% of audited skills have mapping spot-check record before production readiness.

## 7. Tool catalog and CyberStrike policy foundation

Implement:
- `tool_catalog` model with name, category, source, source commit, enabled flag, global/tenant/assessment policy, required credentials, regional egress flags, high-impact flags, parser config, timeout defaults.
- Effective tool catalog endpoint per assessment.
- Unavailable tool explanations: missing credentials, missing ownership proof, missing target authorization, expired testing window, tenant policy, regional/data-transfer restriction.
- Tool policy UI/API for platform and tenant admins.

Acceptance:
- Allowed tool + in-scope target produces allow decision.
- Unknown YAML/tool is denied.
- High-impact category is unavailable until assessment authorization requirements are met.
- PRC/Aliyun/FOFA-like endpoints are denied unless customer/operator credentials and regional approval exist.

## 8. Queue and job system

Implement:
- Queue abstraction with local adapter and Yandex Message Queue adapter.
- Common job envelope with job_id, tenant_id, project_id, assessment_id, kind, idempotency_key, created_at, not_before, attempt, max_attempts, trace_id, payload.
- Queues: assessment.start, decepticon.command, decepticon.findings, recon.http, recon.browser, recon.cyberstrike, attack.http, attack.browser, attack.cyberstrike, validate.finding, report.build.
- Retry classifier: retry transient failures; do not retry scope denial, denied tool, invalid RoE, missing approval, destructive unsafe validation.
- Job table mirror for visibility and timeline.

Acceptance:
- Trace context propagates API -> queue -> coordinator -> worker.
- Queue tenant context tests prevent cross-tenant processing.
- Idempotent commands remain idempotent under duplicate delivery.

## 9. Decepticon integration phase

### 9.1. Deployment adapter

Implement `coordinator` Decepticon adapter:
- Create assessment namespace.
- Apply resource quotas, network policies and secrets.
- Deploy pinned Decepticon image by digest.
- Deploy per-assessment LiteLLM proxy if selected.
- Deploy per-assessment Neo4j if selected.
- Health check.
- Start mission.
- Send command.
- Stream status.
- Stream candidate findings.
- Pause/resume/stop.
- Export graph/logs.
- Destroy/archive namespace.

Fallback if stable Decepticon API is missing:
- Build thin wrapper around supported API/logs first.
- Use log parsing only as compatibility adapter.
- Avoid Docker socket unless no safer control path exists.
- Add integration tests against pinned Decepticon commit.

Acceptance:
- Approved assessment starts one isolated Decepticon instance.
- Engine health is visible through API/UI.
- Engine can stop and namespace cleanup is verified.
- Active assessments keep pinned engine version during rollout.

### 9.2. OPPLAN input contract

Coordinator packages:
- assessment id, targets, authorized scope, exclusions, testing window.
- allowed tools and unavailable tools with reasons.
- engagement profile.
- foothold status.
- post-exploit, C2 and Metasploit permissions derived from ownership verification/scope.
- cloud and AD scope details.
- browser observations and API schemas.
- uploaded docs.
- skill library references.
- reporting requirements.

Acceptance:
- OPPLAN payload is deterministic and stored as artifact.
- Missing authorization appears as unavailable-tool reason, not silent omission.

### 9.3. LiteLLM / llm-gateway

Implement:
- Per-agent role model mapping profiles: production, cost, max, test.
- Fallback chain: Opus -> K2.6 -> DeepSeek V4-Pro.
- Audit event for every LLM call: tenant, project, assessment, session, agent role, provider, model, prompt hash, response hash, token counts, latency, tool calls requested/executed, fallback metadata, retention policy, raw payload pointer if allowed.
- Config-driven model routing; no provider-specific logic in business code.
- Mock/local model mode for CI.

Acceptance:
- LLM calls are audited.
- Fallback events record original model, fallback model, provider error, request id, role, retry count, latency and usage.
- Test profile runs without production API keys.

### 9.4. Reliability guards

Implement:
- Wall-clock timeout default 1800s.
- Max total steps default 4000.
- Per-agent step cap default 100.
- Divergence detector: repeated tool calls with no new observations, repeated same plan, last 50 steps no new evidence, repeated out-of-scope requests, repeated verifier rejection.
- Guard actions: pause stuck agent if supported, inject corrective context if safe, stop assessment if engine cannot be controlled, mark failure with evidence.

Acceptance:
- Simulated stuck engine is paused/stopped and audited.
- Guard state visible in live assessment view.

### 9.5. Candidate finding ingestion

Normalize Decepticon output into `candidate_findings`:
- candidate type, affected target, source agent role, chain stage, evidence refs, replay plan, ATT&CK mapping, confidence, severity suggestion, raw engine message pointer.

Acceptance:
- Candidate is never visible as confirmed finding before validator.
- Missing replay plan routes to needs_human_review/inconclusive, not published.

## 10. Browser-first phase

Implement `browser-worker`:
- Playwright context lifecycle.
- Encrypted credential/auth state handling.
- Login recipe execution.
- Authenticated crawl.
- SPA route discovery.
- DOM inspection, form discovery, JS event path discovery.
- API request observation from browser runtime.
- XSS candidate generation and replay support.
- Screenshot, HAR, trace and optional video artifacts.
- Browser context summary feed to Decepticon.

Safety:
- Every navigation/request obeys scope.
- Session cookies are masked by default.
- Sensitive screenshots/traces are redacted or permission-gated.
- Trace retention follows tenant policy.

Acceptance:
- Authenticated crawl works against lab app.
- Browser observation appears in assessment timeline.
- Screenshot, HAR and trace stored with sha256 metadata.
- Browser scope enforcement has unit and integration tests.

## 11. HTTP signal phase

Implement `http-worker`:
- HTTP probing with throttling.
- OpenAPI/Swagger ingestion.
- Route extraction.
- Request replay.
- SSRF/file-read/RCE prechecks using safe payloads.
- OOB precheck integration.
- Baseline Nuclei adapter.
- Raw request/response evidence capture.

Safety:
- Respect RoE politeness config.
- Redact secrets where possible.
- Never request out-of-scope host.

Acceptance:
- OpenAPI routes become observations.
- Nuclei output normalizes to observations/candidates.
- OOB token correlation works for safe prechecks.

## 12. CyberStrike supplementary tools phase

Implement:
- Pinned cyberstrike-runner image build.
- Mirror to Yandex Container Registry.
- Custom MCP config with verified catalog policy.
- MCP client in Bun worker.
- Curated YAML import for approved tools.
- Parser config per tool family.
- Timeout, RPS and politeness controls.
- Provider egress verification for external intelligence connectors.

Execution flow:
1. Worker receives tool request.
2. Resolve tenant/project/assessment.
3. Resolve effective scope and effective tool catalog.
4. Validate tool, target, args, time window, credentials, egress policy.
5. Invoke MCP runner.
6. Store stdout/stderr/raw output as artifact.
7. Normalize parsed output to observations.
8. Generate candidates only when replay plan/evidence exists.
9. Emit audit event.

Acceptance:
- Allowed in-scope tool runs successfully.
- Unknown/unverified/out-of-scope tool is denied and audited.
- Curated YAML schema integration tests exist.
- High-impact tool request requires verified ownership and assessment scope.

## 13. OOB and validation phase

### 13.1. OOB service

Implement:
- Self-hosted Interactsh.
- Per-assessment callback domains or unguessable tokens.
- DNS/HTTP/SMTP event capture where supported.
- Event correlation with payload ids.
- Immutable `oob_events` storage.
- Evidence export to object storage.

Acceptance:
- SSRF fixture callback correlates to assessment and candidate.
- OOB tokens are tenant-isolated and unguessable.

### 13.2. Validator framework

Implement shared validator contract:
- Inputs: candidate, replay plan, scope, evidence refs, credentials/auth context, side-effect policy.
- Output: status, confidence, proof_type, request_replayable, side_effect_risk, evidence_ids, reason, validated_at.
- Statuses: confirmed, rejected, inconclusive, needs_human_review, out_of_scope.
- All replay inputs/outputs stored as evidence or validator logs.

Hard rule:
- Confirmed finding creation is only done through validator success path.

### 13.3. XSS validator

Implement:
- Browser replay with nonce.
- DOM mutation/console/network callback proof.
- Screenshot or trace evidence.
- Alert interception only as weak fallback.

Confirm when payload executes in browser context, is tied to tested sink/parameter and replay is reproducible.

### 13.4. SSRF validator

Implement:
- OOB DNS/HTTP proof with unique token.
- Timestamp and source metadata correlation.
- Metadata/private endpoint block by default.
- Timing proof only as weak fallback.

### 13.5. File-read validator

Implement:
- Controlled canary file or application-owned low-risk file proof.
- Preserve request/response pair.
- Avoid `/etc/passwd` default unless RoE allows.
- Redact sensitive content.

### 13.6. RCE validator

Implement:
- Safe arithmetic output, echo nonce or OOB callback.
- No reverse shell, persistence, credential access, destructive command or lateral movement.
- File modification only if explicitly approved.

Acceptance:
- Rejected candidates are not published.
- Confirmed XSS requires browser replay evidence.
- SSRF proof correlates with OOB token.
- Confirmed finding contains evidence package, validation log and scope proof.

## 14. Findings, evidence and reporting phase

### 14.1. Findings UX/API

Implement:
- Findings list by assessment/project.
- Finding detail with severity, confidence, status, affected asset/endpoint, impact, reproduction, remediation, evidence, validation log, attack techniques, NIST mappings, retest, comments/history.
- Status workflow: open, triaged, accepted_risk, false_positive, fixed, retested, closed.
- Retest queue.

Acceptance:
- Finding cannot exist without created_from_candidate_id and validation evidence.
- Finding status change is audited.

### 14.2. Evidence viewer

Implement:
- Screenshot viewer.
- HTTP request/response diff.
- HAR summary.
- Playwright trace link.
- Command output viewer.
- OOB callback detail.
- Artifact hash and redaction status.
- Signed, permission-checked artifact access.

Acceptance:
- Cross-tenant artifact access denied.
- Artifact hash shown and matches object storage content.

### 14.3. Report builder

Implement formats:
- PDF.
- HTML.
- JSON.
- Evidence archive ZIP.

Report types:
- executive summary.
- technical pentest report.
- compliance mapping report.
- evidence archive.
- retest report.
- partial interrupted assessment report.

Required sections:
- engagement metadata, RoE summary, scope, exclusions, testing window, methodology, tool policy summary, Decepticon OPPLAN summary, findings summary, confirmed finding detail, evidence per finding, attack graph, Offensive Vaccine recommendations, remediation roadmap, framework mappings, tool versions and audit metadata appendix.

Rules:
- Main report includes confirmed findings only.
- Candidate findings only in operator appendix when requested.
- Secrets redacted.
- Artifact hashes included.
- Mapping source/confidence shown.
- Report snapshot immutable after generation.

Acceptance:
- Report generated from confirmed findings.
- Attack graph export included.
- Russian template and GOST/FSTEC-oriented appendices available by production readiness.
- Report snapshot cannot be mutated; regeneration creates a new snapshot.

## 15. Frontend implementation plan

Build the SPA as an operational console, not a marketing page.

Navigation:
- Dashboard
- Projects
- Targets
- Assessments
- Findings
- Evidence
- Reports
- Skill Library
- Tool Policy
- Audit Log
- Settings

Core screens:
1. Dashboard:
   - active assessments, findings by severity, validation queue, recent OOB events, engine health, cost summary, vulnerable targets, timeline summary.

2. Project view:
   - metadata, target inventory, assessment history, open findings, risk trend, reports, owners.

3. Assessment builder:
   - select targets, define scope/exclusions/window/profile/LLM profile/tool policy.
   - declare foothold/post-exploit permissions.
   - upload OpenAPI/context docs.
   - add credentials/login recipes.
   - effective scope preview before submit/start.
   - visible warnings for high-impact categories.

4. Live assessment view:
   - status, Decepticon phase, timeline, running jobs, candidate/confirmed counts, browser/http/cyberstrike progress, validator queue, kill-switch state, pause/resume/cancel, HITL approvals.

5. Attack graph view:
   - assets, vulnerabilities, attack steps, validated paths, defensive recommendations, filters, replay details.

6. Finding detail:
   - full finding + evidence + validation + mappings + remediation + retest/comments.

7. Evidence viewer:
   - screenshots, request/response, HAR, traces, OOB, command output, hash/redaction.

8. Skill Library:
   - search/filter/audit/source commit/mapping/body preview.

9. Tool Policy:
   - global/tenant/assessment catalogs, unavailable explanations, high-risk labels, audit history.

Frontend acceptance:
- Assessment controls always reflect server state.
- Optimistic UI only for non-critical metadata edits.
- All security-relevant actions call server and produce audit events.
- UI tests cover critical workflows and RBAC visibility.

## 16. Observability and operations

Implement OpenTelemetry traces for:
- API requests, queue jobs, worker execution, Decepticon command dispatch, validator replay, report build, LLM calls, object storage operations.

Metrics:
- active/queued assessments, assessment duration, worker job duration/failure, validator confirmation rate, candidate-to-confirmed ratio, findings by severity, Decepticon heartbeat latency, LLM calls/cost/fallback by model, denied scope actions, OOB callbacks.

Alerts:
- missing Decepticon heartbeat, worker failure spike, validator failure spike, out-of-scope attempts spike, LLM provider outage, object storage write failure, queue backlog, stuck assessment, namespace cleanup failure.

Sentry:
- frontend/backend/worker exceptions, source maps, release tracking.
- no secrets or raw customer evidence.

Runbooks:
- assessment stuck.
- Decepticon crash/restart.
- namespace cleanup failure.
- LLM provider outage.
- object storage failure.
- queue backlog.
- suspected cross-tenant leak.
- supply-chain update.

## 17. Deployment plan

### 17.1. Environments

- `local`: developer loop with emulators and mock engine.
- `dev`: shared integration, non-production keys.
- `staging`: production-like Yandex Cloud, lab targets only.
- `production`: customer workloads.
- `internal-lab`: Juice Shop, DVWA, VAmPI, SSRF/XSS fixtures, cloud fixture, AD lab.

### 17.2. Kubernetes layout

Namespaces:
- `platform-public`: web, api.
- `platform-private`: coordinator, workers, llm-gateway, report-builder, oob.
- `platform-observability`: telemetry stack.
- `assessment-{id}`: Decepticon engine, Kali sandbox, LiteLLM if per-assessment, Neo4j if per-assessment, secrets, quotas, network policies.

Network:
- Public traffic only to ALB -> web/api.
- Product services private.
- Assessment sandbox no direct DB access.
- Sandbox internet egress only through policy and target scope.
- LLM egress only through llm-gateway.

Images:
- Built by CI.
- Scanned.
- Pushed to Yandex Container Registry.
- Deployed by digest.
- Third-party images mirrored and pinned.

Rollout:
- Product services rolling deploy with readiness/health rollback.
- Assessment engine no in-place upgrade during active assessment except emergency.

## 18. Test strategy

Unit:
- scope normalization, allow/deny precedence, URL/IP parsing, RBAC, assessment transitions, tool catalog decisions, validator classification, skill parser, framework mapping indexing.

Integration:
- API+DB CRUD, API+queue, coordinator+fake Decepticon, worker+object storage, cyberstrike-worker+mock MCP, browser-worker+test app, validator+vulnerable fixtures, report-builder+sample finding.

E2E:
- project -> target -> assessment -> approval -> run -> validate -> report.
- out-of-scope blocked.
- unverified tool denied.
- browser authenticated finding validated.
- SSRF OOB callback validated.
- pause/resume.
- cancel cleanup.

Security tests:
- tenant isolation, IDOR, auth bypass, secret leakage, SSRF in platform API, artifact access control, queue tenant context, audit tamper resistance.

Performance:
- concurrent assessment scheduling, worker throughput, browser resource usage, object storage artifact volume, large-evidence report generation, LLM audit insert throughput.

Lab targets:
- OWASP Juice Shop, DVWA, VAmPI, intentionally vulnerable SSRF fixture, intentionally vulnerable XSS fixture, simple cloud misconfiguration fixture, AD lab.

## 19. Phase-by-phase delivery plan

### Phase 0 — Discovery hardening

Goal: retire highest-risk open questions before heavy implementation.

Tasks:
- Inspect pinned Decepticon API surface and lifecycle controls.
- Prototype Decepticon start/status/stop/finding export with fake assessment.
- Decide Neo4j hosting model for v1: default per-assessment namespace unless resource cost blocks.
- Inspect cyberstrike-runner policy extension points.
- Decide whether custom MCP config is enough or fork is required.
- Define first 50-100 skill audit list and rubric.
- Build initial lab benchmark plan for model mapping.

Exit criteria:
- ADRs for Decepticon control, Neo4j hosting, cyberstrike-runner policy, skill audit scope, model validation harness.

### Phase 1 — Foundation

Goal: product control plane with tenancy, auth, scope, data model and audit.

Tasks:
- Repo/tooling/CI.
- DB migrations.
- Auth/MFA/session.
- RBAC/tenant guards.
- Projects/targets/assessments CRUD.
- Scope rules and effective scope.
- Audit subsystem.
- Skill import/search/audit.
- Tool catalog data model.

Exit criteria:
- Tenant isolation tests pass.
- CRUD tests pass.
- Scope validation tests pass.
- Skill search works.
- Audited skills store source commit.

### Phase 2 — Decepticon integration

Goal: approved assessment starts isolated Decepticon runtime under product policy.

Tasks:
- K8s namespace/deployment adapter.
- Dual network isolation.
- LiteLLM hybrid profile config.
- llm-gateway audit wrapper.
- Decepticon session table and lifecycle.
- OPPLAN payload generation.
- Scope overlay and sandbox egress policy.
- Reliability guards.
- Candidate finding ingestion.
- A/B harness skeleton.

Exit criteria:
- Assessment starts/stops engine.
- UI/API shows health.
- Out-of-scope engine action denied.
- LLM calls audited.
- Engine cleanup works.

### Phase 3 — Browser-first signal

Goal: authenticated browser evidence becomes primary web signal.

Tasks:
- Playwright worker.
- Credential/auth state encryption.
- Login recipes.
- Authenticated crawl and SPA route discovery.
- Screenshots/HAR/traces.
- Browser observations.
- Context feed to Decepticon.

Exit criteria:
- Authenticated lab app crawl works.
- Artifacts stored.
- Browser scope enforcement tested.
- Timeline shows browser observations.

### Phase 4 — HTTP signal

Goal: API/HTTP recon and safe prechecks supplement browser signal.

Tasks:
- HTTP worker.
- OpenAPI ingestion and route extraction.
- Request replay.
- Nuclei adapter.
- OOB prechecks.
- Normalization to observations/candidates.

Exit criteria:
- OpenAPI routes imported.
- HTTP probes obey scope.
- Nuclei normalized.
- Candidates generated where applicable.

### Phase 5 — CyberStrike supplementary tools

Goal: curated tool breadth through verified MCP catalog.

Tasks:
- Build/mirror cyberstrike-runner.
- Custom MCP config or fork.
- Import curated YAMLs.
- Bun MCP client.
- Effective catalog enforcement.
- Output parser normalization.
- Egress restrictions for external providers.

Exit criteria:
- Allowed tool runs.
- Unverified/out-of-scope denied.
- Output normalized.
- Curated YAML integration tests pass.

### Phase 6 — Validation

Goal: deterministic replay gates all public findings.

Tasks:
- OOB service.
- Validator framework.
- XSS/SSRF/file-read/RCE validators.
- Candidate-to-finding pipeline.
- Evidence packaging.
- Offensive Vaccine integration into validation/reporting.

Exit criteria:
- Confirmed XSS requires browser replay evidence.
- SSRF proof correlates with OOB.
- Rejected candidate is not published.
- Confirmed finding has evidence package.

### Phase 7 — Reporting and product finish

Goal: customer-ready findings UX and immutable reports.

Tasks:
- Findings UX.
- Evidence viewer.
- Report builder.
- PDF/HTML/JSON/ZIP output.
- Russian template.
- GOST/FSTEC-oriented appendices.
- Neo4j attack graph export.
- Retest report.

Exit criteria:
- Report generated from confirmed findings.
- Evidence links work.
- Attack graph appears.
- Framework mappings included.
- Snapshot immutable.

### Phase 8 — Production readiness

Goal: deployable, observable, supportable Yandex Cloud system.

Tasks:
- Yandex K8s manifests / IaC.
- Managed Postgres, Object Storage, Message Queue.
- Network policies and egress firewall.
- Image scanning/pinning/mirroring.
- Backups and retention.
- Sentry/OpenTelemetry dashboards.
- Alerts.
- Runbooks.
- Security review.
- Performance baseline.

Exit criteria:
- All MVP criteria.
- Production deployment works.
- Pinned images.
- LLM audit trail.
- Backup/retention policy.
- Security review complete.

### Phase 9 — Enterprise readiness

Goal: enterprise controls and data residency path.

Tasks:
- Data residency mode.
- Self-host DeepSeek/K2.6 option.
- Advanced RBAC / SSO.
- Detailed audit export.
- Custom report templates.
- Strict tenant tool policy.
- Formal supply-chain review workflow.
- Contract-specific RoE workflow.
- Ownership-verified post-exploit mode hardening.

Exit criteria:
- Enterprise acceptance criteria satisfied.
- Contract-specific policies enforceable.
- Open-weight model deployment path tested where required.

## 20. Critical ADRs to write early

1. Decepticon control surface:
   - Stable API vs wrapper vs log adapter.
   - Decision affects coordinator complexity and reliability.

2. Neo4j isolation:
   - Per-assessment vs shared isolated graph.
   - Default: per-assessment until resource economics prove otherwise.

3. CyberStrike verified catalog:
   - External policy wrapper vs fork.
   - Requirement: policy enforcement must be technical, not documentation-only.

4. Skill audit scope:
   - First 50-100 skills, rubric, owner, quarterly update.

5. LLM model mapping validation:
   - Lab metrics: confirmed finding count, false positive rate, validator rejection rate, time to first confirmed finding, token cost, fallback rate.

6. External LLM data handling:
   - Retention, redaction, tenant opt-in, enterprise exception path.

7. High-impact authorization:
   - Exact product flags and enforcement points for C2, post-exploit, credential audit and AD workflows.

## 21. Acceptance matrix

MVP complete when:
- User creates project, target and assessment.
- Scope can be defined and enforced.
- Decepticon starts/stops per assessment.
- Browser-worker crawls authenticated target.
- HTTP-worker ingests OpenAPI and probes routes.
- At least one validator confirms a real finding.
- Confirmed finding appears in UI.
- Report can be generated.
- Audit logs exist for critical actions.
- Tenant isolation tests pass.

Production ready when:
- MVP criteria pass.
- Yandex K8s deployment works.
- Managed Postgres/Object Storage/Message Queue integrated.
- Network policies active.
- Third-party images pinned and mirrored.
- LLM audit trail active.
- Sentry/OpenTelemetry active.
- Backup/retention documented.
- Report templates ready.
- Runbooks written.
- Security review complete.

Enterprise ready when:
- Data residency mode exists.
- Self-host DeepSeek/K2.6 path exists.
- Advanced RBAC/SSO available as required.
- Audit export works.
- Custom report templates supported.
- Strict tenant tool policies enforce.
- Formal supply-chain review process exists.
- Contract-specific RoE workflow exists.
- Ownership-verified post-exploit mode is hardened.

## 22. Main risks and mitigations

1. Offensive misuse:
   - Mitigate with scope enforcement, ownership verification, audit logs, high-impact tool binding, deterministic validation and no unauthenticated/out-of-scope C2.

2. Supply chain:
   - Mitigate with pinned commits, mirrored images, quarterly review, no auto-pull, SBOM and brand distance for risky upstreams.

3. LLM reliability:
   - Mitigate with deterministic validators, scope gate before tools, reliability guards, vendor-diverse verifier, audit logs and A/B harness.

4. Data residency:
   - Mitigate with Yandex-managed product data, external LLM disclosure, redaction, configurable retention and self-host phase.

5. Multi-tenancy isolation:
   - Mitigate with tenant_id everywhere, object key tenant prefixes, signed artifact access, queue tenant context, assessment namespace isolation and security tests.

6. Coordinator bloat:
   - Mitigate with explicit boundary: coordinator orchestrates lifecycle/policy only; Decepticon owns pentest reasoning and kill chain.

## 23. Recommended implementation order inside each phase

For every phase:
1. Write contracts first: DTOs, queue payloads, DB schema, state transitions.
2. Write unit tests for policy/state/scope behavior.
3. Implement repositories and service use cases.
4. Add API/worker entrypoints.
5. Add integration tests with fakes/mocks.
6. Add telemetry and audit events.
7. Add UI only after API contract stabilizes.
8. Run E2E against lab target or fixture.
9. Update ADR/runbook if the phase introduced an operational decision.

## 24. Verification commands and gates

Minimum local gate:
- `bun run lint`
- `bun run typecheck`
- `bun test`
- migration apply/check
- targeted integration tests for changed services

Security gate:
- tenant isolation tests
- IDOR tests
- scope denial tests
- artifact authorization tests
- audit append-only tests
- secret redaction tests

Release gate:
- build all images
- image scan
- deploy to staging
- run E2E lab scenario
- run namespace cleanup test
- generate sample report
- verify telemetry dashboards and alerts

## 25. First implementation slice recommendation

Start with a narrow vertical slice:

1. Tenant/auth/project/target/assessment CRUD.
2. Scope engine with URL/domain/IP/time/tool decisions.
3. Queue envelope and `assessment.start`.
4. Fake Decepticon adapter.
5. Browser-worker against a lab XSS fixture.
6. XSS validator.
7. Confirmed finding UI.
8. Minimal report.

Why this slice:
- Exercises the core product promise end-to-end.
- Proves scope-first, browser-first, validation-only and evidence-first.
- Avoids early dependency on unstable Decepticon/CyberStrike integration while contracts are still being hardened.
- Creates regression harness for later real engine integration.

