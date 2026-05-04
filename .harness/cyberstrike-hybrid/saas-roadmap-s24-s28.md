# SaaS Roadmap — S24–S28

**Цель:** за ~неделю довести CyberStrike до состояния «можно показать первому клиенту/инвестору».
**Статус биллинга:** заглушка (юрлицо в процессе регистрации, YooKassa/альтернативы — позже).
**Дизайн:** функциональный shadcn без полировки. Полноценный дизайн — отдельная фаза.

---

## Архитектура (что добавляем)

**Новое:**
- `apps/web` — Next.js 16 App Router (UI клиента)
- `apps/marketing` или route-group в `apps/web/(public)` — лендинг
- `packages/auth-client` — обвязка JWT/cookie/session для фронта
- В `apps/api` — новые эндпоинты: `/auth/*`, `/projects/*`, `/domains/verify`, `/billing/*` (mock), `/scans/*` (обвязка над coordinator)

**Меняем существующее:**
- Возвращаем многопользовательскую модель (S23 свёл к 1 админу).
- `users` table + `tenants` 1:1 на пользователя (workspace-per-user, **не команды** — соло-maintainable).
- DEFAULT_TENANT_ID убираем из hot-path, используем `req.user.tenantId`.
- RBAC: оставляем 1 роль `owner` (= admin) внутри тенанта. Изоляция данных между клиентами без матрицы 1575 ячеек.

---

## Доменная модель SaaS

```
User (1) ─ (1) Tenant ─ (n) Project ─ (n) Target ─ (n) Scan ─ (n) Finding
                                       └ (n) DomainVerification
                              Tenant ─ (n) Invoice (mock)
                              Tenant ─ (1) Subscription (tier, mock)
```

- **Project** — папка для сканов одного клиента/сайта (group of targets).
- **DomainVerification** — `pending|verified|expired`, метод DNS-TXT.
- **Tier** — `light` (только nuclei subset), `medium` (+ SSRF/LFI/RCE), `aggressive` (+ decepticon brain).

---

## Спринты

### S24 — Frontend skeleton + Auth (~1.5 дня)

**Бэкенд:**
- mig 023: `users(id, email, password_hash, tenant_id, created_at)`, `sessions` или JWT-only
- `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`
- argon2id для паролей, JWT в httpOnly cookie
- Email-verify пропускаем (mock-флаг `email_verified=true` сразу)

**Фронт:**
- `apps/web` Next.js + Tailwind + shadcn init
- Страницы: `/` (лендинг-заглушка), `/login`, `/register`, `/app` (защищённый layout)
- Middleware на проверку cookie

**Тесты:** IT для auth-эндпоинтов + unit для middleware.

**Deliverable:** регистрация → логин → попадаешь на пустой dashboard.

---

### S25 — Projects + Domain Verification (~1.5 дня)

**Бэкенд:**
- mig 024: `projects`, `targets`, `domain_verifications`
- CRUD `/projects`, `/projects/:id/targets`
- `/domains/verify/start` → возвращает токен `cs-verify=<random>`
- `/domains/verify/check` → DNS TXT lookup через Node `dns.resolveTxt`
- Привязка target → project только после verified

**Фронт:**
- `/app/projects` — список + создание
- `/app/projects/:id` — таргеты + wizard «Add domain» с инструкцией DNS-TXT и кнопкой «Проверить»
- Polling статуса верификации

**Deliverable:** клиент создаёт проект, добавляет домен, видит инструкцию, после реального TXT-record система пускает дальше.

---

### S26 — Scan launch + Live progress (~2 дня)

**Бэкенд:**
- mig 025: `subscriptions(tenant_id, tier)`, `invoices` (mock-заглушка)
- `/billing/checkout` — фейковый, сразу ставит subscription активной
- `/scans` POST — параметры: project_id, tier, опции → создаёт assessment, публикует в coordinator (вся существующая S5–S22 цепочка)
- `/scans/:id` GET — прогресс (читаем `audit_events` и `findings` count)
- WebSocket или SSE на `/scans/:id/stream` для лайв-апдейтов (опционально, иначе polling 2s)
- Tier→scope mapping в `packages/scope-engine`: какие валидаторы и интенсивность

**Фронт:**
- `/app/projects/:id/scan/new` — wizard: target → tier (light/medium/aggressive) → «Оплатить» (заглушка) → запуск
- `/app/scans/:id` — live-прогресс: фазы (recon → validators → report), счётчик findings, последние audit-события
- Экран ожидания с честным таймером и логом

**Deliverable:** end-to-end запуск реального скана из UI с видимым прогрессом.

---

### S27 — Findings + Report + History (~1.5 дня)

**Бэкенд:**
- `/findings?scan_id=` — список с фильтрами (severity, kind)
- `/scans/:id/report.{html,pdf,json,zip}` — оборачивает существующий `report-builder` (S14)
- `/scans` GET — история тенанта с пагинацией

**Фронт:**
- `/app/scans/:id/findings` — таблица findings (shadcn DataTable), drawer с деталями каждой
- `/app/scans/:id/report` — встроенный HTML viewer + кнопки скачать
- `/app/history` — полный список сканов тенанта
- `/app/settings` — профиль, смена пароля, API-токен (генерация для будущей CLI-интеграции)

**Deliverable:** полный поток `register → project → scan → report → history`.

---

### S28 (буфер, опционально) — Polish + Yandex Cloud deploy

- Error boundaries, 404/500, loading states
- Базовый dark/light toggle
- Terraform для Yandex Cloud (managed PG + k8s или compose-on-VM для старта)
- Domain + SSL (Let's Encrypt)
- Production env vars
- Smoke-тест в проде

---

## Принципиальные решения

1. **Workspace-per-user, не teams.** Соло-поддержка — фича, не баг.
2. **Биллинг — заглушка-флаг.** Реальная интеграция — отдельный спринт после регистрации ООО/ИП.
3. **Email-verify через mock.** Когда будет реальная почта — добавим.
4. **Domain verification обязателен** — иначе нельзя сканировать (security guard).
5. **Tier = enum в скоп-движке.** Не делаем гибкие настройки в UI — три кнопки и всё.
6. **Шифрование PII клиентов** пока не делаем (S23 убрал BYTEA). Для прода вернём через managed KMS Yandex.
7. **Дизайн строго shadcn-default** до явного решения «сейчас полируем».

---

## Что за рамками этого плана

- Multi-user внутри tenant (роли viewer/operator) — когда появятся командные клиенты
- Real billing (Robokassa / Tinkoff / CloudPayments) — после регистрации юрлица
- Email уведомления о завершении скана — после SMTP-провайдера
- Public API + CLI клиент для CI/CD интеграций — отдельная фаза
- Compliance отчёты (PCI / 152-ФЗ formatting) — клиентский запрос-driven

---

## Альтернативные русские биллинги (для будущего)

- **Robokassa** — самый низкий порог входа, поддерживает ИП, тестовый режим
- **CloudPayments** — хороший SDK, поддержка подписок
- **Тинькофф Касса** — нужен расчётный счёт в Тинькофф
- **Sber Pay / Sberbank Acquiring** — для крупных клиентов
- **YooKassa** (отложено) — требует юрлицо + сайт с офертой

Все требуют ИП/ООО + сайт с офертой/политикой конфиденциальности перед прод-интеграцией.
