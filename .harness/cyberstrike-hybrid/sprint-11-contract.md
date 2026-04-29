# Sprint 11 — Confirmed Finding UI — Contract v1

Generator: generator-s11 (cyberstrike-sprint-11)
Date: 2026-04-28

---

## Acceptance criteria (binary, file:line required on PASS)

| ID | Criterion |
|---|---|
| **A-UI-Visibility** | Confirmed finding from S10 visible in UI for owning tenant; NOT visible in second tenant session. Playwright e2e asserts both (cross-tenant attempt returns 403 + audit row `tenant.cross_tenant_attempt` or `rbac.deny`). |
| **A-UI-StatusAudit** | PATCH `/findings/:id/status` → `finding.status_changed` audit event emitted with old/new status in metadata. |
| **A-UI-CrossTenantArtifact** | GET `/evidence/:id` from second tenant session → 403 + `rbac.deny` or `tenant.cross_tenant_attempt` audit. |
| **A-UI-Sha256** | Evidence viewer displays sha256 from DB; e2e asserts displayed value matches object storage byte content sha256. |
| **A-UI-CriticalFlows** | Playwright e2e covers: login → `/projects` → `/projects/:id` → `/assessments/:id` → `/findings/:id` → status change. |
| **A-UI-RBAC** | Auditor session: mutate buttons hidden. Developer session: mutate buttons visible. Component test (Vitest + RTL) asserts both. |
| **A-UI-Coverage** | 80%+ line coverage on `apps/web/src/**` via Vitest component tests. |
| **A-UI-LintTC** | `bun run lint` 0 errors. `bun run typecheck` clean. |
| **A-UI-Tests** | no-DB: 0 fail. full-PG single run: 0 fail. Playwright e2e: 0 fail. |
| **A-UI-FixtureReset** | Every new IT file in `tests/integration/scope/` or other new dir has `await resetAuthState(fx.db)` in `beforeEach`. `grep -c resetAuthState` ≥ 2 per file. No new tables added (no migration needed — reuse S10 schema). |
| **A-UI-AuditCard** | `audit.ts` gets 1 new action `finding.status_changed`. `audit.test.ts` cardinality assertion updated to `toBe(45)`. |

---

## API deliverables

### New endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/assessments/:id/findings` | tenantGuard | List confirmed findings for assessment (status filter: confirmed only at creation, all statuses accessible) |
| GET | `/api/v1/findings/:id` | tenantGuard | Get single finding; 403 if cross-tenant |
| PATCH | `/api/v1/findings/:id/status` | tenantGuard; requires `change_status` on `finding` | Update status; emits `finding.status_changed` audit |
| GET | `/api/v1/evidence/:id` | tenantGuard; requires `read` on `evidence` | Return signed URL or inline bytes; 403 + audit if cross-tenant |

### RBAC enforcement (server-side)

- `assertCan(actor, 'finding', 'list')` on list findings
- `assertCan(actor, 'finding', 'read')` on get finding
- `assertCan(actor, 'finding', 'change_status')` on patch status
- `assertCan(actor, 'evidence', 'read')` on get evidence

Auditor role → `change_status` denied → 403. Developer role → allowed.

---

## UI deliverables (`apps/web`)

React 19 + Vite 6 + TanStack Router + TanStack Query + Tailwind CSS.

### Routes

| Path | Component | Auth |
|---|---|---|
| `/login` | LoginPage — email + password form, MFA challenge step | none |
| `/projects` | ProjectsPage — list + create | session required |
| `/projects/:id` | ProjectDetailPage — targets + assessment history | session required |
| `/assessments/:id` | AssessmentPage — status, timeline, candidate/confirmed count | session required |
| `/findings/:id` | FindingDetailPage — severity, confidence, status workflow, evidence list | session required |
| `/evidence/:id` | EvidenceViewerPage — screenshot inline, sha256 display, trace download | session required |

### Key UI invariants

- Optimistic UI only for status notes (non-critical). Status change itself awaits server confirmation.
- After status change: invalidate `['finding', id]` TanStack Query key.
- Auditor: `change_status` button hidden (check `actor.role === 'auditor'`).
- Developer: button visible; server double-enforces.

---

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | `apps/web` Vite + TanStack Router not in workspace yet | Set up Vite 6 + React 19 + TanStack Router from scratch; minimal shadcn/ui (copy primitives, no CLI). |
| R2 | No Playwright config yet | Add `playwright.config.ts` at root; e2e tests in `tests/e2e/scope/` or `tests/e2e/findings/`. |
| R3 | ObjectStorage not in RouteDeps for evidence endpoint | Add `objectStorage` to `RouteDeps` + `AppOptions`; thread through factory. |
| R4 | `finding.status_changed` not in AUDIT_ACTIONS | Add to `audit.ts`; bump cardinality assertion to 45. |
| R5 | `findingStatusSchema` — valid transitions | Accept any target status from the closed set; let route validate. Do not implement a state machine for findings status (S11 scope only). |
| R6 | Web coverage gate — Vitest for browser components | Use `@testing-library/react` + `jsdom` environment in Vitest for component tests. |
| R7 | Cross-tenant evidence — need tenant check at evidence layer | Load evidence row, compare `tenant_id` to actor tenant before returning bytes. |

---

## Out of scope (S11)

- Long timeline virtualization (virtualized list) — deferred.
- Signed URL expiry mechanism — LocalObjectStorage returns bytes directly; signed URL is a sync generation of the evidence endpoint URL.
- Pause/resume/cancel assessment from UI — display only; no mutate buttons for those (assessment state machine actions are separate).
- Report builder — Sprint 12.

---

## Invariants preserved

- Engine purity: `packages/scope-engine/src/` unchanged.
- Decepticon adapter: `packages/decepticon-adapter/src/` unchanged.
- Browser worker: `services/browser-worker/src/` unchanged.
- Validator worker: `services/validator-worker/src/` unchanged.
- P27: every new IT file has `resetAuthState` in `beforeEach`.
- P30: no new tables → no new trigger toggles needed.
- JSONB: no new JSONB writes in findings (status is a plain string column).
- DirectInsertForbidden: no new direct `insertInto('findings')` calls.
- Single PG run discipline (R3 from S7).
