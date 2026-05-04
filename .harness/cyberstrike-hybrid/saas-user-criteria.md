# User Criteria — CyberStrike SaaS S24–S28

## Goal
Довести CyberStrike (моноrepo) до состояния «можно показать первому клиенту/инвестору» за ~неделю. Спецификация уже написана: см. `.harness/cyberstrike-hybrid/saas-roadmap-s24-s28.md` — она и есть `product-spec.md` для этого прогона. Planner должен использовать её как базу, разбить на per-sprint детализацию там, где её ещё нет, и зафиксировать архитектурные решения.

## Acceptance Criteria (по итогам всех 5 спринтов)
- **End-to-end SaaS-flow:** регистрация → логин → создание проекта → верификация домена (DNS-TXT) → запуск скана через UI → лайв-прогресс → отчёт → история сканов.
- **Бэкенд:** новые эндпоинты в `apps/api` под `/auth/*`, `/projects/*`, `/domains/verify/*`, `/scans/*`, `/findings`, `/billing/*` (mock). Миграции 023–025.
- **Фронт:** `apps/web` Next.js 16 App Router + Tailwind + shadcn (default theme, без полировки). Защищённый layout под `/app/*`, публичные `/`, `/login`, `/register`.
- **Изоляция тенантов:** многопользовательская модель, `users` 1:1 `tenants`, `req.user.tenantId` в hot-path вместо DEFAULT_TENANT_ID.
- **Domain verification обязателен** перед сканом (security guard).
- **Tier-mapping в `packages/scope-engine`:** `light` / `medium` / `aggressive` → набор валидаторов и интенсивность.
- **Биллинг — заглушка-флаг:** `/billing/checkout` сразу активирует подписку. Реальная интеграция вне scope.
- **Тесты:** IT для всех новых эндпоинтов, unit для middleware/scope-engine, e2e (playwright) для критических flow — register → project → scan → report.
- **Покрытие** ≥ 80% для нового кода.
- **Не ломать сделанное:** S15–S23 регрессии должны держаться зелёными (pitfalls catalog v8 действует).

## Constraints
- **Стек фиксирован:** TypeScript моноrepo, Postgres, BullMQ, существующие пакеты `audit/authz/contracts/scope-engine/validators/decepticon-adapter/reports`. Frontend — **Next.js 16 App Router + shadcn по умолчанию**, без кастомных дизайн-систем.
- **Дизайн строго shadcn-default** до явного решения «полируем». Никаких кастомных тем/иллюстраций.
- **Биллинг — заглушка.** YooKassa / Robokassa / CloudPayments — после регистрации юрлица, ВНЕ scope.
- **Email-verify через mock-флаг** `email_verified=true` сразу.
- **PII-шифрование вернём через managed KMS Yandex** в фазе деплоя (S28 опционально). Пока — без шифрования.
- **DEFAULT_TENANT_ID** используется только в S15–S23 регрессионных хвостах; в новом коде запрещён.
- **Не трогать без необходимости:** `services/decepticon`, `services/coordinator` (внутреннее API можно расширять, ломать существующие контракты — нельзя), миграции 001–022.
- **Pitfalls catalog v8 (P1–P37)** — действует. Особенно: BYTEA exempt list, B6-loop bump, generator-no-verdict (P36), contract pure-fn values code-verified (P37), evaluator FULL-suite counts.

## Harness Configuration (mandate from user)
- **Generator:** `claude-sonnet-4-6`. Обязательный воркфлоу:
  - Перед каждым sprint contract — вызов `/advisor` (subagent Opus 4.7) для review архитектурных решений.
  - Перед declaring sprint complete — повторный вызов `/advisor` для verification.
  - На каждом изменяемом символе — `gitnexus_impact()` upstream, blast radius указывается в контракте.
  - Перед предложением контракта — `mempalace_search` (wing `cyberstrike` или `cyberstrike-hybrid`) на предмет прошлых решений в области.
  - Перед handoff Evaluator'у — `gitnexus_detect_changes()`.
- **Planner:** не использует `/advisor`. Использует gitnexus + mempalace.
- **Evaluator:** не использует `/advisor`. **Независимый контекст** — каждую sprint-проверку начинает с чтения артефактов и кода свежими глазами, без предположений из generator-сообщений. Использует **playwright MCP** для e2e-проверок UI flows.
- **Все агенты:** mempalace и gitnexus — обязательно. Pitfalls v8 — обязательно перечитывать перед каждым контрактом.

## Out of Scope
- Multi-user внутри tenant (роли viewer/operator).
- Реальный биллинг (любой эквайринг).
- Email уведомления о завершении скана.
- Public API + CLI клиент.
- Compliance-отчёты (PCI / 152-ФЗ formatting).
- Шифрование PII клиентов (откладываем до KMS-деплоя).
- Полировка дизайна.
