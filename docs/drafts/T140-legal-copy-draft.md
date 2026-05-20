# T140 — Legal pages copy draft (LEGAL REVIEW REQUIRED)

> **⚠️ LEGAL REVIEW REQUIRED** — этот документ написан AI как стартовая точка
> для будущих юридических текстов. Перед публикацией обязательно прохождение
> через юриста, специализирующегося на 152-ФЗ и общих условиях SaaS.
> Любая прямая копипаста этого текста на сайт без юридической проверки —
> неприемлемый риск. Operator owns the final wording.
>
> **LEGAL REVIEW REQUIRED** (EN mirror) — this document was AI-drafted as a
> starting point only. Before publication it must pass review by counsel
> specializing in 152-FZ (Russian PII law) and standard SaaS terms. Operator
> owns the final wording.
>
> Sources of truth this draft was generated from:
> - `apps/site/src/pages/Legal.tsx` (current single-file legal page)
> - `docs/security-review-2026-05.md` (commit 5821bd8) — operator-supplied review
> - 152-ФЗ «О персональных данных» (federal law no. 152-FZ), articles 6, 9, 18.1, 19
> - Spec `specs/002-blackbox-mvp/spec.md` — FR-29 Deep inquiry, FR-32 evidence retention
> - Design doc `docs/superpowers/specs/2026-05-19-blackbox-mvp-design.md` §3 (data flow)

---

## 1. Deep-inquiry 152-ФЗ consent paragraph (paste into the Deep-inquiry form)

### RU (для формы /deep-inquiry)

> **Согласие на обработку персональных данных**
>
> Отправляя форму, я даю своё согласие ООО «Тензол» (далее — Оператор) на
> обработку моих персональных данных в соответствии с Федеральным законом
> от 27.07.2006 № 152-ФЗ «О персональных данных».
>
> **Перечень данных**: ФИО, контактный email, номер телефона, telegram-логин,
> название и URL компании, описание объёма работ, любые иные данные,
> добровольно указанные в форме.
>
> **Цели обработки**: формирование коммерческого предложения по индивидуальному
> аудиту безопасности, заключение договора NDA, последующая коммуникация по
> предмету обращения. Без вашего отдельного согласия данные не передаются
> третьим лицам, кроме случаев, прямо предусмотренных законодательством РФ.
>
> **Срок действия согласия**: до отзыва. Отзыв осуществляется письменным
> заявлением на адрес privacy@tensol.io. После отзыва Оператор уничтожает
> персональные данные в течение 30 календарных дней, за исключением данных,
> подлежащих обязательному хранению по закону (бухгалтерская первичка и т.п.).
>
> **Право на доступ**: вы имеете право в любой момент получить сведения об
> обрабатываемых данных, потребовать их уточнения, блокировки или уничтожения.
>
> [ ] Я ознакомлен(а) с [Политикой обработки персональных данных](/legal#privacy)
>     и даю согласие на обработку моих персональных данных на указанных условиях.

### EN (mirror, for non-RU users — also reachable via Deep-inquiry form)

> **Consent to personal-data processing**
>
> By submitting this form, I consent to OOO Tensol (the Operator) processing
> my personal data in accordance with Russian Federal Law No. 152-FZ of
> 27 July 2006 ("On Personal Data").
>
> **Data**: full name, contact email, phone number, Telegram handle, company
> name and URL, scope description, and any other data voluntarily provided
> in the form.
>
> **Purpose**: to prepare a commercial proposal for a custom security audit,
> conclude an NDA, and conduct follow-up communication on this matter. Data
> will not be shared with third parties without your separate consent, except
> as required by Russian law.
>
> **Term**: until withdrawn. Withdraw consent in writing to privacy@tensol.io.
> Upon withdrawal, the Operator deletes personal data within 30 calendar days,
> except for data subject to mandatory retention under law (e.g., accounting
> records).
>
> **Right of access**: you may at any time request information about the data
> processed, demand correction, blocking, or deletion.
>
> [ ] I have read the [Privacy Policy](/legal#privacy) and consent to
>     processing of my personal data on the terms above.

---

## 2. 30-day evidence retention notice (paste into Privacy + Terms)

### RU (для секции «Хранение доказательств» в Privacy)

> **Сроки хранения артефактов сканирования**
>
> По завершении сканирования Tensol сохраняет следующие артефакты в шифрованном
> хранилище Yandex Object Storage (регион ru-central1, серверное шифрование SSE):
>
> | Артефакт | Срок хранения |
> | --- | --- |
> | PDF-отчёт (финальный) | 30 календарных дней |
> | Подписанная цепочка событий (audit chain, JSON) | 30 календарных дней |
> | Видео-PoC, скриншоты, HTTP-трассы | 30 календарных дней |
> | Запись DNS-верификации владения целью | 30 календарных дней |
> | Метаданные сканирования в БД (status, timestamps, hash артефактов) | 24 месяца |
>
> По истечении 30 дней артефакты автоматически удаляются по жизненному циклу
> бакета. Вы можете запросить досрочное удаление через privacy@tensol.io или
> продление хранения по отдельному соглашению (тариф «Архив», цена по запросу).
>
> Метаданные в БД (без полезной нагрузки) сохраняются 24 месяца для целей
> учёта обращений, отчётности перед регуляторами и расчёта статистики
> сервиса в обезличенном виде.

### EN

> **Evidence retention**
>
> Upon scan completion, Tensol stores the following artifacts in encrypted
> Yandex Object Storage (region ru-central1, server-side encryption enabled):
>
> | Artifact | Retention |
> | --- | --- |
> | PDF report (final) | 30 calendar days |
> | Signed event chain (audit chain, JSON) | 30 calendar days |
> | PoC video, screenshots, HTTP traces | 30 calendar days |
> | DNS ownership verification record | 30 calendar days |
> | Scan metadata in DB (status, timestamps, artifact hashes) | 24 months |
>
> After 30 days, artifacts are auto-deleted by bucket lifecycle policy. You
> may request early deletion via privacy@tensol.io or extended retention by
> separate agreement ("Archive" tier, price on request).
>
> DB metadata (no payload) is retained for 24 months for accounting,
> regulatory reporting, and anonymized service-level statistics.

---

## 3. Free-Quick policy paragraph (paste into Terms § "Free Quick Scan")

### RU

> **Бесплатный быстрый аудит (Free Quick Scan)**
>
> В рамках демонстрационного периода зарегистрированный пользователь имеет
> право на **один (1) бесплатный быстрый аудит** в течение **7 (семи)
> календарных дней** с момента регистрации.
>
> Бесплатный аудит:
> - Запускается тем же атакующим агентом, что и платные сканирования, но
>   ограничен по объёму: один корневой домен, без перебора поддоменов,
>   глубина сканирования не выше уровня Quick.
> - Не подлежит возврату средств, поскольку плата за него не взимается.
> - Не подлежит регенерации отчёта по истечении 30 дней хранения.
> - Может быть отменён Оператором при подозрении на нарушение Допустимого
>   использования (попытка сканировать чужую инфраструктуру и т.п.).
>
> Платные тарифы (Plus, Premium) не имеют 7-дневного ограничения и могут быть
> запущены неограниченное количество раз в рамках оплаченной подписки.

### EN

> **Free Quick Scan**
>
> During the demo period, a registered user is entitled to **one (1) free
> Quick Scan** within **seven (7) calendar days** of registration.
>
> The free scan:
> - Runs through the same attacker agent as paid scans, but with reduced
>   scope: a single root domain, no subdomain enumeration, depth capped at
>   the Quick tier.
> - Is non-refundable, as no payment is collected.
> - Is not eligible for report regeneration after the 30-day retention
>   window expires.
> - May be cancelled by the Operator on suspicion of Acceptable Use
>   violation (attempting to scan third-party infrastructure, etc.).
>
> Paid tiers (Plus, Premium) are not subject to the 7-day window and may be
> launched any number of times within the paid subscription.

---

## 4. Operator checklist — 152-ФЗ compliance

### What the current implementation already provides (based on codebase review)

- [x] **Consent capture**: Deep-inquiry form has a consent checkbox (verify
      `apps/site/src/pages/DeepInquiry.tsx` and `t.deepInquiry.consent`)
- [x] **Encryption at rest**: Yandex Object Storage SSE enabled per
      `server/.env.yandex` and design §3.4
- [x] **Encryption in transit**: HTTPS-only via Caddy/nginx terminator (per
      quickstart.md deployment)
- [x] **Data localization**: all processing in ru-central1 region (Yandex
      Cloud, art. 18.1 152-FZ requirement for Russian-citizen data)
- [x] **Right of access foundation**: audit chain provides full event trail
      per data subject (`server/src/audit/`)
- [x] **Sanitization**: pre-LLM payload sanitization removes PII per design §5

### Gaps that operator + legal counsel must address before public launch

- [ ] **DPO designation**: 152-ФЗ art. 22.1 requires named Data Protection
      Officer for operators of significant scale. Operator currently below
      threshold but should designate proactively. Action: appoint DPO,
      publish contact (privacy@tensol.io alias).
- [ ] **Processing-purposes registry**: art. 22 requires written record of
      processing purposes. Action: draft `docs/legal/processing-registry.md`
      (internal), publish summary in Privacy.
- [ ] **Roskomnadzor notification**: art. 22 — Operator must file a notice
      with Roskomnadzor before starting processing. Operator may be exempt
      if processing is solely contractual; legal counsel to confirm.
- [ ] **Breach notification**: art. 21 — within 24 hours notify Roskomnadzor
      of incidents; within 72 hours full report. Action: add to
      `docs/runbooks/incident-response.md` (does not yet exist).
- [ ] **Cross-border transfer**: if any data crosses RU borders (e.g.,
      Telegram messages routed via Telegram servers in Singapore), separate
      explicit consent + Roskomnadzor permit required. Decision needed.
- [ ] **Children's data**: 14+ consent rules. Confirm Terms forbid under-18
      use; add age affirmation to signup.
- [ ] **Right of erasure SLA**: 152-ФЗ requires deletion within 30 days of
      request. Verify the implementation actually deletes from S3 + DB
      (audit chain rows cannot be deleted — see §5 below).

### Gaps re: audit-chain immutability vs 152-ФЗ deletion

The append-only signed audit chain (`server/src/audit/emit.ts`) cannot honor
a 152-ФЗ erasure request without breaking the cryptographic chain. **This is
a substantive legal issue** requiring counsel input:

- **Option A**: argue that audit rows contain no PII (only opaque IDs +
  event kinds + timestamps), so erasure does not apply. Requires
  sanitization audit.
- **Option B**: implement crypto-shredding — encrypt PII fields with a
  per-subject key, delete the key on erasure request. Audit chain remains
  intact; data becomes unreadable.
- **Option C**: accept that erasure breaks the chain and document this in
  Terms as a known limitation.

Operator must choose A, B, or C with counsel before any erasure request
arrives in production.

---

## 5. Privacy.tsx / Terms.tsx / DPA.tsx — section index

Current `Legal.tsx` appears to be a single page (verify). The operator should
expand it to three pages or three anchored sections. Suggested structure:

### Privacy (/legal/privacy)

1. Operator identity (ООО «Тензол», ИНН, юридический адрес — operator fills)
2. Categories of personal data processed (link to §1 form-consent above)
3. Purposes of processing
4. Legal basis (art. 6 — consent + contract performance)
5. Categories of recipients (none, save legal requirements)
6. Retention periods (link to §2 above)
7. Cross-border transfers (TBD per Roskomnadzor opinion)
8. Subject rights and how to exercise them
9. Cookie policy (minimal — analytics opt-in only)
10. Contact: privacy@tensol.io

### Terms (/legal/terms)

1. Definitions
2. Service description (Tensol = blackbox AI pentest SaaS)
3. Acceptable use (link to §6 below)
4. Free Quick policy (link to §3 above)
5. Paid tiers (Plus, Premium) — pricing per /pricing
6. Payment, refunds, cancellation
7. Evidence retention (link to §2 above)
8. Limitation of liability
9. Termination
10. Dispute resolution (RU jurisdiction)
11. Governing law (RU)

### DPA (/legal/dpa) — for B2B customers

Standard SaaS DPA template. Operator pulls from counsel-supplied boilerplate.
Anchor to 152-ФЗ-compliant sub-processor list (Yandex Cloud, Telegram, YooKassa).

---

## 6. Acceptable Use Policy (placeholder)

### RU

> **Допустимое использование Tensol**
>
> Tensol — инструмент для пентеста инфраструктуры, **владельцем которой
> является сам пользователь** или которой пользователь имеет письменное
> разрешение на тестирование.
>
> **Запрещено**:
> - Запускать сканирование против инфраструктуры, на которую у пользователя
>   нет доказуемого права. Tensol проверяет владение через DNS-верификацию
>   до запуска платного сканирования; обход верификации запрещён.
> - Использовать сервис для атак на инфраструктуру правительственных или
>   военных систем РФ или иных государств.
> - Использовать сервис для нарушения санкционных режимов.
> - Перепродавать сканирования без отдельного партнёрского соглашения.
>
> Нарушение Допустимого использования влечёт немедленное прекращение
> подписки без возврата средств и передачу данных в Роскомнадзор/МВД по
> их запросу.

### EN — mirror, operator translates.

---

## 7. Operator final checklist

- [ ] All §1–§6 drafts reviewed by 152-FZ counsel
- [ ] Operator identity fields filled (legal name, ИНН, юр. адрес)
- [ ] DPO appointed; privacy@tensol.io alias active
- [ ] Roskomnadzor notification filed (if required)
- [ ] Crypto-shredding vs audit-chain decision made (§4 Option A/B/C)
- [ ] `apps/site/src/pages/Legal.tsx` expanded into 3 routes
      (`/legal/privacy`, `/legal/terms`, `/legal/dpa`)
- [ ] i18n keys added under `t.legal.privacy.*`, `t.legal.terms.*`,
      `t.legal.dpa.*` (NOT directly inline in JSX)
- [ ] `apps/site/src/pages/DeepInquiry.tsx` consent paragraph wired
- [ ] No-English-in-RU sweep (memory `feedback_no_english_terms_in_russian_version`)
- [ ] T140 reflipped to `[x]` in tasks.md with finalizing commit hash and a
      pointer to the counsel-review record

---

## 8. What this draft deliberately does NOT do

- Does not edit `Legal.tsx` or `DeepInquiry.tsx` directly
- Does not commit operator identity fields (legal name, ИНН, address) — these
  belong only to the operator
- Does not file the Roskomnadzor notification
- Does not invent Operator counsel's legal opinion on cross-border transfer,
  DPO threshold, or audit-chain immutability — these are explicitly flagged
  as REVIEW REQUIRED
