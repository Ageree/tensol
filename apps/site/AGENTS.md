# Purpose

`apps/site` is the Sthrip Vite/React frontend for the public site, Clerk auth,
dashboard, scan wizard, review/whitebox views, settings, and Vercel production
deployment.

# Ownership

- Own React pages, reusable UI components, frontend REST/Convex clients,
  marketing copy surfaces, Playwright e2e tests, and Vercel app config.
- Public production target is `https://sthrip.dev`.

# Local Contracts

- Brand new user-facing work as Sthrip, not legacy Tensol/CyberStrike, unless a
  task explicitly targets legacy compatibility.
- User-facing product and marketing UI is English-only. Do not reintroduce the
  RU locale, visible language switcher, Cyrillic copy, or region-coded sample
  domains/names.
- Keep REST wire shapes snake_case in `src/lib/api-client.ts`; page components
  may read wire fields directly.
- Clerk is the target auth provider. `VITE_E2E_AUTH_BYPASS=true` is for local
  and e2e test flows only.
- Dashboard/settings free-Quick quota derivation treats `cancelled` and
  `failed` free-Quick scan orders as refunded terminal states; only non-refunded
  fresh free-Quick orders consume the visible slot.
- `/billing` is the authenticated OxaPay checkout surface for buying Sthrip
  scan credits; public pricing CTAs for Starter/Team/Pro should point there and
  stay aligned with the Convex billing catalog.
- Public legal surfaces must stay reachable for billing/domain review:
  `/legal/terms`, `/legal/privacy`, `/legal/refund`, and `/legal/dpa`.
- The old `/deep-inquiry` booking page is retired from the frontend. Do not add
  public "Book a scope call" CTAs unless the funnel is explicitly revived.
- `e2e/first-scan.spec.ts` is quarantined as legacy 001 API coverage. Current
  first-scan coverage should use `e2e/scan-wizard.spec.ts` and the
  `/v1/webhooks/scan-complete` specs.
- `vercel.json` is the production deploy contract for this app: Vite framework,
  `bun run build` so TypeScript runs before Vite, `dist` output, and SPA
  rewrite to `/index.html`.
- `vite.config.ts` keeps third-party modules in a single `vendor` manual chunk
  so the production entry chunk stays below Vite's warning threshold without
  circular manual chunk groups.
- Do not add frontend dependencies unless explicitly requested.

# Work Guidance

- Match the existing HackTron-inspired dashboard style: quiet light workspace,
  compact panels, square/low-radius controls, dense operational information.
- For UI changes, verify desktop and mobile layout; avoid whole-page horizontal
  overflow.
- Use lucide icons when an icon is needed and already available.
- Keep route-level behavior ergonomic: authenticated app screens should be
  usable directly from their canonical routes.

# Verification

- Type/build: `bun run --cwd apps/site typecheck` and
  `bun run --cwd apps/site build`.
- Formatting/lint for touched frontend files: `bunx biome check <paths>`.
- E2E where relevant: `bun run --cwd apps/site test:e2e` or a targeted
  Playwright spec/config.
- For local visual checks, run Vite with auth bypass when needed:
  `VITE_E2E_AUTH_BYPASS=true bun run --cwd apps/site dev --host 127.0.0.1`.
- For production deploys explicitly requested by the user, run Vercel CLI from
  `apps/site` and verify `https://sthrip.dev` plus the relevant production
  asset/content.

# Child DOX Index

No child Dox docs yet.
