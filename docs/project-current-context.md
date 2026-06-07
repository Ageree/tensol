# Project Current Context

**Updated:** 2026-06-07

This file is the current product-context overlay for agents and contributors.
Read it before relying on older specs, runbooks, or drafts.

## Brand And Production Identity

- The current public product brand is **Sthrip**.
- The current public domains are **`sthrip.dev`** and
  **`api.sthrip.dev`**.
- Legacy **Tensol**, **CyberStrike**, and **`tensol.ru`** references in the
  repo are historical or compatibility markers unless a task explicitly says
  it is working on legacy material.
- When an older doc conflicts on naming, domains, or "current production"
  identity, this file wins: treat **Sthrip / `sthrip.dev` /
  `api.sthrip.dev`** as authoritative for new work.

## Product Posture

- The product has pivoted from a Russia-first pentest product to an
  international security SaaS.
- User-facing positioning should assume international customers by default.
  Russia/CIS-specific language, ruble pricing, 152-FZ-only compliance framing,
  and single-country residency claims are legacy context unless a specific
  customer or deployment explicitly requires them.
- The current user-facing brand appears as **Sthrip** in the app copy and
  public-facing materials. Older docs may still say Tensol or CyberStrike;
  treat those as historical names unless a naming task says otherwise.
- Current production web posture is Sthrip-first: `https://sthrip.dev` is the
  main site/app and `https://api.sthrip.dev` is the default production backend,
  API, and webhook base unless a narrower Sthrip subdomain is explicitly
  documented as canonical in code or deploy config.
- Legacy `tensol.ru`, `tensol.dev`, `api.tensol.ru`, and `app.tensol.ru`
  references should be treated as legacy/historical unless a task is explicitly
  about old production evidence or backwards compatibility.

## Auth

- Clerk is the target authentication provider.
- Legacy magic-link, Telegram-link, and custom session flows may still exist in
  the current `server/` implementation, but new architecture should not deepen
  those paths unless the task is explicitly about legacy compatibility.

## Backend Direction

- Convex is the preferred candidate for the future control plane: application
  data, reactive queries, transactional mutations, user/org state, scan order
  state, findings, reports metadata, billing state, entitlement checks, and
  webhook idempotency.
- Heavy execution work should remain in dedicated workers/adapters unless a
  later design proves it belongs in Convex actions/workflows: VM provisioning,
  scan agents, local repo checkouts, SAST tooling, PDF rendering, object
  storage uploads, and provider-specific cloud teardown.
- Migration should be staged. Do not attempt a big-bang backend rewrite without
  lifecycle regression tests around scan-order transitions, quotas/refunds,
  webhook idempotency, audit events, and worker retries.

## Billing

- YooKassa is obsolete for the current international product direction.
- New billing work must be provider-agnostic. Prefer a domain model around
  billing accounts, customers, checkout sessions, subscriptions, payments,
  credits, and entitlements.
- As of 2026-06-05, the operator does **not** have a Stripe account. Do not
  choose a billing path that requires production Stripe availability.
- Clerk Billing can still be useful for local/dev prototypes and remains a
  possible future wrapper if Stripe becomes available, but it is **not** the
  current production billing path because Clerk Billing production payment
  processing requires Stripe.
- Current near-term production posture is `manual`: contact-led sales,
  offline/manual invoicing, and operator-granted scan credits/entitlements.
- Future self-serve billing should evaluate Merchant-of-Record providers that
  do not require the operator to own a Stripe account, such as Paddle, Lemon
  Squeezy, or Polar. Treat each as subject to eligibility, KYC, payout-country,
  sanctions, product-risk, tax, refund, and webhook/API verification before
  implementation.
- Scan launch authorization should depend on entitlements/credits, not on
  `payment_kind === "yookassa"` or ruble/kopeck fields.
- Existing `payment_kind`, `amount_kopecks`, `TENSOL_YOOKASSA_LIVE`, and
  `yookassa_live` references are legacy compatibility markers. Do not build new
  product behavior on top of them.
- Existing `TENSOL_*` env vars, internal identifiers, or compatibility labels
  are not proof that Tensol is the current production brand/domain.

## Deployment And Data Residency

- Production has moved off the legacy hosting stack. Treat Timeweb,
  `tensol.ru`, and `tensol.*` production assumptions as legacy/historical
  unless a task explicitly targets legacy evidence or backwards compatibility.
- Current production API runs on **Google Cloud Compute Engine**:
  `tensol-scanners` project, VM `sthrip-api-prod`, zone `europe-west1-b`,
  static IP `34.156.105.67`.
- DNS is managed in Vercel DNS. `api.sthrip.dev` has an explicit `A` record to
  `34.156.105.67`; the apex `sthrip.dev` frontend remains on Vercel.
- The production API entrypoint is `https://api.sthrip.dev`. Caddy terminates
  TLS on the GCP VM and reverse-proxies to the Bun/Hono server container on
  `127.0.0.1:3000`.
- Ephemeral scan VM lifecycle should use the GCP rail (`server/src/vps/gcp.ts`)
  and GCP service-account credentials. Do not add new cloud provider behavior.
- Evidence/report object storage is not yet fully migrated to a verified GCP
  storage adapter/configuration. Do not assume any S3-compatible object-storage
  default; configure an explicit GCS-compatible endpoint or implement a native
  GCS adapter before treating evidence/PDF/report rails as production-complete.
- Future deployment docs should support customer-selected regions/providers and
  explicit data-processing terms per engagement.

## Documentation Precedence

When older files conflict with this document, follow this document for new
product decisions. Historical evidence files may preserve old facts, but specs,
runbooks, generated design briefs, and future implementation plans should carry
the international, provider-agnostic assumptions above plus the current
Sthrip / `sthrip.dev` / `api.sthrip.dev` production identity.
