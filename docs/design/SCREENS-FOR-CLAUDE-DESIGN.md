# CyberStrike Hybrid — описание всех экранов для Claude Design

Этот документ — полный перечень экранов сайта вокруг сервиса. Здесь нет требований к дизайн-системе, шрифтам, цветам, отступам, сеткам, иконкам, элементам управления или поведению анимаций. Все эти решения принимает Claude Design сам.

В каждом экране указано только:

- кто и зачем сюда приходит;
- какой смысловой контент должен быть на экране;
- какие смысловые блоки экран обязан раскрыть;
- какие данные / состояния экран показывает;
- какие переходы он порождает.

Терминология продукта берется как есть: assessment, scope, finding, evidence, OPPLAN, RoE, attack graph, validator, Decepticon, kill chain, browser-first, deterministic validation, ownership verification, HITL approval, audit log, framework mapping (MITRE ATT&CK, NIST CSF, MITRE ATLAS, MITRE D3FEND, NIST AI RMF).

---

## Часть A. Публичный сайт (маркетинг и доверие)

### A1. Главная страница

Экран первой встречи с продуктом. Сюда приходит человек, который ищет платформу для авторизованного автономного пентеста и adversary emulation.

Смысловые блоки:

- продуктовое заявление: автономная пентест-платформа с deterministic validation и evidence-first отчетностью для авторизованных сред;
- короткое объяснение, почему это не «еще один сканер» и не «red-team-as-a-service без правил», а authorized pentest с дисциплиной engagement (OPPLAN, RoE, ConOps, deconfliction);
- три ключевых обещания: автономное прохождение kill chain, browser-first проверка реальных web-приложений, публикация только подтвержденных findings;
- демонстрация того, как выглядит результат: образ confirmed finding с evidence, attack graph, отчет с framework mappings;
- блок про hybrid LLM routing по ролям агентов (без раскрытия конкретных моделей, на уровне принципа);
- блок про российскую инфраструктурную базу (Yandex Cloud), 152-FZ совместимость, GOST R / FSTEC шаблоны отчетов;
- блок про supply-chain дисциплину: pinned mirrors, audit logs, ownership-verified offensive capabilities;
- социальное доказательство: целевые роли пользователей (Security Lead, Pentest Operator, Compliance Reviewer, Developer / App Owner);
- честная демаркация: что продукт делает и чего не делает (не malware tooling, не phishing platform, не unauthorized C2, не stealth tooling);
- призыв к двум действиям: «запросить демо» и «попробовать в private cloud»;
- футер с навигацией по публичным разделам и юридическим документам.

### A2. Страница «Как это работает»

Объясняет жизненный цикл одного engagement от регистрации targets до отчета. Цель — снять страх «черного ящика» у Security Lead и compliance-аудитора.

Содержание:

- одиннадцать шагов сценария продукта (создание проекта и регистрация targets → задание scope rules, exclusions, allowed windows, verified tool catalog access и assessment profile → формирование OPPLAN input для Decepticon → запуск изолированного instance Decepticon → сбор authenticated browser signals → дополнение recon / scanning сигналом от HTTP-worker и cyberstrike-worker → построение attack path и генерация candidate findings → deterministic replay через validator-worker → публикация только подтвержденных findings → Offensive Vaccine loop с defensive recommendations → формирование PDF / HTML / JSON отчета);
- объяснение роли каждого участника: координатор, browser-worker, HTTP-worker, cyberstrike-worker, validator-worker, OOB-сервис, report builder;
- объяснение того, что candidate finding != published finding;
- объяснение browser-first принципа: SPA, JS-heavy rendering, authenticated flows, CSRF, cookies, наблюдение API из runtime браузера;
- объяснение, что ни один tool call не выполняется без прохождения scope enforcement на семи уровнях (API, координатор, worker, sandbox overlay, MCP verified catalog policy, egress firewall, validator replay, публикация в отчете).

### A3. Страница «Возможности продукта»

Перечисление функциональных областей. Не каталог фич, а карта возможностей с привязкой к ценности.

Области:

- автоном��ое прохождение kill chain через Decepticon engine;
- browser-first проверка web-приложений с authenticated session;
- deterministic validators по классам уязвимостей (XSS, SSRF, file-read, RCE);
- evidence-first сбор артефактов (скриншоты, HTTP request/response diff, HAR, Playwright trace, command output, OOB callback details, redaction state, artifact hash);
- attack graph view с discovered assets, vulnerabilities, attack steps, validated exploit paths и defensive recommendations;
- skill library с аудит-статусом, source commit, framework mappings и admin-workflow для импорта и аудита;
- tool policy с verified tool catalog, tenant catalog access, assessment effective catalog access, объяснениями недоступности инструмента (нет credentials, нет target authorization, нет окна, нет регионального разрешения), high-risk category labels и audit history;
- HITL approvals для high-impact категорий;
- отчеты шести типов: executive summary, technical pentest, compliance mapping, evidence archive, retest, partial interrupted assessment;
- framework mappings (MITRE ATT&CK, NIST CSF, MITRE ATLAS, MITRE D3FEND, NIST AI RMF);
- audit log с reconstructible историей каждого security-relevant решения.

### A4. Страница «Безопасность и compliance»

Цель — снять возражения corporate security и юристов.

Содержание:

- модель multi-tenancy: tenant isolation, project-level access, ownership-verified offensive capabilities;
- secrets management: encryption at rest, scoped к tenant и assessment, masked values, retention period, никаких plaintext в логах;
- supply chain controls: pinned Decepticon commit, pinned cyberstrike-runner commit, pinned skill library commit, mirrored images в Yandex Container Registry, deployment по digest, quarterly upstream review, SBOM где это возможно, отказ от auto-pull из upstream main;
- network controls: K8s network policies, private namespaces, egress firewall, deny PRC endpoints для CyberStrike defaults без явного разрешения, deny arbitrary internet из sandbox кроме target scope и required services;
- audit logging: что именно аудируется (login, assessment approval, start / pause / resume / cancel, scope changes, tool policy changes, high-impact tool authorization, finding status changes, report generation, denied tool calls, LLM provider fallback, secret access);
- 152-FZ posture: persona и customer data в Yandex Cloud managed services по умолчанию;
- внешние LLM: документирование provider, отправляемых данных, retention, redaction, enterprise exception path;
- data retention: hot 90 дней / cold 1 год / truncation после retention / audit per legal policy.

### A5. Страница «Для кого продукт»

Раскрывает целевые роли и их сценарии: Platform Admin, Tenant Admin, Security Lead, Pentest Operator, Developer / App Owner, Auditor / Compliance Reviewer. По каждой роли — что она получает и чего ей не нужно делать руками.

### A6. Страница «Отчеты»

Маркетинговая страница про отчетность. Показывает шесть типов отчетов и состав технического отчета (engagement metadata, RoE summary, scope, exclusions, testing window, methodology, tool policy summary, Decepticon OPPLAN summary, findings summary, confirmed findings detail, evidence per finding, attack graph, Offensive Vaccine recommendations, remediation roadmap, framework mappings, appendix с tool versions и audit metadata). Отдельный блок про русские шаблоны (russian-language report, GOST R oriented, FSTEC-oriented mapping appendix, customer-ready PDF с evidence appendix). Отдельный блок про правила: только confirmed findings в основном теле, candidate findings в приложении только по запросу, redaction секретов, immutable snapshot после генерации.

### A7. Страница «Цены / тарифы»

Показывает модели поставки (multi-tenant SaaS и private-cloud) и уровни доступа без раскрытия числовых цифр на этапе дизайна (Claude Design сам решает, как обозначить «contact sales» / «self-serve» / «enterprise» / «private cloud»). Отдельным блоком — что входит в каждый уровень с точки зрения retention, числа активных assessments, доступа к verified tool catalog, MFA / SSO, audit retention, custom report templates.

### A8. Страница «Документация и ресурсы»

Витрина в публичную часть знаний: getting started, концептуальная модель (tenant, project, target, assessment, scope rule, candidate finding, finding, evidence, skill library, framework mapping), API reference, runbooks, ADR, security mapping (например, OWASP ASVS L1), changelog, статус продукта.

### A9. Страница «Контакты и продажи»

Форма запроса демо и контактов. Поля: имя, компания, роль, email, описание задачи, предпочитаемая модель поставки (SaaS или private cloud), желаемое окно. Отдел��ный канал для security disclosure.

### A10. Юридические страницы

Privacy policy, terms of service, acceptable use policy с явным запретом использования платформы для неавторизованных действий, DPA / 152-FZ положение, sub-processors, cookie policy, security.txt.

### A11. Страница «Статус системы»

Публичный health: API, coordinator, browser-worker, HTTP-worker, cyberstrike-worker, validator-worker, OOB service, report builder, llm-gateway, объектное хранилище, очереди, Decepticon engine heartbeat. Текущие инциденты, история инцидентов, planned maintenance.

### A12. Страница «Блог / changelog»

Лента публикаций: новые validators, новые skill library обновления, новые framework mappings, релизы, security advisories, post-mortem.

### A13. Страница «Карьера»

Не критично для MVP, но Claude Design должен знать, что такая страница существует. Описание команды и открытых ролей.

### A14. Страница 404 / 500 / offline

Каждая ошибка должна объяснять, что произошло, и куда идти дальше. Без потери контекста (если человек шел в защищенный раздел — его перенаправляют на login, а не выкидывают на главную).

---

## Часть B. Регистра��ия, вход и онбординг

### B1. Bootstrap-регистрация

Самая первая регистрация платформы. Создает первого platform_admin и owning tenant. Поля: email, пароль, displayName, tenantSlug, tenantName, bootstrapToken (в production обязателен, в local — опционален). После выполнения этой регистрации экран должен перестать быть доступен — повторный заход показывает сообщение, что bootstrap уже выполнен.

### B2. Регистрация по приглашению

Пользователь приходит по invite-ссылке от tenant_admin. Поля: email подтвержден ссылкой, имя, пароль. После регистрации — обязательное предложение включить MFA.

### B3. Вход

Двухшаговый поток:

- шаг 1: email + пароль; если MFA не включен — сразу авторизация; если MFA включен — переход на шаг 2 c pre_auth_token и сроком его жизни;
- шаг 2: ввод 6-значного TOTP-кода;
- любая ошибка — каноническое сообщение invalid_credentials, без раскрытия, что именно не так;
- ссылка на восстановление пароля;
- ссылка на SSO (на будущую интеграцию).

### B4. Восстановление пароля

Двухэтапный flow: запрос ссылки по email → ввод нового пароля по одноразовой ссылке. Никаких подсказок, существует ли учетка.

### B5. Включение MFA

Пользователь видит экран с QR-кодом TOTP-секрета (SHA1, 6 цифр, 30 секунд) и поле для ввода первого валидного кода. Подтверждение включает MFA на учетке.

### B6. Онбординг для нового tenant

Шаги после первой регистрации:

- подтвердить организацию (название, slug, регион);
- пригласить пользователей и назначить роли (tenant_admin, security_lead, operator, developer, auditor, viewer);
- создать первый проект;
- зарегистрировать первый target;
- задать первое scope rule;
- запустить первый «sandbox» assessment по lab-target (не по продакшен-инфраструктуре) — это знакомит с lifecycle и evidence;
- получить чек-лист готовности.

### B7. Онбординг для нового пользователя

Тур по продукту: дашборд, проекты, assessments, findings, evidence, reports, skill library, tool policy, audit log, settings. Тур не блокирующий, его можно пропустить.

### B8. Переключение tenant

Если пользователь принадлежит к нескольким tenants, экран переключения показывает текущий tenant, список доступных, последний активный assessment в каждом.

---

## Часть C. Главная навигация продукта

Эти экраны видит уже авторизованный пользователь.

### C1. Дашборд (внутренний)

Экран после входа. Показывает то, что сразу нужно Security Lead и Pentest Operator:

- активные assessments с короткой строкой статуса каждой;
- findings разбитые по severity;
- очередь validation;
- свежие OOB events;
- engine health (Decepticon heartbeat, очереди, workers);
- сводка по cost analytics (per-assessment LLM cost, top models, fallback count);
- top vulnerable targets;
- timeline summary по последним assessments.

### C2. Глобальный поиск

Один поисковый экран по: проекты, targets, assessments, findings, evidence, skills, tool catalog, audit events, отчеты. Результаты сгруппированы по типам, каждая запись ведет на свой detail-экран.

### C3. Уведомления

Лен��а продукт-уведомлений: HITL approval ожидает, validator confirmed finding, assessment paused / resumed / canceled, отчет готов, threshold по severity нарушен, OOB callback пришел, scope denied attempt spike, Decepticon heartbeat missing, queue backlog, LLM provider outage, K8s namespace cleanup failure.

### C4. Личное меню пользователя

Профиль, безопасность учетки (смена пароля, MFA, сесс��и и устройства, API tokens), переключение tenant, выход.

---

## Часть D. Проекты

### D1. Список проектов

Все проекты текущего tenant. По каждому: имя, владельцы, число targets, число открытых assessments, число confirmed findings, последний риск-тренд, последняя активность.

### D2. Создание проекта

Поля: имя, описание, владелец (security_lead), теги. Согласие пользователя с тем, что внутри проекта могут жить только authorized targets.

### D3. Карточка проекта

Видит security_lead, operator, developer, auditor (с разной шириной прав).

Содержание:

- метаданные проекта;
- инвентарь targets;
- история assessments;
- открытые findings;
- риск-тренд по проекту;
- отчеты;
- владельцы;
- быстрый переход «создать assessment».

### D4. Настройки проекта

Имя, описание, владельцы, теги, retention override (если позволено tenant policy), архивирование проекта.

---

## Часть E. Targets

### E1. Список targets

Все targets проекта или tenant: тип target (web, host, network, cloud account, API endpoint, repository), идентификатор, состояние ownership verification, привязанные assessments, последняя проверка.

### E2. Регистрация target

Поля: тип, идентификатор (URL, IP, CIDR, cloud account, repo, API), описание, контакт владельца, файл / процедура подтверждения владения. Поток ownership verification: пользователь выбирает один из методов (DNS TXT, файл на корне, header, email подтверждение, cloud-side proof) и выполняет шаги. Пока target не verified — он не может попасть в assessment scope.

### E3. Карточка target

Содержание:

- идентификатор и тип;
- статус ownership verification;
- история assessments по этому target;
- список scope rules, в которые он входит;
- credentials и login recipes (отображаются маскированно);
- последняя observation;
- открытые findings по этому target;
- запись о том, какие high-impact категории явно разрешены на этом target (foothold, post-exploit, AD attack-path, password audit, hash cracking, phishing simulation, Evilginx-like simulation, responder / relay simulation).

### E4. Управление учетными данными target

Создание и привязка credentials / login recipes. Все секреты — masked, доступ через RBAC. Audit access к секретам.

---

## Часть F. Assessments

### F1. Список assessments

Все engagement в работе и в архиве. По каждому: проект, статус (draft, awaiting approval, approved, running, paused, completed, canceled, partial-interrupted), окно testing, профиль, число targets, число candidate / confirmed findings, последняя активность.

### F2. Builder assessment

Это центральный экран продукта. Сюда приходит security_lead / operator, чтобы собрать engagement и отправить на approval.

Шаги builder:

- выбор targets из проекта (только verified);
- задание scope rules (allow / deny + нормализация URL и резолвинг DNS / IP);
- задание exclusions;
- testing window (даты, часы, часовой пояс);
- профиль assessment (методология, глубина);
- LLM profile (по ролям агентов);
- tool policy (verified catalog, эффективная видимость, объяснения недоступных инструментов);
- явное декларирование разрешений на high-impact категории как часть target authorization (foothold, post-exploit, lateral movement, AD attack-path, credential dumping simulation, password audit, hash cracking, phishing simulation если scope включает, Evilginx-like simulation если scope включает, responder / relay simulation, Sliver C2, Metasploit, msfvenom payload generation, webshell management, reverse shells, persistence testing, reverse engineering, forensic tooling);
- загрузка OpenAPI документов;
- загрузка контекстных документов;
- добавление credentials / login recipes;
- preview эффективного scope;
- отправка на approval.

Safety UX обязательно показывает:

- маркировку high-impact категорий;
- видимое подтверждение target authorization и активного scope перед запуском C2 / post-exploit / Metasploit;
- preview эффективного scope до старта;
- объяснение, почему конкретный инструмент недоступен на этом assessment (нет credentials, нет target authorization, окно неактуально, региональная политика).

### F3. Approval assessment

Утверждающий (security_lead с правом approve) видит сводку: targets, scope, exclusions, testing window, профиль, tool policy, declared high-impact categories, OPPLAN summary, OpenAPI и контекстные документы, credentials по списку (без значений), список ожидаемых HITL approval точек. Действия: approve / send back / reject.

### F4. Live assessment view

Активный engagement в реальном времени.

Содержание:

- текущий статус;
- фаза Decepticon-агента;
- timeline событий;
- запущенные jobs;
- счетчик candidate findings;
- счетчик confirmed findings;
- прогресс browser crawl;
- прогресс HTTP recon;
- запуски cyberstrike-инструментов;
- очередь validator;
- состояние kill-switch;
- управление: pause / resume / cancel;
- HITL approvals, когда нужны (от��ельный блок с описанием действия, target, scope-проверки, tool, обоснование, кнопка решения утверждающего).

### F5. Attack graph view

Графовое представление текущего engagement.

Содержание:

- discovered assets;
- найденные уязвимости;
- attack steps;
- validated exploit paths (визуально отделены от candidate);
- defensive recommendations (Offensive Vaccine);
- фильтры по severity / phase / source;
- replay step details;
- переход к related finding и evidence.

### F6. Pause / resume / cancel

Подтверждающие диалоги действий над assessment. Каждое действие записывается в audit log с before / after, IP / user agent. Cancel требует обоснования. Pause фиксирует mission state и позволяет resume без потери контекста.

### F7. Partial-interrupted assessment

Если assessment был прерван (timeout, namespace cleanup failure, ручной cancel в середине kill chain) — экран показывает, что было собрано, какие observations есть, какие candidate findings успели появиться, какие confirmed findings уже опубликованы, и предлагает сгенерировать partial interrupted assessment report.

### F8. История assessment

Архивный режим: read-only timeline, attack graph snapshot, findings snapshot, evidence references, отчеты, audit-выписка по этому assessment, использованные модели LLM и стоимость.

---

## Часть G. Findings

### G1. Список findings

Все findings tenant с фильтрами по проекту, assessment, target, severity, confidence, status (candidate / confirmed / rejected / fixed / wont-fix / retest-pending), framework mapping, дате обнаружения. По каждому: title, severity, confidence, статус, affected asset, источник.

### G2. Карточка finding

Самая «насыщенная контентом» страница продукта. Сюда приходит operator, developer, auditor.

Содержание:

- title;
- severity;
- confidence;
- status;
- affected asset;
- affected endpoint;
- impact;
- reproduction steps;
- evidence (со ссылками на evidence viewer);
- validation log с deterministic replay результатом;
- attack techniques (MITRE ATT&CK);
- NIST CSF mappings (и где применимо MITRE ATLAS, MITRE D3FEND, NIST AI RMF);
- remediation guidance;
- retest action;
- комментарии и история триажа;
- ссылка на attack graph node;
- связь с другими findings того же assessment.

### G3. Список candidate findings

Отдельный список тех, что еще не прошли validator. По каждому: title, источник (Decepticon / browser-worker / HTTP-worker / cyberstrike-worker / scanner), время обнаружения, состояние очереди валидации, причина отклонения если есть. Из карточки candidate можно вручную потребовать повторный replay (если RBAC позволяет).

### G4. Триаж

Массовые операции: подтвердить / отклонить / переоткрыть / назначить владельцу / поставить в retest. Все действия — через audit log.

### G5. Retest

Запуск повторной проверки конкретного finding после фикса. Создает мини-assessment, ограниченный затронутым endpoint и нужным validator. Результат — обновление статуса finding в fixed или confirmed.

---

## Часть H. Evidence

### H1. Evidence viewer

Просмотр одного evidence-пакета.

Поддерживает:

- скриншоты (со scroll-by-step и highlight области);
- HTTP request / response diff (запрос и ответ side-by-side, sensitive данные redacted);
- HAR summary;
- ссылка на полный Playwright trace;
- command output (со scroll и переносом длинных строк, с redaction);
- OOB callback details (источник, токен, полезная нагрузка, время, soft / hard корреляция);
- состояние redaction (что и почему скрыто);
- artifact hash (для проверки целостности).

### H2. Список evidence assessment

Все артефакты engagement, сгруппированные по типу: screenshots, HTTP, HAR, traces, command outputs, OOB events. Возможность скачать архив всех evidence одним пакетом (только тем, у кого есть право download).

---

## Часть I. Reports

### I1. Список отчетов

Все отчеты tenant с фильтрами по проекту, assessment, типу отчета, дате генерации, статусу (draft, generated, approved, delivered).

### I2. Генерация отчета

Экран создания нового отчета. Выбор assessment, типа (executive summary / technical pentest / compliance mapping / evidence archive / retest / partial interrupted), языка (английский, русский), шаблона (например, GOST R, FSTEC mapping appendix), включать ли appendix с candidate findings, опции redaction секретов.

Внутри обязательно:

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
- framework mappings (с указанием source и confidence);
- appendix с tool versions и audit metadata.

### I3. Просмотр отчета

Read-only представление сгенерированного отчета. После генерации snapshot отчета immutable. Скачивание в PDF, HTML, JSON, evidence archive.

### I4. Approval отчета

Security Lead может утвердить отчет перед передачей клиенту / стейкхолдерам. Approval фиксируется в audit log.

---

## Часть J. Skill Library

### J1. Список skills

Каталог skill library. По каждому: имя, домен, теги, framework mapping (ATT&CK / D3FEND / ATLAS / AI RMF), audit статус (audited / pending / rejected), source commit, последнее обновление.

### J2. Карточка skill

Содержание:

- preview тела skill;
- mapping display (с указанием source и confidence);
- audit статус и история аудита;
- source commit и привязка к pinned версии;
- использование skill в прошлых assessments;
- кнопка для admin: «отправить на повторный аудит», «отозвать».

### J3. Workflow импорта и аудита

Только для admin. Экран добавления skill: загрузка / клон из pinned mirror, ручной spot-check mapping, фиксация аудит-результата, перевод skill в статус audited. Запрет публикации, пока skill не пройдет аудит.

---

## Часть K. Tool Policy

### K1. Глобальный verified tool catalog

Полный каталог инструментов. По каждому: имя, категория, риск-метка, требуемые credentials, требуемая ownership verification, доступные регионы, привязка к pinned image, audit history.

### K2. Tenant catalog access

Что разрешено в этом tenant. Объясняет, какие инструменты включены / выключены и почему.

### K3. Assessment effective catalog

Что разрешено в текущем assessment с учетом scope, target authorization, testing window, региональной политики. Каждый недоступный инструмент сопровождается объяснением: «нет credentials», «нет target authorization», «окно закрыто», «региональная политика», «tenant policy», «platform policy».

### K4. Audit history tool policy

Кто и когда менял правила доступа к инструментам в tenant и в assessment.

---

## Часть L. Audit Log

### L1. Просмотр audit log

Просмотр append-only audit. Фильтры: actor, tenant, project, assessment, action, resource type, resource id, диапазон времени.

Поля каждого события:

- actor (user или service);
- tenant;
- project;
- assessment;
- action;
- resource type;
- resource id;
- before / after метаданные где это безопасно;
- IP и user agent для пользовательских действий;
- timestamp;
- trace id.

Аудируется как минимум: login / logout, assessment approval, start / pause / resume / cancel, scope changes, tool policy changes, high-impact tool authorization changes, finding status changes, report generation, denied tool calls, LLM provider fallback, secret access.

### L2. Экспорт audit log

Выгрузка по фильтру для compliance-офицера (CSV / JSON / NDJSON), с trace id и timestamps. Сам экспорт — тоже event в audit.

---

## Часть M. Settings

### M1. Настройки tenant (только tenant_admin)

- название и slug;
- регион хранения данных;
- retention policy (если разрешено platform);
- список пользователей, их роли (platform_admin, tenant_admin, security_lead, operator, developer, auditor, viewer);
- приглашения, отозванные приглашения;
- SSO настройки;
- настройки 152-FZ posture (явный opt-in на external processing, если требуется);
- настройки уведомлений по событиям (email, webhook).

### M2. Настройки безопасности tenant

- политика паролей;
- обязательность MFA;
- ограничения по IP;
- настройки сессий;
- API tokens tenant (создание, отзыв, маскированный показ).

### M3. Настройки проекта

См. D4.

### M4. Настройки пользователя

- профиль;
- email и проверка email;
- смена пароля;
- MFA enrollment / disable;
- сессии и устройства;
- API tokens пользователя;
- настройки уведомлений;
- предпочитаемый язык (английский / русский);
- предпочитаемый часовой пояс.

### M5. Настройки уведомлений

Какие события приходят пользователю и каким каналом (in-app, email, webhook): HITL approval, validator confirmed finding, assessment status changes, отчет готов, threshold severity, OOB callback, scope denied attempt spike, engine health, queue backlog, LLM provider outage.

---

## Часть N. Платформенный admin (только platform_admin)

### N1. Tenants

Все tenants на инсталляции. По каждому: название, slug, регион, статус, число пользователей, число активных assessments, retention policy, последняя активность. Действия: создать tenant, заморозить tenant, удалить tenant (с retention-уважающим стиранием).

### N2. Verified tool catalog

Глобальный admin-экран: добавление, аудит, отзыв инструмента, привязка к pinned image, scoping инструмента к регионам, требования к credentials и ownership verification.

### N3. Skill library admin

Импорт skill library из pinned mirror, аудит, перевод skill в audited / pending / rejected. См. J3.

### N4. LLM routing

Конфигурация production model mapping и hybrid LLM routing по ролям агентов. Профили моделей, fallback chain, политика на использование внешних провайдеров. Просмотр LLM audit (provider, role, тип запроса, токены, стоимость, fallback).

### N5. Deployment policies

Политики окружений (local / dev / staging / production / internal-lab), требования к bootstrap token, политики ротации сессионных секретов, политики image digest deployment, политика «no in-place version change during active assessment unless emergency».

### N6. Engine fleet

Состояние Decepticon engine instances (по одному на assessment). Видимость: ассоциированный assessment namespace (assessment-{id}), статус контейнеров, heartbeat, network policies, secrets refs, resource quotas (CPU, memory, pods, storage, runtime), логи запуска / остановки / cleanup.

### N7. Workers fleet

��остояние workers: api, coordinator, http-worker, browser-worker, cyberstrike-worker, validator-worker, oob, report-builder, llm-gateway. Метрики: active assessments, queued assessments, assessment duration, worker job duration, worker failure rate, validator confirmation rate, candidate-to-confirmed ratio, findings by severity, Decepticon heartbeat latency, LLM calls by model, LLM cost by assessment, fallback count, denied scope actions, OOB callbacks count.

### N8. Очереди и job-jobs

Просмотр очередей, retry policy, idempotency keys, backlog. Возможность пересмотра застрявшего job, его повторной отправки или отмены — все через audit.

### N9. Object storage

Артефакт-хранилище: hot retention 90 дней, cold retention 1 год, артефакт-hash контракт, состояние bucket lifecycle. Поиск артефакта по hash и по assessment id.

### N10. Alerts и observability

Конфигурация alerts (Decepticon heartbeat missing, worker failure spike, validator failure spike, out-of-scope attempts spike, LLM provider outage, object storage write failure, queue backlog, assessment stuck beyond guard, K8s namespace cleanup failure). Подключение Sentry для frontend / backend / worker exceptions, source maps, release tracking. Явная гарантия: секреты и raw customer evidence не уходят в Sentry.

### N11. Изменение config платформы

Низкоуровневые изменения (через политики, не через свободный text-edit). Каждое изменение — event в audit log с before / after.

---

## Часть O. Состояния, ошибки и пограничные случаи

Эти экраны не являются «отдельными разделами», но обязаны быть.

### O1. Empty states

Пустой проект, пустой список targets, пустой список assessments, пустой список findings, пустой evidence, пустой audit log, пустой каталог skills, пустой verified tool catalog. Каждый empty state объясняет следующее действие.

### O2. Loading states

Долгие операции (генерация отчета, запуск assessment, замер scope preview, replay validator) показывают честный progress, не «бесконечный спиннер».

### O3. Error states

- 401 / истекшая сессия — увод на login с сохранением исходного маршрута;
- 403 / RBAC-отказ — объяснение, почему доступ запрещен (роль / tenant / project / assessment / tool policy / scope), без раскрытия чувствительной информации;
- 404 — объект не существует или не принадлежит вашему tenant (объединенное сообщение, чтобы не утекала информация о существовании объектов чужих tenants);
- 410 — bootstrap уже выполнен (для повторного захода на B1);
- 5xx — короткое сообщение и ссылка на статус;
- offline — сообщение и попытка переподключения.

### O4. Permission denied для action

Когда конкретное действие в UI запрещено (например, operator не может approve assessment) — само действие показывает причину запрета вместо «молча неактивно».

### O5. HITL approval pending

Если в live assessment есть pending approval — соответствующий экран и уведомление приоритизируются. В live view они видны без скролла.

### O6. Scope denied attempt

Если кто-то пытается выполнить действие вне scope — UI показывает denied audit event и ссылку на это событие в audit log.

### O7. Engine unhealthy

Если Decepticon heartbeat пропал, scheduling новых assessments блокируется, старт новог�� assessment показывает причину «engine unhealthy», а активные assessments идут в режиме graceful pause до восстановления.

### O8. Cost anomaly

Если cost analytics увидел anomaly — это уведомление, но не блокировка. UI явно подчеркивает: «budget caps не останавливают assessment».

### O9. Read-only режим (auditor / viewer)

Тот же UI, но без действий. Все элементы, ведущие к мутирующим действиям, либо скрыты, либо явно помечены как read-only с объяснением.

### O10. Локализация

Все тексты живут в двух локалях: английский и русский. Часть отчетов и страниц требует русской локализации (russian-language report, GOST R / FSTEC).

---

## Часть P. Карта переходов между экранами

Краткая логика, чтобы Claude Design понимал связность.

- Главная (A1) → «Как это работает» (A2), «Возможности» (A3), «Безопасность» (A4), «Цены» (A7), «Контакты» (A9), «Документация» (A8).
- Любая публичная страница → Login (B3) или Контакты (A9).
- Login (B3) → Дашборд (C1) либо MFA шаг 2.
- Дашборд (C1) → Assessment live (F4), Findings (G2), Evidence (H1), Reports (I3), Audit (L1).
- Проект (D3) → Targets (E1), Assessment builder (F2), Findings проекта, Reports проекта.
- Target (E3) → его assessments (F1), его findings (G1), его credentials (E4).
- Assessment list (F1) → Assessment builder (F2) → Approval (F3) → Live (F4) → Attack graph (F5) → Findings detail (G2) → Evidence viewer (H1) → Report (I2 → I3).
- Любой finding (G2) → Evidence (H1), Attack graph node (F5), Retest (G5), Audit (L1).
- Skill library (J1) → Skill detail (J2) → Audit workflow (J3, для admin).
- Tool policy (K1 → K2 → K3) → Audit history (K4).
- Settings tenant (M1) и user (M4) → security, sessions, tokens, MFA.
- Platform admin (N1–N11) — отдельный пласт, доступен только platform_admin.
- Любая ошибка (O3) ведет либо обратно в источник, либо в публичный статус (A11), либо в login (B3).

---

## Что Claude Design решает сам

- любая визуальная система: цвет, типографика, сетка, отступы, иконки, иллюстрации, фотография, темный / светлый режим;
- любая микровзаимодействующая сущность: ввод, контролы выбора, таблицы, списки, графы, диаграммы, тосты, модальные окна, drawers, табы, аккордеоны, sidebar / topbar / breadcrumbs;
- информационная архитектура внутри отдельного экрана, иерархия заголовков, порядок блоков (если в этом документе порядок не зафиксирован явно как смысловой);
- состояния hover / focus / active / disabled / loading / error / success;
- адаптивность под десктоп / планшет / мобильный;
- акцент бренда и его проявление в продукте.

Все, что выше, — содержательная карта. Все, что ниже визуальной формы, — задача дизайн-этапа.
