# Implementation Plan: Blackbox Pentest MVP

**Branch**: `002-blackbox-mvp` | **Date**: 2026-05-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-blackbox-mvp/spec.md`

## Summary

Build a self-serve blackbox pentest product on top of the existing Decepticon engine. Two tracks: **Quick** (automated, free in MVP, 4-step wizard, DNS-verified) and **Deep** (lead-gen form forwarded to operator via Telegram). Clean-slate UX — legacy expert-mode pages (`Targets`/`Builder`/`Approval`/`Projects`) are removed; the wizard replaces them. Backend extends the existing `server/` package with new modules for scan-orders, DNS verification, free-tier quota, deep-inquiries, GCP VM provisioning, findings ingest, PDF reporting, email, and Telegram notification. Scans execute on ephemeral GCP VMs (one per scan, torn down at completion). Real GCP is hit in CI on PR-merge + nightly smoke; unit + per-push integration tests use a fake provider per Constitution VI.

**2026-06-05 international pivot overlay**: this plan's GCP/Timeweb/RU
deployment details describe the current execution implementation, not the
product's market positioning. New product work should follow
`docs/project-current-context.md`: international-by-default, Clerk auth target,
provider-agnostic billing, and no new YooKassa-specific paths.

## Technical Context

**Language/Version**: TypeScript + Bun ≥ 1.1 (backend `server/`, agent `vps-agent/`), React 18 + Vite (frontend `apps/site/`).

**Primary Dependencies**:
- Backend: Hono, Drizzle ORM, Zod, `node:dns/promises`, Puppeteer (PDF render), Resend (transactional email).
- GCP REST API client (custom, ~250 LOC). gRPC client deferred — REST via gRPC-JSON transcoder is sufficient and lighter to maintain.
- Telegram Bot API client (thin fetch wrapper, ~80 LOC).
- Frontend: existing React Router setup, Tailwind classes already in place. No new framework.

**Storage**:
- SQLite (file-backed prod, in-memory in tests) — primary store per Constitution III.
- GCS-compatible object storage — evidence archives, per-scan key prefix, 30-day lifecycle policy.

**Testing**:
- `bun test` for unit + integration. Tests hit real SQLite in-memory; never mock DB or audit signer (Constitution VI).
- Playwright for E2E in `apps/site/e2e/`.
- fake cloud provider for unit/IT on every push. live cloud on PR-merge to `main` + nightly cron smoke.
- Contract test between `vps-agent` HMAC webhook payloads and backend receiver.

**Target Platform**:
- Backend runs on GCP VM (single instance for MVP, scale-out post-MVP).
- Per-scan ephemeral VMs in the selected production cloud region.
- Frontend served as static SPA from CDN-fronted bucket.
- Browsers: modern evergreen (Chrome, Firefox, Safari, Edge — last 2 versions).

**Project Type**: Web service (backend) + web frontend. Existing repo layout per Constitution III:
- `server/` — single Bun package, the entire backend
- `apps/site/` — React + Vite frontend
- `vps-agent/` — small TypeScript agent baked into VM image
- `external/decepticon/` — vendored, untouched

**Performance Goals**:
- Quick scan p90 ≤ 25 minutes from "Launch" click to "completed" (Spec SC-004).
- Deep-inquiry notification to operator channel ≤ 60 seconds (Spec SC-007).
- DNS verification poll cadence: at most every 5 seconds (Spec FR-010), backend caches DNS query result for ≥ 2 seconds to avoid hammering resolvers under multi-client load.
- Backend single-instance MVP capacity: ~100 concurrent scans cap (more is YAGNI for MVP).

**Constraints**:
- Constitution invariants (auth-proof, HMAC audit, egress isolation) — non-negotiable.
- No real-time SSE / WebSocket from backend to browser (Constitution V deletion list). Frontend uses HTTP polling at 3-second intervals on the Live page.
- Files ≤ 800 lines hard, ~200–400 typical (Constitution VII).
- Frontend `apps/site/` untouched semantics: we ADD new pages and DELETE removed pages; we do not refactor existing pages.
- No paid checkout in MVP (Spec FR-046 future-toggle). YooKassa registration is no longer relevant after the international pivot.
- All payment-track code (`server/src/payments/`) deferred to post-MVP. Future billing must be provider-agnostic and entitlement-based. The operator has no Stripe account as of 2026-06-05, so direct Stripe and Clerk Billing are not production defaults; near-term paid access is manual/offline credits, and future self-serve requires a Merchant-of-Record eligibility check.

**Scale/Scope**:
- MVP target: O(10²) users in first 3 months.
- 1 free Quick per user per 7 days → max ~14 scans / user / quarter → MVP infrastructure cost upper bound is manageable.
- GCP test folder quota: 5 VMs concurrent, 10 vCPU total, 20 GB RAM total.
- Deep inquiries: O(10¹) per month projection in MVP; operator-handled manually.
- Codebase: estimated ~3,000 new LOC backend + ~1,500 new LOC frontend across the wizard + Deep inquiry pages.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Principle-by-principle audit

| # | Principle | This plan's compliance | Status |
|---|---|---|---|
| I | Decepticon Untouched | All changes in `server/`, `apps/site/`, `vps-agent/`. No edits to `external/decepticon/`. Decepticon configured purely via env vars baked into cloud-init. | ✅ pass |
| II | Three Load-Bearing Invariants | (a) Auth-proof: DNS TXT verification gates every scan launch (Spec FR-008…FR-011) — this is the auth-proof invariant by another name. (b) HMAC audit: every state-changing operation emits via `emitSignedAudit()` (Spec FR-042). (c) Egress isolation: each scan provisions an ephemeral GCP VM and tears it down at completion (Spec FR-018). | ✅ pass |
| III | Single Binary, Single Package | Backend stays a single Bun package at `server/`. No `packages/*` created. Frontend at `apps/site/` is its own untouched package per existing layout. `vps-agent/` is a separate small TS package, unchanged in concept. | ✅ pass |
| IV | No Premature Abstraction | Concrete code paths only. No generic "scan engine adapter" layer — GCP is the one provider impl in MVP, behind a simple `CloudProvider` interface per Constitution's pluggable-provider clause. No multi-tenant framework, no plugin loader. | ✅ pass |
| V | YAGNI Ruthlessly | (a) MVP cuts: paid checkout, Test Accounts encrypted storage, automated Deep dispatch, multi-region foreign rollout, admin UI for refunds (use SQL directly). (b) Live UI uses HTTP polling, not SSE/WebSockets — direct match to Constitution V deletion list. (c) No project/team scoping beyond user_id. | ✅ pass |
| VI | Test-First (NON-NEGOTIABLE) | Every new function ships with a failing test first. Coverage floor 80% (already at 93.92% in 001 — we will not regress). Tests hit real SQLite in-memory. fake cloud provider for default test runs; live cloud only on PR-merge + nightly. | ✅ pass |
| VII | Files Small & Focused | All new modules sized at 80–350 LOC. Largest: `vps/gcp.ts` ~250 LOC (operation-polling + auth + spawn + teardown). Hard cap 800 LOC respected. | ✅ pass |
| VIII | Immutable Data | All Drizzle row reads treated readonly. State transitions use `db.update()` with explicit set clauses. No object mutation in service code. | ✅ pass |
| IX | Validate at Boundaries | Every new HTTP route gets a Zod schema (request body + URL params). Every webhook receiver Zod-validates payload before any other processing. | ✅ pass |
| X | Audit Everything State-Changing | New audit event types defined: `scan_order_created`, `dns_verify_requested`, `dns_verified`, `dns_verify_failed`, `free_quota_consumed`, `free_quota_refunded`, `vm_provisioning`, `vm_ready`, `vm_teardown`, `scan_started`, `finding_ingested`, `scan_completed`, `scan_failed`, `pdf_rendered`, `email_sent`, `inquiry_received`, `inquiry_telegram_sent`, `webhook_invalid_signature`. All emitted via `emitSignedAudit()`. | ✅ pass |

### Result

**All 10 principles pass. No deviations. Complexity Tracking section unused.**

The spec's "stream live progress events" language (FR-019) maps to HTTP polling at the implementation level — a tech-agnostic spec requirement satisfied without violating Constitution V's prohibition on real-time SSE/WebSocket to browser.

## Project Structure

### Documentation (this feature)

```text
specs/002-blackbox-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── openapi.yaml     # Phase 1 — public HTTP contract for apps/site + admin
│   └── webhook.md       # Phase 1 — HMAC-signed contract for vps-agent → server
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

### Source Code (repository root)

```text
server/                          # Single Bun package, Constitution III
├── src/
│   ├── auth/                    # existing — magic-link, unchanged
│   ├── audit/                   # existing — emitSignedAudit(); new event types added
│   ├── db/
│   │   ├── schema.ts            # MODIFY: drop targets/projects, add scan_orders,
│   │   │                        # deep_inquiries, scan_events; extend users
│   │   ├── client.ts            # existing — unchanged
│   │   └── migrations/          # NEW migrations for the schema deltas
│   ├── lib/                     # ids.ts, time.ts, hmac.ts — unchanged
│   ├── schemas/
│   │   ├── scan-orders.ts       # NEW — Zod for scan-order body + params
│   │   ├── deep-inquiries.ts    # NEW
│   │   ├── webhook-scan-complete.ts # NEW
│   │   ├── scans.ts             # MODIFY — drop unused fields
│   │   └── ...
│   ├── scan-orders/             # NEW module — wizard backend
│   │   ├── service.ts
│   │   ├── service.test.ts
│   │   └── lifecycle.ts         # state machine helpers
│   ├── dns-verify/              # NEW
│   │   ├── service.ts
│   │   ├── service.test.ts
│   │   └── resolver.ts          # cloudflare-bypass DNS resolution
│   ├── free-tier/               # NEW
│   │   ├── service.ts
│   │   └── service.test.ts
│   ├── deep-inquiries/          # NEW
│   │   ├── service.ts
│   │   └── service.test.ts
│   ├── vps/
│   │   ├── provider.ts          # NEW — CloudProvider interface
│   │   ├── gcp.ts            # NEW — concrete impl
│   │   ├── gcp.test.ts       # NEW — uses fake-GCP per Constitution VI
│   │   ├── gcp-real.test.ts  # NEW — live cloud, runs only with env flag
│   │   ├── cloud-init.ts        # NEW — bash template for VM bootstrap
│   │   ├── cloud-init.test.ts
│   │   └── hetzner.ts           # DELETE (vestigial, drop in same PR)
│   ├── scans/
│   │   ├── service.ts           # MODIFY — simplify, becomes downstream of scan-orders
│   │   └── ...
│   ├── findings/
│   │   ├── service.ts           # existing — unchanged
│   │   ├── ingest.ts            # NEW — parse YAML+md from webhook payload
│   │   └── ingest.test.ts
│   ├── reports/
│   │   ├── pdf.ts               # NEW — Puppeteer render
│   │   ├── pdf.test.ts
│   │   └── template.html.ts     # report HTML template
│   ├── notify/
│   │   ├── telegram.ts          # NEW
│   │   ├── telegram.test.ts
│   │   ├── email.ts             # NEW
│   │   └── email.test.ts
│   ├── routes/
│   │   ├── scan-orders.ts       # NEW
│   │   ├── deep-inquiries.ts    # NEW
│   │   ├── webhooks.ts          # MODIFY — add scan-complete handler
│   │   ├── scans.ts             # MODIFY — simplify
│   │   ├── targets.ts           # DELETE (legacy)
│   │   ├── projects.ts          # DELETE (legacy)
│   │   └── auth-proof.ts        # DELETE (legacy — DNS verify is the new auth-proof)
│   ├── jobs/
│   │   ├── runner.ts            # MODIFY — register new job kinds
│   │   ├── handlers/
│   │   │   ├── spawn-vm.ts          # NEW
│   │   │   ├── teardown-vm.ts       # NEW
│   │   │   ├── render-pdf.ts               # NEW
│   │   │   ├── send-scan-complete-email.ts # NEW
│   │   │   ├── poll-dns-verify.ts          # NEW (optional background poll)
│   │   │   └── scan-timeout-watcher.ts     # NEW (cron)
│   │   └── types.ts             # MODIFY — new job kinds
│   └── server.ts                # MODIFY — register new routes
├── scripts/
│   ├── cleanup-orphan-vms.ts    # NEW — cron-fired cleanup helper
│   └── verify-chain.ts          # existing
├── tests/
│   └── integration/
│       ├── scan-orders.test.ts          # NEW
│       ├── dns-verify.test.ts           # NEW
│       ├── free-tier.test.ts            # NEW
│       ├── deep-inquiries.test.ts       # NEW
│       ├── webhook-scan-complete.test.ts# NEW
│       ├── scan-lifecycle.test.ts       # NEW (live cloud when env set)
│       └── ...
└── package.json                 # MODIFY — add deps: puppeteer, resend

apps/site/                       # existing React app
├── src/
│   ├── App.tsx                  # MODIFY — register new routes, deregister legacy
│   ├── i18n.ts                  # MODIFY — add new translation keys
│   ├── pages/
│   │   ├── Marketing.tsx        # MODIFY — Quick + Deep CTAs
│   │   ├── Pricing.tsx          # MODIFY — Quick free + Deep CTA cards
│   │   ├── Dashboard.tsx        # MODIFY — "your scans" list
│   │   ├── Live.tsx             # MODIFY — polling-based progress
│   │   ├── Findings.tsx         # MODIFY — drill-down per finding
│   │   ├── Reports.tsx          # MODIFY — list + download PDF
│   │   ├── Settings.tsx         # MODIFY — quota status
│   │   ├── Login.tsx            # unchanged
│   │   ├── Trust.tsx, Method.tsx, Blog.tsx, Legal.tsx, Contact.tsx # unchanged
│   │   ├── scan-wizard/         # NEW
│   │   │   ├── ScanWizardContainer.tsx
│   │   │   ├── Step1AttackSurface.tsx
│   │   │   ├── Step2Safety.tsx
│   │   │   ├── Step3VerifyDomain.tsx
│   │   │   └── Step4Launch.tsx
│   │   ├── DeepInquiry.tsx       # NEW
│   │   ├── DeepInquiryThankYou.tsx # NEW
│   │   ├── Targets.tsx           # DELETE (legacy)
│   │   ├── AuthorizeTarget.tsx + test # DELETE (legacy)
│   │   ├── Builder.tsx           # DELETE (legacy)
│   │   ├── Approval.tsx          # DELETE (legacy)
│   │   └── Projects.tsx          # DELETE (legacy)
│   └── lib/
│       ├── api-client.ts        # MODIFY — new endpoints
│       └── poll.ts              # NEW — reusable polling hook
└── e2e/                         # Playwright
    ├── scan-wizard.spec.ts      # NEW
    ├── deep-inquiry.spec.ts     # NEW
    ├── free-quota.spec.ts       # NEW
    └── dns-timeout.spec.ts      # NEW

vps-agent/                       # ~50-line agent → grows ~150 LOC for MVP
├── src/
│   ├── runner.ts                # MODIFY — read new env vars, run Decepticon,
│   │                            # collect findings, sign + POST webhook
│   ├── webhook-sign.ts          # NEW — HMAC signing utility
│   └── evidence-upload.ts       # NEW — Object Storage upload
└── test/
    └── webhook-contract.test.ts # NEW — pairs with server-side receiver
```

**Structure Decision**: Existing 4-package layout per Constitution III is preserved. Backend changes are confined to `server/`. Frontend changes are confined to `apps/site/`. `vps-agent/` grows to support new env contract. `external/decepticon/` is not touched. New module folders inside `server/src/` follow the existing one-folder-per-domain pattern (`scan-orders/`, `dns-verify/`, `free-tier/`, `deep-inquiries/`, `notify/`, `reports/`). Legacy folders (`targets/`, `projects/`, `auth-proof/` routes — note: the `auth-proof/` *table* lives on as the conceptual basis but is replaced operationally by `scan_orders.dns_verified_at`) are deleted in the same migration.

## Complexity Tracking

> Constitution Check passed with zero deviations. This section is intentionally empty.
