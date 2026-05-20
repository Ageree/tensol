# T138 — Marketing.tsx final copy draft (OPERATOR REVIEW)

> **Status**: ⏸ AI-drafted starter material. Operator finalizes wording before
> these strings land in `apps/site/src/i18n.ts`.
>
> **DO NOT** paste into `i18n.ts` as-is. The current hero (L1/L2/L3 + heroBlurb)
> is FROZEN per user mandate (see memory `project_tensol_marketing_copy_rewrite_2026-05-10`).
> Hero variants below are alternatives the operator may A/B against the frozen
> baseline; everything else is paste-ready after operator edits.
>
> Sources of truth this draft was generated from:
> - `apps/site/src/pages/Marketing.tsx` (current structure)
> - `apps/site/src/i18n.ts` keys `t.marketing.*`
> - `docs/superpowers/specs/2026-05-19-blackbox-mvp-design.md` §2.6 Mythos positioning
> - Memory `project_tensol_landing_tightening_2026-05-10` (XBOW eval criteria,
>   manifesto/threat-rewrite, frameless 1fr/1fr layout)
> - `reference_xbow_pentest_eval_criteria` (6-axis buyer's-guide framework)

---

## 1. Hero variants (alternatives to FROZEN baseline)

Current FROZEN hero is held in `t.marketing.hero.l1/l2/l3 + heroBlurb`. These
three candidate sets are alternative tonalities the operator may use for
landing-page A/B testing or for a second-fold restatement. **Do not replace
the frozen hero without explicit user sign-off.**

### Variant A — Capability statement (matches XBOW "Autonomy" axis)

| Key | RU | EN |
| --- | --- | --- |
| `heroAltA.l1` | Та же атакующая способность. | Same offensive capability. |
| `heroAltA.l2` | Теперь под вашей подписью. | Now under your signature. |
| `heroAltA.l3` | Без человека в цикле. | Without a human in the loop. |
| `heroAltA.blurb` | Tensol запускает автономный пентест по одной ссылке. Подтверждённые уязвимости, подписанные доказательства, отчёт за 45 минут. | Tensol runs an autonomous pentest from a single URL. Validated vulnerabilities, signed evidence, report in 45 minutes. |

### Variant B — Asymmetry (matches "Validation" + "Safety" axes)

| Key | RU | EN |
| --- | --- | --- |
| `heroAltB.l1` | Атака против защиты — | Offense vs defense — |
| `heroAltB.l2` | теперь асимметрия в вашу пользу. | now the asymmetry is yours. |
| `heroAltB.l3` | — | — |
| `heroAltB.blurb` | Атакующие уже используют ИИ. Защитники — нет. Tensol ставит того же ИИ на вашу сторону: круглосуточный пентест, криптографически подписанные доказательства, нулевая возможность опровергнуть результат. | Attackers already use AI. Defenders don't. Tensol puts the same AI on your side: 24/7 pentesting, cryptographically signed evidence, zero room to dispute the result. |

### Variant C — Threat-first (matches user-preference for visceral framing)

| Key | RU | EN |
| --- | --- | --- |
| `heroAltC.l1` | ИИ уже взламывает. | AI is already breaking in. |
| `heroAltC.l2` | Человек — нет. | Humans aren't. |
| `heroAltC.l3` | Tensol — это ваш ИИ-атакующий. | Tensol is your AI attacker. |
| `heroAltC.blurb` | Команды злоумышленников запускают LLM-агенты против ваших периметров каждую ночь. Ручной пентест раз в год не догонит. Tensol запускает того же агента ежедневно — с вашего согласия, под вашей подписью, с реальным PoC к каждой находке. | Threat actors launch LLM agents against your perimeter nightly. A once-a-year manual pentest can't keep up. Tensol runs the same agent daily — with your consent, under your signature, with a real PoC for each finding. |

> **Operator decision**: pick one variant (or commission a fourth) and decide
> where it appears — replacement for frozen hero, second-fold restatement, or
> dedicated section like `MarketingThreatVariant`. Author note: Variant C
> matches recent user-pref signals (memory `feedback_force_line_count_via_font_not_breaks`
> tone test) most closely.

---

## 2. Mythos-positioning blocks (5–7 alternatives)

Design doc §2.6 calls for explicit positioning against three reference points:
pre-LLM scanners (Nessus, Acunetix, Nuclei), human pentesters, and other AI
products (XBOW, Pentera AI, etc.). The operator should pick 2–3 paragraphs
from this set and slot them into a new `t.marketing.mythos.*` namespace
referenced by a `MarketingMythos` component placed between
`MarketingManifesto` and `MarketingPipeline` on `Marketing.tsx`.

### M1 — vs pre-LLM scanners

**RU**: Сканер ищет известные уязвимости по шаблонам. Tensol воспроизводит мышление атакующего: формулирует гипотезу, проверяет её, переходит к следующей. Каждая находка — это подтверждённый PoC, а не «возможно, есть проблема».

**EN**: A scanner matches known vulnerabilities against templates. Tensol reproduces an attacker's reasoning: forms a hypothesis, validates it, chains to the next one. Every finding is a confirmed PoC — not "this might be a problem".

### M2 — vs human pentester (cost)

**RU**: Ручной пентест занимает 2–4 недели и стоит от ₽800 000. Tensol запускается за минуту, выдаёт отчёт за 45 минут, цена фиксирована: ≈150 000 ₽ за Plus, ≈350 000 ₽ за Premium. Качество доказательств не уступает: подписанная цепочка событий, видео PoC, воспроизводимая трасса.

**EN**: A manual pentest takes 2–4 weeks and starts at ~$8,000. Tensol launches in a minute, returns a report in 45 minutes, fixed price: $1,500 Plus, $3,500 Premium. Evidence quality is on par: signed event chain, PoC video, reproducible trace.

### M3 — vs human pentester (frequency)

**RU**: Раз в год — это вчерашняя модель. Tensol можно запускать каждую ночь после релиза: следующий деплой получит свежий отчёт до того, как его получат злоумышленники.

**EN**: Once a year is yesterday's model. Tensol runs nightly after each release: your next deploy gets a fresh report before threat actors do.

### M4 — vs XBOW (positioning differentiation)

**RU**: XBOW работает с программами bug bounty крупных компаний США. Tensol работает с российским и СНГ-бизнесом: 152-ФЗ, договорные NDA на русском, оплата в рублях через ЮKassa, инфраструктура в ru-central1. Атакующий движок сравним; обвязка — нет.

**EN**: XBOW serves US enterprise bug-bounty programs. Tensol serves Russian and CIS businesses: 152-FZ compliance, Russian-language NDAs, ruble billing via YooKassa, infrastructure in ru-central1. The attacker engine is comparable; the wrapper isn't.

### M5 — vs other AI-pentest products (transparency)

**RU**: Большинство AI-пентест-продуктов — это чёрная коробка. Tensol публикует архитектуру атакующего агента, открытое ядро Decepticon (Apache 2.0), описание шагов на странице /method, подписанные аудит-логи доступны заказчику.

**EN**: Most AI-pentest products are black boxes. Tensol publishes the attacker agent architecture, the open-source Decepticon core (Apache 2.0), step-by-step methodology on /method, and signed audit logs accessible to the customer.

### M6 — Validation axis (XBOW criteria)

**RU**: Каждая находка проходит через двойную проверку: атакующий агент эксплуатирует её и фиксирует трассу; валидатор воспроизводит эксплойт независимо. Только подтверждённые уязвимости попадают в отчёт. Ложноположительных результатов в отчёте — ноль.

**EN**: Every finding passes through double-validation: the attacker agent exploits it and records the trace; the validator reproduces the exploit independently. Only confirmed vulnerabilities make it into the report. False-positive rate in the final report: zero.

### M7 — Safety axis (XBOW criteria)

**RU**: Атака идёт только в пределах согласованного периметра, который вы определяете URL + DNS-верификацией владения. Каждое действие записывается в подписанный аудит. Если агент попытается выйти за периметр — система останавливает сканирование и эмитит событие `scope_violation_attempt`.

**EN**: Attacks stay within the authorized perimeter, which you define via URL + DNS ownership verification. Every action is recorded in the signed audit chain. If the agent attempts to step outside the perimeter, the system halts the scan and emits a `scope_violation_attempt` event.

> **Operator note**: M1/M4 are highest-priority on the RU landing because they
> address the two most common buyer objections («это же просто сканер?» / «а
> чем вы лучше XBOW?»). M6/M7 are essential for any enterprise-readiness
> conversation.

---

## 3. FAQ alignment with XBOW 6-criteria

Current `/pricing` FAQ (from memory `project_tensol_landing_tightening_2026-05-10`
§5) has 7 Q&As aligned roughly one-per-axis. T138 requires re-confirming the
mapping and patching any gaps. The table below is the operator's decision grid.

| XBOW axis | Existing FAQ Q (paraphrased) | Coverage | Gap → proposed new Q |
| --- | --- | --- | --- |
| **Validation** | «Откуда уверенность, что находка реальна?» | full | — |
| **Autonomy** | «Сколько человек участвует в одном сканировании?» | full | — |
| **Safety** | «Что если агент случайно сломает прод?» | full | — |
| **Integration** | «Как получить отчёт?» (PDF + signed JSON) | partial | **Add**: «Можно ли встроить Tensol в наш CI/CD?» → answer: «MVP не предусматривает CI-интеграцию; пишите через /contact, оценим объём.» |
| **Scalability** | «Сколько целей за раз?» | partial | **Add**: «Что если у нас 50 поддоменов?» → answer: «Plus сканирует один корневой домен и до 5 поддоменов. Premium — до 25 поддоменов. Больше — индивидуальная оценка через Deep inquiry.» |
| **Transparency** | «Что именно делал агент во время сканирования?» (audit chain) | full | — |
| **(7th, anchor)** | Цена / «Почему именно эта цена?» | full | — |

### New FAQ entries (paste-ready into `t.marketing.faq.*` or `t.pricing.faq.*`)

```ts
// In i18n.ts under t.pricing.faq.items (RU + EN):
{
  q: "Можно ли встроить Tensol в наш CI/CD?",
  a: "MVP не предусматривает программный API для CI. Сегодня запуск — через панель и оплату ЮKassa. Если CI-интеграция критична — напишите через /contact, мы рассмотрим интеграцию (webhook callback на ваш endpoint после завершения сканирования)."
},
{
  q: "Что если у нас 50 поддоменов?",
  a: "Plus покрывает корневой домен и до 5 поддоменов, обнаруженных через DNS-перебор. Premium — до 25 поддоменов. Если ваш периметр больше — обратитесь через Deep inquiry (форма на /pricing → «Свой объём»), оценим индивидуально."
}
```

**EN mirror**:

```ts
{
  q: "Can we integrate Tensol into our CI/CD?",
  a: "The MVP doesn't expose a programmatic CI API. Today, scans launch from the dashboard with YooKassa payment. If CI integration is critical, contact us via /contact — we can evaluate adding a webhook callback to your endpoint when a scan completes."
},
{
  q: "What if we have 50 subdomains?",
  a: "Plus covers the root domain and up to 5 subdomains discovered via DNS enumeration. Premium covers up to 25 subdomains. Larger perimeters: submit a Deep inquiry (form on /pricing → 'Custom scope') and we'll quote individually."
}
```

---

## 4. i18n.ts key plan

Operator merges into existing structure. Suggested layout:

```ts
// inside t.marketing
mythos: {
  vsScanner: { title, body }, // M1
  vsHumanCost: { title, body }, // M2
  vsHumanFreq: { title, body }, // M3
  vsXbow: { title, body }, // M4
  vsAiBlackbox: { title, body }, // M5
  validation: { title, body }, // M6
  safety: { title, body }, // M7
},
// Optional alternative-hero namespace (kept dormant unless operator activates):
heroAltA: { l1, l2, l3, blurb },
heroAltB: { l1, l2, l3, blurb },
heroAltC: { l1, l2, l3, blurb },
```

Both `ru` and `en` need identical key shape (memory `feedback_apps_site_tsconfig_i18n_gotchas`:
do NOT add `as const` to `en` — breaks `ru` typing).

---

## 5. Operator checklist before merging T138

- [ ] Pick zero-or-one alternative hero variant; decide placement (replace
      frozen / second-fold / dormant in i18n)
- [ ] Pick 2–3 Mythos blocks (recommend M1, M4, M6)
- [ ] Confirm 2 new FAQ entries (or replace with operator's own wording)
- [ ] Sweep RU copy for English residue (memory `feedback_no_english_terms_in_russian_version`):
      run `grep -E "[A-Za-z]{4,}" apps/site/src/i18n.ts` on diff and review
- [ ] Check title/blurb trailing-period rule (memory
      `project_tensol_landing_tightening_2026-05-10`: no trailing periods on
      landing titles/blurbs)
- [ ] Add `MarketingMythos` component to `Marketing.tsx` between
      `MarketingManifesto` and `MarketingPipeline`
- [ ] Re-flip T138 to `[x]` in `specs/002-blackbox-mvp/tasks.md` with the
      finalizing commit hash

---

## 6. What this draft deliberately does NOT do

- Does not touch `apps/site/src/pages/Marketing.tsx` or `i18n.ts`
- Does not finalize the hero (frozen per user mandate)
- Does not invent prices — pricing copy is owned by /pricing, not landing
- Does not write a /blog post (separate scope, Blog.tsx is a different surface)
- Does not promise CI integration (M5 explicitly says "if you ask")
