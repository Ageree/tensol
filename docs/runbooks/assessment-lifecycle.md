# Runbook — Assessment Lifecycle (Sprint 5 A-Doc-2)

**Owner:** platform team
**Audience:** operators running pentests on CyberStrike Hybrid
**Last updated:** Sprint 5

This runbook covers the day-to-day workflow for shipping an assessment from
project setup through start. State transitions are gated by both the pure
state machine in `packages/contracts/src/assessment-state.ts` (single source
of truth — see [ADR 0005](../adr/0005-assessment-state-machine.md)) and
route-level checks (RBAC, ownership-verified gate on approve, R8 testingWindow
gate on start).

---

## 1. Operator workflow — happy path

### Step 1. Create a project

```http
POST /api/v1/projects
Cookie: cs_session=<...>
Content-Type: application/json

{ "name": "Q3 Pentest" }
```

- Roles: `security_lead`, `tenant_admin`.
- Names are unique per tenant. 409 `duplicate_name` on collision.
- Audit: `project.created`.

### Step 2. Register targets

```http
POST /api/v1/projects/:projectId/targets
Cookie: cs_session=<...>
Content-Type: application/json

{ "kind": "url", "value": "https://app.example.com" }
```

- Roles: `security_lead`, `tenant_admin`.
- Initial `ownershipStatus` is always `unverified` (server-stamped).
- Client-supplied `ownership_status` field → 400 (`.strict()`).

### Step 3. Submit ownership proof

```http
POST /api/v1/targets/:id/ownership-proof
Cookie: cs_session=<...>
Content-Type: application/json

{ "method": "dns_txt", "evidence": "verification=abc123..." }
```

- Evidence is capped at 8 KiB (R1).
- Method must be `dns_txt`, `http_meta`, or `manual_attestation`.
- Status flips to `pending`. A platform-admin-only endpoint (Phase 9) flips
  `pending → verified`.
- Audit: `target.ownership_proof.submitted`. Raw evidence is stored in
  `target_ownership_claims` (append-only); the audit row carries only
  `method` + `evidenceLength`.

### Step 4. Create the assessment

```http
POST /api/v1/projects/:projectId/assessments
Cookie: cs_session=<...>
Content-Type: application/json

{
  "name": "Initial scan",
  "testingWindow": {
    "start": "2026-05-01T00:00:00Z",
    "end":   "2026-05-08T00:00:00Z"
  },
  "highImpactCategories": [],
  "targetIds": ["<verified-target-id>"],
  "scopeRules": [
    { "ruleKind": "allow_url_prefix", "effect": "allow", "payload": { "prefix": "https://app.example.com" } }
  ]
}
```

- Initial state is `draft`.
- Cross-tenant target → 403 + `rbac.deny`.
- Target in another project of same tenant → 422 `invalid_targets`.
- Audit: `assessment.created`.

### Step 5. Submit for approval

```http
POST /api/v1/assessments/:id/submit
Cookie: cs_session=<...>
Idempotency-Key: <unique-string>
```

- Roles: `security_lead`, `tenant_admin`. NOT `operator`.
- Idempotency-Key REQUIRED (R6). Replays of the same key + body return the
  cached 2xx response (R2 — only 2xx is cached).
- Audit: `assessment.submitted`.

### Step 6. tenant_admin approves

```http
POST /api/v1/assessments/:id/approve
Cookie: cs_session=<tenant_admin>
Idempotency-Key: <unique-string>
```

- ONLY `tenant_admin` may approve (per Sprint 5 A-RBAC-1; security_lead lost
  this allow when Sprint 5 tightened the matrix).
- ALL targets on the assessment must have `ownership_status = 'verified'`,
  else 422 `unverified_high_impact_targets` with the offending target IDs.
- The DB transaction inserts an `assessment_approvals` row AND updates
  `assessments` (state, approved_by, approved_at) atomically (R5 dual-table).
- Audit: `assessment.approved`.

### Step 7. Start

```http
POST /api/v1/assessments/:id/start
Cookie: cs_session=<...>
Idempotency-Key: <unique-string>
```

- Roles: `security_lead`, `tenant_admin`, `operator`.
- R8 temporal gate fires AFTER the state-machine transition succeeds, BEFORE
  the DB write commits:
  - `now > testingWindow.end` → 422 `testing_window_expired` + audit
    `assessment.start.denied` (`outcome=denied`, `metadata.reason=window_expired`).
    Assessment stays in `approved`.
  - `now < testingWindow.start` → 422 `testing_window_not_yet_open` + audit
    `assessment.start.denied` (`metadata.reason=window_not_yet_open`).
  - `start ≤ now ≤ end` (or `testingWindow=null`) → state flips to `running`,
    audit `assessment.started`.
- Sprint 5 ships the state transition only. The queue dispatch lands in
  Sprint 7 — see the inline `// Sprint 7: enqueue assessment.start envelope here`
  comment in `apps/api/src/routes/assessments/assessments.ts`.

---

## 2. Recovery — cancelling a stuck assessment

```http
POST /api/v1/assessments/:id/cancel
Cookie: cs_session=<security_lead | tenant_admin | operator>
Idempotency-Key: <unique-string>
```

- Allowed from any non-terminal state (`draft`, `submitted`, `approved`,
  `running`, `paused`).
- Audit: `assessment.cancelled` with `metadata = { fromState, toState: 'cancelled', command: 'cancel' }`.
- **Sprint 7 hook:** when the source state was `running` or `paused`, the
  inline comment `// Sprint 7: enqueue queue cleanup envelope here` marks
  the spot where queue-dispatch cleanup will plug in.

---

## 3. Audit query — "who started assessment X?"

The per-assessment timeline is purpose-built for this:

```http
GET /api/v1/assessments/:id/timeline
Cookie: cs_session=<...>
```

- RBAC keys on `(role, assessment, read)` per A-RBAC-1 / R7. The Sprint 4
  `audit_log` allows are unaffected — the per-assessment timeline rides on
  the assessment resource's own grants.
- Returns rows filtered to `resource_type = 'assessment' AND resource_id = :id`,
  paginated like the Sprint 4 audit-events endpoint.
- Look for `action = 'assessment.started'` to find the start emission, or
  `assessment.start.denied` for blocked attempts.

Or query the DB directly (audit operators):

```sql
SELECT actor_name, occurred_at, action, after_state
FROM audit_events
WHERE tenant_id = '<tenant-uuid>'
  AND resource_type = 'assessment'
  AND resource_id = '<assessment-uuid>'
ORDER BY occurred_at DESC;
```

Use the `auditEventsForTenant` repo helper in code paths — it carries the
`__platform__` sentinel exclusion (Sprint 4 A11/A12) automatically.

---

## 4. Idempotency-Key conventions

- Header format: ASCII printable, no whitespace, 1–200 chars (regex
  `/^[\x21-\x7E]+$/`). UUIDv4 hex strings are a good default.
- Required for: submit, approve, start, pause, resume, cancel.
- Optional for: project create, target create, assessment create,
  ownership-proof submit (uniqueness guards already block duplicates).
- Cached responses: 2xx ONLY (R2). 4xx and 5xx never write a cache row, so
  retries always re-run the handler. This is intentional security policy —
  see ADR 0005 Decision rule on R2.
- Same key + different body → 422 `idempotency_conflict`. Choose a fresh
  key for a fresh action.
