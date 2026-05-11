## Runtime readiness — 2026-05-12

Аудит блокирующий перед §2 PLAN-2026-05-12 (прод-деплой). Вопрос: можно ли сегодня провести один реальный pentest engagement от подписи регламента до подписанного отчёта.

### Метод

Прочитаны: `sprint-26-evaluator-result.md`, `sprint-27-evaluator-result.md`, `sprint-27-implementation-summary.md`, `saas-roadmap-s24-s28.md`, `decepticon-research-vps-poc/FINAL.md`, `target-authorization-proof/FINAL.md`. Code-verified: `apps/api/src/routes/scans/scans.ts`, `packages/decepticon-adapter/src/{select,real}.ts`, `packages/audit/src/writer.ts`, `services/scan-runner/src/*`. Греп: cost-cap, HMAC/Ed25519/crypto.sign в `packages/audit`.

### Runtime readiness matrix

| Слой | Состояние | Файл-эвиденс | Blocker для §2? |
|---|---|---|---|
| 1. Auth-proof verifier (DNS-TXT / file-upload / WHOIS / email-link) | **WIRED** (Workstream C, 4 sprint'а, PASS) | `apps/api/src/routes/targets/authorize/*`, mig 026, 34 unit + 19 IT тестов, AD-1..AD-16 покрыты | нет (само по себе работает) |
| 2. Auth-proof → scan-launch gate | **NOT WIRED** | `scans.ts:76` проверяет старый `targets.ownership_status='verified'` (S25 single-method); новый `target_authorizations` table не читается на запуске | **ДА — критичный** |
| 3. Scope engine (`tierToScopeRules`, `BuildEffectiveScopeInputs`) | **WIRED** | `apps/api/src/scans/tier-to-scope.ts` + `scans.ts:83`; правила пишутся в `assessment_scope_rules` | нет |
| 4. Validator/interception (SSRF/LFI/RCE) | **WIRED** (frozen с S27) | `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts` — 0-line diff S26→S27 | нет |
| 5. Decepticon integration | **WIRED + GATED ENV** | `packages/decepticon-adapter/src/select.ts`: по умолчанию `fake`; `real.ts` требует LangGraph Platform на `DECEPTICON_API_URL` + LLM-key (DeepSeek/Anthropic) | частичный — требует ручной запуск инфры |
| 6. Queue (jobs outbox) | **WIRED** | `scans.ts:222-238` вставляет `jobs` row после `state='running'`. Принцип: outbox-pattern | нет |
| 7. Worker, который **подхватывает** outbox + ведёт scan до completion | **UNCONFIRMED** | `services/coordinator/`, `services/cyberstrike-worker/` существуют; e2e S27 показывает scan застрявшим в `running` и `findings_count=0` после launch — worker либо не запущен в e2e, либо не доводит до completion | **ДА — критичный** |
| 8. Auto-build report при scan completion | **NOT WIRED** | S27 backlog `B-27-autobuild` явно открыт; e2e: `GET /report/html → 409 report_not_ready`; запуск отчёта только по нажатию "Build Report" вручную | **ДА** для самообслуживания |
| 9. Report synthesis (PDF/HTML/JSON/ZIP) | **WIRED, PDF DROPPED** | `services/report-builder/` + `packages/reports/` — frozen с S26; Zod enum `['html','json','zip']` (PDF удалён advisor B1 как MIME-fraud risk) | нет, но PDF клиенту обещали → надо переименовать в clients-facing |
| 10. Audit log | **WIRED БЕЗ ПОДПИСИ** | `packages/audit/src/writer.ts:emitAudit` пишет в `audit_events` table; grep `hmac|crypto.sign|ed25519` по `packages/audit/` → 0 хитов. Подписи нет — журнал ≠ judicial-grade evidence | **ДА** для регламента Art. 272 РФ |
| 11. Egress isolation (ephemeral VPS per scan) | **POC EXISTS, NOT WIRED** | `services/scan-runner/` — standalone Bun-пакет, 40 тестов 99% lines, DI-моки. Никто из `apps/api/`, `services/coordinator/` его НЕ импортирует (grep `createScanRunner` в проде → 0 хитов) | **ДА — критичный** для compliance |
| 12. Cost cap (токены/время/действия) | **MISSING** | grep `cost.?cap|budget.?cap|token.?budget|spend.?limit` по `packages/`, `apps/api/`, `services/` → 0 хитов. Rate-limit на scope-engine это другое (per-endpoint) | **ДА** — без него один scan может сжечь бюджет на LLM |
| 13. Billing stub | WIRED (mock) | S26 implementation; `subscriptions` table, mock checkout | нет для §1 цели |

### Verdict

**PARTIAL — NO для самообслуживания, YES для контролируемого демо на closed-VM при ручной настройке.**

Сегодня Tensol **может**:
- Принять регистрацию, создать проект, добавить таргет
- Запустить настоящий DNS-TXT/file/WHOIS verifier и получить подтверждение владения
- Запустить LangGraph Decepticon (если поднять локально с DeepSeek-ключом)
- Перехватить кандидатов через validator-worker
- Построить HTML/JSON/ZIP отчёт **по кнопке вручную**

Tensol **НЕ может сегодня без ручных операций**:
- Связать auth-proof → scan launch автоматически (gate написан в S27 backlog, но не закрыт)
- Изолировать egress в ephemeral VPS (POC есть, не интегрирован)
- Сгенерировать подписанный аудит-журнал (подписи нет — только plain row в PG)
- Применить cost cap (нет нигде в коде)
- Автоматически собрать отчёт по завершении скана (B-27-autobuild)
- Гарантировать, что worker реально доводит scan до `state='completed'` (e2e ни разу не показал completion)

### Top 5 блокеров для статуса "self-serve real engagement"

1. **Worker chain end-to-end не верифицирован**. S27 e2e зафиксировал `state='running'`, `findings_count=0` и больше ничего. Никаких тестов на `state='completed'` с реальными findings в готовом аудите.
2. **Auth-proof не подключён к scan launch**. Это явный архитектурный недолёт после Workstream C: код есть, gate не вшит.
3. **Egress isolation = POC, не продакшен**. Сегодня сканы пошли бы с egress IP сервера API. Под clients это нарушение mvp-mandate из memory `project_tensol_egress_isolation_decision_2026-05-09`.
4. **Audit без подписи**. Plain rows в `audit_events` — это log, не доказательство. Без HMAC/Ed25519 на каждой записи нельзя ссылаться на Art. 272 РФ.
5. **Cost cap отсутствует**. Один зацикленный LLM-агент может слить тысячи долларов на DeepSeek/Anthropic без барьера.

### Что работает уже сегодня (defensible на демо)

- Auth-proof verifier — самостоятельный, надёжный, можно показать на видео
- Scope engine — три тира с реальными правилами
- Validator-worker — отсечка ложных срабатываний
- Decepticon-adapter (real) — настоящий мост к LangGraph
- SaaS-фронт через Playwright walk — register/project/target/scan launch
- Report builder под капотом — HTML/JSON/ZIP

### Что mocked / stub / неинтегрировано

- Egress (VPS POC dangling)
- Cost cap (None)
- Audit signing (None)
- Auth-proof → scan gate (dangling между workstream C и scan-launch)
- Worker doneness (нет успешного e2e completion)
- Billing (явный stub by design, не блокер)

### Рекомендация для PLAN-2026-05-12

#### §2 — Прод-деплой сайта

**ИДТИ, но в ограниченном объёме:**

- **Деплоить `apps/site` на tensol.dev** — это маркетинг, форма /contact, /pricing, /method, /blog. Всё чистое, ничего не врёт о продукте.
- **НЕ открывать публичную регистрацию** на app.tensol.dev / apps/web. Registration page либо не деплоить, либо за password-gate "приватная бета — пишите".
- Telegram-relay для /contact деплоить на cloud-машину (Railway/Hetzner) — да, как в плане.

#### §3 — Блог-пост

**ПЕРЕФОРМУЛИРОВАТЬ тему**: «48 часов на чужом периметре» — это история, которой у нас на сегодня **нет** (worker chain не верифицирован end-to-end, нет реальных findings из реального engagement).

Честные кандидаты:
- **«Почему authorisation-proof — обязателен, а не бюрократия»** — расскажет про DNS-TXT/WHOIS/email-link verifier, Art. 272 РФ, AD-1..AD-16 (есть реальный код)
- **«Изоляция egress: почему MVP без ephemeral VPS — это юридический риск»** — основано на decision-doc 2026-05-09, scan-runner POC и опубликованной архитектурой
- **«Что делает агентский pentest скан-движок, а что — нет»** — XBOW-style transparency, основано на dossier из docs/research/decepticon-dossier.md

Любая из трёх честнее, чем сторителлинг про вымышленный engagement.

#### §4 — Outbound-список

Только если §3 закроется реальным постом. По текущим блокерам — собирать список можно, рассылать пока нет смысла.

### Что нужно делать дальше (после сегодня)

В порядке приоритета для одного честного engagement:

1. **Worker e2e** — закрыть гарантию `state='completed'` с не-нулевыми findings. Это самый важный pre-launch.
2. **Auth-proof → scan-launch gate** — вшить `target_authorizations` проверку в `scans.ts` (S28 mandate).
3. **Egress wiring** — подключить `services/scan-runner` к coordinator. Hetzner кредиты + cloud-init готовы.
4. **Audit signing** — HMAC-SHA256 c per-tenant ключом в KMS или Ed25519 с публикуемым публичным ключом. Решение «какой подход» = product OQ.
5. **Cost cap** — per-tenant + per-scan лимит на LLM-токены и wall-clock. Может быть простой счётчик в Postgres + middleware на LLM-gateway.

Все пять — это **новый workstream "engagement-end-to-end"**, не часть текущего S28-как-было-задумано (S28 в roadmap = polish + deploy, нужно перевыкатывать spec).

— audit done 2026-05-12, opus 4.7 (1M context), 0 spawned agents (после фабрикованного первого вернулся к ручному code-read)
