# User Criteria: cyberstrike-hybrid

## Goal
Реализовать платформу CyberStrike Hybrid — multi-tenant SaaS / private-cloud для authorized autonomous pentest / adversary emulation. Исходный план: `/Users/saveliy/Documents/пентест ИИ/.omx/plans/implementation-cyberstrike-hybrid.md`. Источники продуктовых требований: `PROJECT-SPECS-cyberstrike-hybrid.md` и `STACK-cyberstrike-hybrid.md` в корне репо.

## Implementation Order (First Slice — раздел 25 плана)
1. Tenant / auth / project / target / assessment CRUD
2. Scope engine (URL / domain / IP / time / tool decisions)
3. Queue envelope + `assessment.start`
4. Fake Decepticon adapter
5. Browser-worker против lab XSS fixture (Playwright)
6. XSS validator
7. Confirmed finding UI (React + Vite)
8. Minimal report (PDF/HTML/JSON)

После first slice — продолжать по фазам 0..9 из раздела 19 плана.

## Acceptance Criteria
- Каждый sprint имеет sprint-N-contract.md с конкретными testable критериями.
- Sprint считается PASS только при: проходе lint, typecheck, unit тестов; integration тестов где применимо; tenant isolation тесты не падают.
- Findings only after deterministic validation (инвариант плана раздел 2).
- Scope-first execution на API, coordinator, worker, validator, report.
- Browser-first для web assessments.
- Audit events для всех security-relevant действий.
- 80%+ test coverage (unit + integration + e2e где применимо).
- После каждого PASS-sprint Lead запускает `/codex:adversarial-review` и фиксит найденные баги до следующего sprint.

## Constraints

### Stack (из STACK-cyberstrike-hybrid.md)
- Runtime: Bun (latest stable)
- Language: TypeScript strict mode
- API: Hono
- Frontend: React + Vite SPA
- Database: PostgreSQL (managed Yandex)
- Queue: Yandex Message Queue (с локальным adapter для dev)
- Browser automation: Playwright
- LLM gateway: LiteLLM
- Object storage: S3-совместимый (Yandex Object Storage)
- Pentest engine: Decepticon (pinned image, isolated namespace)

### Repo Layout (план раздел 3.1)
- `apps/web`, `apps/api`
- `services/coordinator`, `services/http-worker`, `services/browser-worker`, `services/cyberstrike-worker`, `services/validator-worker`, `services/report-builder`, `services/llm-gateway`
- `packages/config`, `packages/contracts`, `packages/db`, `packages/authz`, `packages/scope-engine`, `packages/audit`, `packages/object-storage`, `packages/queue`, `packages/telemetry`, `packages/validators`, `packages/reports`, `packages/skill-library`
- `infra/`, `tests/`, `docs/`

Правило: бизнес-логика в `packages/`, сервисы тонкие.

### Hard Invariants (план раздел 2)
1. Scope-first execution. Deny override allow. Out-of-scope не ретраится автоматически.
2. Findings only after deterministic validator success.
3. Browser-first for web assessments.
4. Ownership-verified high-impact tools (C2, post-exploit, AD).
5. Cost caps не блокируют assessment.
6. Auditability: каждое security-relevant решение реконструируемо.

### Agent Tooling (mandatory для всех агентов команды)
- `gitnexus` — навигация по графу кода, impact analysis, exploring, refactoring, debugging.
- `mempalace` — запись решений, поиск предыдущего контекста, мnemonic queries.

### Workflow per Sprint
1. Generator предлагает sprint contract → Evaluator согласует.
2. Generator реализует.
3. Evaluator проверяет (lint / typecheck / tests / scope/idor/audit security tests).
4. PASS → Lead запускает `/codex:adversarial-review`, фиксит, переходит к следующему sprint.
5. FAIL → до 3 итераций Generator-Evaluator, потом эскалация Lead.

### Files Not To Touch
- `.omx/plans/*` (исходные планы — read-only).
- `PROJECT-SPECS-cyberstrike-hybrid.md`, `STACK-cyberstrike-hybrid.md` (read-only источники).
- `.git/`, `.harness/` (управляются Lead и harness).

### Patterns to Follow (из ~/.claude/rules/common/)
- Immutability: всегда новые объекты, никаких мутаций.
- File organization: small focused files (200-400 строк, 800 max).
- Comprehensive error handling, fail-fast validation на границах.
- TDD mandatory: RED → GREEN → REFACTOR.
- Conventional commits: feat/fix/refactor/docs/test/chore/perf/ci.
- No hardcoded secrets, env-driven config с fail-fast стартом.
