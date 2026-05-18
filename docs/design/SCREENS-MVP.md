# Tensol — описание экранов MVP для Claude Design

Этот документ — сжатый перечень экранов для первой публичной версии Tensol. Здесь нет требований к дизайн-системе, шрифтам, цветам, отступам, сеткам, иконкам или элементам управления — все эти решения принимает Claude Design.

В каждом экране указано только:

- кто и зачем сюда приходит;
- какие смысловые блоки экран обязан раскрыть;
- какие данные / состояния экран показывает.

Полная карта всех экранов (включая будущие) лежит в `SCREENS-FOR-CLAUDE-DESIGN.md` — этот файл является её MVP-срезом.

Терминология продукта берётся как есть: assessment, scope, finding, evidence, OPPLAN, RoE, attack graph, validator, kill chain, browser-first, deterministic validation, ownership verification, HITL approval, audit log, framework mapping (MITRE ATT&CK, NIST CSF, MITRE ATLAS, MITRE D3FEND, NIST AI RMF).

---

## Часть A. Публичный сайт

### A1. Лендинг

Единственная публичная страница MVP. Сюда приходит человек, который ищет платформу для авторизованного автономного пентеста.

Смысловые секции лендинга (на одной странице, без отдельных роутов):

- продуктовое заявление: Tensol — автономная пентест-платформа с deterministic validation и evidence-first отчётностью для авторизованных сред;
- три ключевых обещания: автономное прохождение kill chain, browser-first проверка реальных web-приложений, публикация только подтверждённых findings;
- короткое объяснение, почему это не «ещё один сканер» и не «red-team-as-a-service без правил», а authorized pentest с дисциплиной engagement (OPPLAN, RoE, scope, ownership verification);
- демонстрация результата: образ confirmed finding с evidence, attack graph, отчёт с framework mappings;
- блок про российскую инфраструктурную базу (Yandex Cloud), 152-FZ совместимость, GOST R / FSTEC шаблоны отчётов;
- блок про supply-chain дисциплину: pinned mirrors, audit logs, ownership-verified offensive capabilities;
- честная демаркация: что Tensol делает и чего не делает (не malware tooling, не phishing platform, не unauthorized C2, не stealth tooling);
- целевые роли пользователей: Security Lead, Pentest Operator, Compliance Reviewer, Developer / App Owner;
- CTA «запросить демо» (форма / Cal.com), вторичный CTA «войти» для уже подключённых клиентов;
- футер: privacy, terms, acceptable use, контакт security disclosure.

### A2. Юридические страницы

Privacy policy, terms of service, acceptable use policy с явным запретом использования Tensol для неавторизованных действий, security.txt. Формат — простые текстовые страницы, минимум визуала.

---

## Часть B. Аутентификация

### B1. Bootstrap-регистрация

Самая первая регистрация инсталляции. Создаёт первого platform_admin и owning tenant. Поля: email, пароль, displayName, tenantSlug, tenantName, bootstrapToken. После выполнения экран перестаёт быть доступен — повторный заход показывает сообщение, что bootstrap уже выполнен.

### B2. Вход

Один экран, в котором живёт двухшаговый поток:

- email + пароль; если MFA не включён — сразу авторизация; если включён — внутри того же экрана появляется поле для 6-значного TOTP-кода;
- любая ошибка — каноническое сообщение invalid_credentials, без раскрытия деталей;
- ссылка «забыли пароль» (ведёт на восстановление по email — простая двухшаговая ссылка, отдельный экран не требуется).

### B3. Регистрация по приглашению

Пользователь приходит по invite-ссылке от tenant_admin. Поля: email подтверждён ссылкой, имя, пароль. После регистрации — обязательное предложение включить MFA с QR-кодом TOTP-секрета на этом же экране.

---

## Часть C. Ядро продукта

Эти экраны видит уже авторизованный пользователь.

### C1. Дашборд

Экран после входа. Минимально необходимое для Security Lead и Pentest Operator:

- активные assessments с короткой строкой статуса каждого;
- свежие confirmed findings разбитые по severity;
- очередь pending HITL approvals;
- engine health indicator (одна строка: ok / degraded / unhealthy);
- быстрый переход «создать assessment».

### C2. Проекты

Один экран со списком и встроенной карточкой выбранного проекта (master-detail).

Список: имя, владелец, число targets, число открытых assessments, число confirmed findings, последняя активность.

Карточка проекта: метаданные, инвентарь targets, история assessments, открытые findings, владельцы. Создание / редактирование проекта — через модалку, не отдельный экран.

### C3. Targets

Список targets выбранного проекта: тип target (web, host, network, cloud account, API endpoint, repository), идентификатор, состояние ownership verification, последняя проверка.

Регистрация target (модалка или отдельный экран на усмотрение Claude Design): тип, идентификатор, описание, контакт владельца, выбор метода ownership verification (DNS TXT, файл на корне, header, email подтверждение, cloud-side proof) и инструкция по выполнению. Пока target не verified — он не может попасть в assessment scope.

Карточка target: идентификатор, тип, статус ownership verification, история assessments, scope rules, masked credentials, открытые findings, явно разрешённые на этом target high-impact категории.

### C4. Assessment builder

Центральный экран продукта. Сюда приходит security_lead / operator, чтобы собрать engagement и отправить на approval.

Содержательные блоки builder (один экран, последовательная или табовая структура — на усмотрение Claude Design):

- выбор targets из проекта (только verified);
- scope rules (allow / deny + нормализация URL и резолвинг DNS / IP);
- exclusions;
- testing window (даты, часы, часовой пояс);
- профиль assessment (методология, глубина);
- tool policy (verified catalog, эффективная видимость, объяснения недоступных инструментов);
- явное декларирование разрешений на high-impact категории как часть target authorization (foothold, post-exploit, lateral movement, AD attack-path, credential dumping simulation, password audit, hash cracking, phishing simulation, Evilginx-like simulation, responder / relay simulation, Sliver C2, Metasploit, msfvenom payload generation, webshell management, reverse shells, persistence testing);
- загрузка OpenAPI документов и контекстных документов;
- masked credentials / login recipes;
- preview эффективного scope перед отправкой;
- финальный шаг «отправить на approval» с краткой сводкой (это и есть approval-экран — отдельным роутом не выносим).

Safety UX обязательно показывает: маркировку high-impact категорий, видимое подтверждение target authorization, preview эффективного scope до старта, объяснение, почему конкретный инструмент недоступен (нет credentials, нет target authorization, окно неактуально, региональная политика).

### C5. Approval assessment

Утверждающий (security_lead с правом approve) видит сводку отправленного builder: targets, scope, exclusions, testing window, профиль, tool policy, declared high-impact categories, OPPLAN summary, OpenAPI и контекстные документы, credentials по списку (без значений), список ожидаемых HITL approval точек. Действия: approve / send back / reject.

Может быть реализовано как отдельный экран или как модалка над builder — на усмотрение Claude Design.

### C6. Live assessment

Активный engagement в реальном времени.

Содержание:

- текущий статус и фаза агента;
- timeline событий;
- запущенные jobs;
- счётчик candidate findings и confirmed findings;
- прогресс browser crawl и HTTP recon;
- очередь validator;
- состояние kill-switch;
- управление: pause / resume / cancel (cancel требует обоснования);
- HITL approvals, когда нужны — отдельный приоритетный блок с описанием действия, target, scope-проверки, tool, обоснование.

После завершения этот же экран превращается в архивный read-only timeline.

### C7. Findings

Список findings tenant с фильтрами по проекту, assessment, target, severity, confidence, status (candidate / confirmed / rejected / fixed / wont-fix). По каждому: title, severity, confidence, статус, affected asset, источник.

Карточка finding (либо отдельный экран, либо drawer — на усмотрение Claude Design):

- title, severity, confidence, status;
- affected asset, affected endpoint;
- impact;
- reproduction steps;
- evidence (со ссылкой на evidence viewer);
- validation log с deterministic replay результатом;
- attack techniques (MITRE ATT&CK);
- NIST CSF mappings (и где применимо MITRE ATLAS, MITRE D3FEND, NIST AI RMF);
- remediation guidance;
- комментарии и история триажа.

### C8. Evidence viewer

Просмотр одного evidence-пакета, открывается из карточки finding.

Поддерживает:

- скриншоты;
- HTTP request / response diff (sensitive данные redacted);
- HAR summary;
- ссылка на полный Playwright trace;
- command output (с redaction);
- OOB callback details (источник, токен, полезная нагрузка, время, soft / hard корреляция);
- состояние redaction (что и почему скрыто);
- artifact hash (для проверки целостности).

### C9. Reports

Один экран со списком отчётов tenant и встроенной генерацией нового.

Список: проект, assessment, тип отчёта, дата генерации, статус (draft, generated, delivered).

Генерация: выбор assessment, типа (executive summary / technical pentest / compliance mapping), языка (английский, русский), шаблона (например, GOST R, FSTEC mapping appendix), опции redaction секретов.

Содержание сгенерированного отчёта: engagement metadata, RoE summary, scope, exclusions, testing window, methodology, tool policy summary, OPPLAN summary, findings summary, confirmed findings detail, evidence per finding, attack graph snapshot, Offensive Vaccine recommendations, remediation roadmap, framework mappings (с указанием source и confidence), appendix с tool versions и audit metadata.

После генерации snapshot отчёта immutable. Скачивание в PDF, HTML, JSON.

---

## Часть D. Settings

### D1. Settings

Один экран с табами.

- **Профиль:** имя, email, смена пароля, MFA enrollment / disable, сессии, API tokens пользователя, предпочитаемый язык (английский / русский), часовой пояс.
- **Tenant** (только tenant_admin): название и slug, регион хранения, retention policy (если разрешено platform), список пользователей и их роли (platform_admin, tenant_admin, security_lead, operator, developer, auditor, viewer), приглашения, политика паролей, обязательность MFA.
- **Уведомления:** какие события приходят пользователю и каким каналом (in-app, email): HITL approval, validator confirmed finding, assessment status changes, отчёт готов.

---

## Часть E. Состояния и ошибки

Эти экраны не являются отдельными разделами, но обязаны быть.

### E1. Empty states

Пустой проект, пустой список targets, пустой список assessments, пустой список findings, пустой evidence. Каждый empty state объясняет следующее действие.

### E2. Loading states

Долгие операции (генерация отчёта, запуск assessment, замер scope preview, replay validator) показывают честный progress, не «бесконечный спиннер».

### E3. Error states

- 401 / истекшая сессия — увод на login с сохранением исходного маршрута;
- 403 / RBAC-отказ — объяснение, почему доступ запрещён (роль / tenant / project / assessment / tool policy / scope), без раскрытия чувствительной информации;
- 404 — объект не существует или не принадлежит вашему tenant (объединённое сообщение, чтобы не утекала информация о существовании объектов чужих tenants);
- 410 — bootstrap уже выполнен (для повторного захода на B1);
- 5xx — короткое сообщение и контакт поддержки;
- offline — сообщение и попытка переподключения.

### E4. Permission denied для action

Когда конкретное действие в UI запрещено (например, operator не может approve assessment) — само действие показывает причину запрета вместо «молча неактивно».

### E5. Read-only режим (auditor / viewer)

Тот же UI, но без действий. Все элементы, ведущие к мутирующим действиям, либо скрыты, либо явно помечены как read-only.

### E6. Локализация

Все тексты живут в двух локалях: английский и русский. Часть отчётов требует русской локализации (russian-language report, GOST R / FSTEC).

---

## Часть F. Карта переходов

- Лендинг (A1) → Login (B2) или форма демо.
- Login (B2) → Дашборд (C1).
- Дашборд (C1) → Live assessment (C6), Findings (C7), Reports (C9).
- Проекты (C2) → Targets (C3), Assessment builder (C4), Findings проекта.
- Target (C3) → его assessments, его findings, его credentials.
- Assessment builder (C4) → Approval (C5) → Live (C6) → Findings detail (C7) → Evidence viewer (C8) → Report (C9).
- Любой finding (C7) → Evidence (C8).
- Settings (D1) — отдельный пласт, доступен из меню пользователя.
- Любая ошибка (E3) ведёт либо обратно в источник, либо в login (B2).

---

## Что осознанно вынесено за пределы MVP

Эти экраны существуют в полной карте, но в MVP не входят. Список — чтобы Claude Design не пытался их закладывать в навигацию.

- Отдельные публичные страницы: «как это работает», «возможности», «безопасность», «для кого», «отчёты», «цены», «документация», «блог», «карьера», «статус системы» — секции лендинга, не отдельные роуты.
- Глобальный поиск, уведомления как отдельный экран, переключение tenant — добавляются, когда у клиента реально появляется потребность.
- Attack graph view как отдельный экран — в MVP только snapshot внутри отчёта.
- Список candidate findings отдельным экраном, retest как отдельный flow, partial-interrupted assessment — backlog.
- Skill library (каталог, карточка, workflow аудита) — управляется через CLI / config до первого клиентского запроса на UI.
- Tool policy UI (глобальный verified catalog, tenant access, assessment effective catalog, audit history) — управляется через config.
- Audit log UI и экспорт — на старте только через SQL / CLI, UI добавляется по запросу compliance-офицера.
- Платформенный admin (tenants, LLM routing, deployment policies, engine fleet, workers fleet, очереди, object storage, alerts, config) — операционные задачи через CLI / SQL / kubectl.

---

## Что Claude Design решает сам

- любая визуальная система: цвет, типографика, сетка, отступы, иконки, иллюстрации, тёмный / светлый режим;
- любая микровзаимодействующая сущность: ввод, контролы, таблицы, списки, графы, диаграммы, тосты, модалки, drawers, табы, sidebar / topbar / breadcrumbs;
- информационная архитектура внутри отдельного экрана, иерархия заголовков, порядок блоков (если выше порядок не зафиксирован явно как смысловой);
- состояния hover / focus / active / disabled / loading / error / success;
- адаптивность под десктоп / планшет / мобильный;
- акцент бренда Tensol и его проявление в продукте.
