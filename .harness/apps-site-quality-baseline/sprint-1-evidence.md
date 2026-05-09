# Sprint 1 Evidence — Playwright E2E

**Date:** 2026-05-09
**Result:** 59/59 tests passed

---

## Test run output

```
Running 59 tests using 5 workers

  ✓  auth.spec.ts › /login › renders, form present, email pre-filled
  ✓  auth.spec.ts › /login › lang switcher present
  ✓  auth.spec.ts › /login › step 1 submit advances to MFA step
  ✓  auth.spec.ts › /login › step 2 submit navigates away from /login
  ✓  auth.spec.ts › /login › email validation is deferred
  ✓  auth.spec.ts › /bootstrap › renders without crash
  ✓  auth.spec.ts › /invite › renders without crash
  ✓  dashboard.spec.ts › /dashboard renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /projects renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /targets renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /builder renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /approval renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /live renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /findings renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /reports renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /settings renders, AppShell present, heading visible
  ✓  dashboard.spec.ts › /err/401 renders without crash
  ✓  dashboard.spec.ts › /err/403 renders without crash
  ✓  dashboard.spec.ts › /err/404 renders without crash
  ✓  dashboard.spec.ts › /err/500 renders without crash
  ✓  dashboard.spec.ts › /err/offline renders without crash
  ✓  dashboard.spec.ts › /err/banana falls back to 404 content
  ✓  dashboard.spec.ts › /this-route-does-not-exist redirects to /err/404
  ✓  i18n.spec.ts › / — en and ru both clean
  ✓  i18n.spec.ts › /pricing — en and ru both clean
  ✓  i18n.spec.ts › /trust — en and ru both clean
  ✓  i18n.spec.ts › /contact — en and ru both clean
  ✓  i18n.spec.ts › /legal/privacy — en and ru both clean
  ✓  i18n.spec.ts › /legal/terms — en and ru both clean
  ✓  i18n.spec.ts › /legal/dpa — en and ru both clean
  ✓  i18n.spec.ts › /login — en and ru both clean
  ✓  i18n.spec.ts › /bootstrap — en and ru both clean
  ✓  i18n.spec.ts › /invite — en and ru both clean
  ✓  i18n.spec.ts › /dashboard — en and ru both clean
  ✓  i18n.spec.ts › /projects — en and ru both clean
  ✓  i18n.spec.ts › /targets — en and ru both clean
  ✓  i18n.spec.ts › /builder — en and ru both clean
  ✓  i18n.spec.ts › /approval — en and ru both clean
  ✓  i18n.spec.ts › /live — en and ru both clean
  ✓  i18n.spec.ts › /findings — en and ru both clean
  ✓  i18n.spec.ts › /reports — en and ru both clean
  ✓  i18n.spec.ts › /settings — en and ru both clean
  ✓  i18n.spec.ts › /err/401 — en and ru both clean
  ✓  i18n.spec.ts › /err/403 — en and ru both clean
  ✓  i18n.spec.ts › /err/404 — en and ru both clean
  ✓  i18n.spec.ts › /err/500 — en and ru both clean
  ✓  i18n.spec.ts › /err/offline — en and ru both clean
  ✓  i18n.spec.ts › EN/RU toggle works on /
  ✓  marketing.spec.ts › / loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /pricing loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /trust loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /legal/privacy loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /legal/terms loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /legal/dpa loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /contact loads, h1 visible, no console errors
  ✓  marketing.spec.ts › /contact form fields present and submit button is type=submit
  ✓  marketing.spec.ts › /contact empty submit shows validation errors, URL stays /contact
  ✓  marketing.spec.ts › /contact free-mail rejected with validation error
  ✓  marketing.spec.ts › default lang is ru

  59 passed (39.2s)
```

---

## R2 — h1 cardinality per marketing route

| Route | h1 count (visible, idle state) | Notes |
|---|---|---|
| `/` | 1 | `Marketing.tsx:117` |
| `/pricing` | 1 | `Pricing.tsx:94` |
| `/trust` | 1 | `Trust.tsx:105` |
| `/contact` | 1 | `Contact.tsx:317` (SuccessPanel h1 at :515 mutually exclusive — only after successful submit) |
| `/legal/privacy` | 1 | `Legal.tsx:212` |
| `/legal/terms` | 1 | `Legal.tsx:212` |
| `/legal/dpa` | 1 | `Legal.tsx:212` |

---

## R3 — /err/banana behavior

`ErrorScreen.tsx` line 28: `const resolved: Kind = isKind(kind) ? kind : '404'`
`KNOWN = ['401', '403', '404', '500', 'offline']` — `'banana'` not in list → resolved = `'404'`.
Renders: h2 with `t.err404Title`, glyph `'404'`, CTA button. No h1 on error routes (AppShell page uses h2).
Assertion used: `page.locator('h2').filter({ visible: true }).first()` has non-empty text.

---

## R4 — Login.tsx flow finding

- 2-step MFA flow confirmed (`step` state at `Login.tsx:11`)
- Step 1 → `setStep(2)` (MFA input `placeholder="123456"` appears)
- Step 2 → `navigate('/dashboard')`
- No email format validation — `onSubmit` calls `submit()` unconditionally
- Button text: step 1 = `t.authContinue` ("Continue" / "Продолжить"), step 2 = `t.authSignIn` ("Sign in" / "Войти")
- Selector used: `page.locator('form button').first()` (stable across both steps)
- **Validation deferred** — noted in SUMMARY.md backlog

---

## Files created

```
apps/site/playwright.config.ts
apps/site/e2e/README.md
apps/site/e2e/global-setup.ts
apps/site/e2e/global-teardown.ts
apps/site/e2e/fixtures/routes.ts
apps/site/e2e/fixtures/i18n-keys.ts
apps/site/e2e/fixtures/i18n-allowlist.ts
apps/site/e2e/helpers/dev-server.ts
apps/site/e2e/helpers/console.ts
apps/site/e2e/helpers/i18n.ts
apps/site/e2e/marketing.spec.ts
apps/site/e2e/auth.spec.ts
apps/site/e2e/dashboard.spec.ts
apps/site/e2e/i18n.spec.ts
.harness/apps-site-quality-baseline/sprint-1-contract.md
```

NO visual.spec.ts (Sprint 3 deliverable per R5).

`apps/site/package.json` modified: added `@playwright/test ^1.49.0` devDep + `"test:e2e": "playwright test"` script.

---

## Brand-DNA files — git diff clean

```
git diff --name-only apps/site/src/components/PixelWaveBg.tsx \
  apps/site/src/components/AuthShell.tsx \
  apps/site/src/components/AppShell.tsx \
  apps/site/src/i18n.ts \
  apps/site/src/data.ts
(empty output — no changes)
```

---

## LangSwitcher selector used

`[role=radiogroup][aria-label=Language]` — confirmed verbatim in `LangSwitcher.tsx:23-24`.

---

## i18n key-leak detector note

Filter in `e2e/i18n.spec.ts:57-60` (rev-1 implementation):
- Skip keys shorter than 3 chars (locale codes `en`/`ru` are in the allowlist anyway)
- Skip keys present in `KNOWN_NATURAL_WORDS` (explicit allowlist in `e2e/fixtures/i18n-allowlist.ts`)
- Apply `\b<key>\b` word-boundary regex to `body.innerText` for all remaining keys

The allowlist (`i18n-allowlist.ts`) contains 18 entries empirically verified by running the suite
and triaging which key matches were false positives. Each entry has a 1-line comment explaining
why it appears as real rendered content (e.g. `compliance` appears in the /trust compliance grid).

Files created includes:
- `apps/site/e2e/fixtures/i18n-allowlist.ts` (added at rev-1 patch, commit 763b298)
