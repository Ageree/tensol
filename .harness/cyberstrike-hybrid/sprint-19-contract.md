# Sprint 19 Contract v2 — LFI/Path-Traversal Validator (Sentinel-Content Match)

**Generator:** generator-s19 (Sonnet 4.6)
**Phase:** 6 — Validation expansion (sprint 2)
**Base commit:** `5df0795` (S18 CLOSED)
**Baseline:** no-DB ~1074/0/N, full-PG 1330/1/19, AUDIT_ACTIONS=64, ENVELOPE_KINDS=8, RBAC_MATRIX=1575, B6 K=9
**v2 changes from evaluator REVISE r1:** M1 null-scope branch removed from validator (worker owns no_scope audit); M2 finding insertion removed from validator (worker calls findingsWriter); M3 body-cap 1MB added + unit test; M4 match-priority ordering unit test added; H1 PHP regex line-anchored; H2 findings.payload jsonb shape locked; H3 unmatched audit full AuditEmitterArgs shape locked; H4 RBAC pre-flight grep result locked (empty).

---

## Deliverables summary

| ID | Deliverable |
|---|---|
| A | `services/validator-worker/src/lfi-validator.ts` — NEW, sentinel-content match |
| B | `services/validator-worker/src/worker.ts` — extend with `handleLfiReplay` |
| C | `apps/api/src/scope-engine/start-decepticon-session.ts` — LFI envelope dispatch |
| D | `services/validator-worker/src/payload-schema.ts` — additive `validateLfiReplayPayloadSchema` |
| E | AUDIT_ACTIONS 64 → 67 (3 new `validator.lfi.*` actions) |
| F | ENVELOPE_KINDS 8 → 9 (`validator.lfi.replay`) |
| G | RBAC_MATRIX stays 1575 (no new resource — LFI reuses `finding`) |
| H | Tests: unit (`lfi-validator.test.ts`) + IT (`lfi-pipeline.test.ts`) |
| I | NO new migration. NO new table. NO new bytea. B6 K stays 9. |

---

## Acceptance Criteria

### A-19-LfiValidator — `lfi-validator.ts` implementation

- New file `services/validator-worker/src/lfi-validator.ts`.
- Exports `validateLfiCandidate(input: LfiValidatorInput, deps: LfiValidatorDeps): Promise<LfiValidationResult>`.
- **Input fields:** `candidateFindingId`, `tenantId`, `assessmentId`, `projectId?: string | null`, `affectedUrl` (the candidate URL containing the LFI path-traversal payload, e.g. `?file=../../../etc/passwd`), `scope: EffectiveScope` (non-null — worker handles null-scope before calling validator), `traceId`.
- **LFI does NOT embed an OOB token.** No `replayUrl` / `token` fields. No `oobCallbackLoader`.
- **Scope gate FIRST — before network egress (S13 lesson, P14).** `scope` is always non-null at this point (worker guards null-scope before calling validator). Calls `decide(scope, { kind: 'http_request', url: affectedUrl, method: 'GET' }, scopeDeps)`.
  - `decision.allowed === false` → emit `validator.lfi.replay_denied` audit (`outcome: 'denied'`, `resourceType: 'candidate_finding'`, `resourceId: candidateFindingId`, `metadata: { reason: decision.reason, affectedUrl }`) → return `{ status: 'out_of_scope', reason: decision.reason }`. **Zero HTTP calls made** — injected `httpClient` never invoked.
- **Replay (only if scope gate passes):** `httpClient.get(affectedUrl)` → returns `{ body: string }` where body is **already capped at 1MB** by the injected httpClient. Validator additionally truncates: `const safeBody = response.body.slice(0, 1_048_576)` before regex matching (belt-and-suspenders, M3).
- **Sentinel-content match** against `safeBody`. Match priority top-to-bottom (first match wins — M4):

  | Priority | Key | Regex |
  |---|---|---|
  | 1 | `unix_passwd` | `/^root:[x*]:0:0:/m` |
  | 2 | `unix_shadow` | `/^root:[!*$\w./]+:\d+:\d+:/m` |
  | 3 | `windows_hosts` | `/^# Copyright \(c\) 1993-\d{4} Microsoft Corp\./m` |
  | 4 | `windows_boot_ini` | `/^\[boot loader\]/m` |
  | 5 | `php_config` | `/^short_open_tag\s*=\s*(On|Off)/im` (H1 — line-anchored) |
  | 6 | `linux_generic` | `/^bin:[x*]:1:1:/m` |

- On **any match** → emit `validator.lfi.confirmed` audit (`outcome: 'success'`, `resourceType: 'candidate_finding'`, `actorId: 'validator-worker'`, `metadata: { sentinelKey, affectedUrl }`) → return `{ status: 'confirmed', sentinelKey }`. **Does NOT insert finding** — worker calls `findingsWriter` (M2).
- On **no match** → emit `validator.lfi.unmatched` audit (`outcome: 'success'`, `resourceType: 'candidate_finding'`, `actorId: 'validator-worker'`, `actorType: 'service'`, `actorName: 'validator-worker'`, `metadata: { affectedUrl }`) → return `{ status: 'unmatched' }`. No finding inserted (H3).
- On **scope deny** → `validator.lfi.replay_denied` audit as above, return `{ status: 'out_of_scope' }`. **Zero HTTP calls** (httpClient never invoked).

### A-19-LfiWorkerWiring — `handleLfiReplay` in worker.ts

- `services/validator-worker/src/worker.ts` gains exported function `handleLfiReplay(deps, envelope): Promise<HandlerOutcome>`.
- Mirrors `handleSsrfReplay` structure exactly (S18 worker.ts:491-625):
  1. Parse payload with `validateLfiReplayPayloadSchema.safeParse(envelope.payload)` — nack on invalid.
  2. **Required deps check:** if `!deps.lfiHttpClient` → emit `validation.inconclusive` audit with `{ outcome: 'failure', metadata: { reason: 'config_error', missing: 'lfiHttpClient' } }`, nack with `ScopeDenyError('lfi_config_error', ['lfi_deps_not_configured'])`.
  3. Load candidate via `deps.candidateLoader({ tenantId, candidateFindingId })` — nack `ScopeDenyError('lfi_candidate_not_found', ['lfi_candidate_not_found'])` if null or `candidate.type !== 'lfi'`.
  4. Load assessment via `deps.assessmentLoader({ tenantId, assessmentId })` — nack `ScopeDenyError('lfi_assessment_not_found', ['lfi_assessment_not_found'])` if null.
  5. `const scope = await deps.buildScope(payload.assessmentId)` — if null: **worker emits** `validator.lfi.replay_denied` audit (`outcome: 'denied'`, `resourceType: 'candidate_finding'`, `metadata: { reason: 'no_scope' }`) and returns `{ kind: 'ack' }` (terminal — no retry). **Validator is NOT called.** (M1 — worker owns null-scope audit)
  6. Call `validateLfiCandidate({ ..., scope: scope as EffectiveScope, affectedUrl: candidate.affectedUrl }, { scopeDeps: deps.scopeDeps, auditEmitter: deps.auditEmitter, httpClient: deps.lfiHttpClient })`.
  7. On `result.status === 'confirmed'` → `findingsWriter({ tenantId, assessmentId, candidateFindingId, type: 'lfi', severity: 'high', confidence: 'high', affectedUrl: candidate.affectedUrl, reproduction: { sentinelKey: result.sentinelKey, affectedUrl: candidate.affectedUrl, matchedSnippet: result.matchedSnippet ?? null }, validatorLog: [], validatedAt: (deps.clock ?? (() => new Date()))(), validatedBy: { status: 'confirmed' } })`. Swallow unique-violation (idempotent). (M2 — finding insertion in worker, not validator; H2 — reproduction jsonb shape locked)
  8. Return `{ kind: 'ack' }` for all non-nack paths (confirmed/unmatched/out_of_scope).
- `ValidatorWorkerDeps` interface extended with:
  - `lfiHttpClient?: { get(url: string): Promise<{ body: string }>; readonly callCount: number }`
- **No `oobCallbackLoader` for LFI** — field not added.

### A-19-LfiCoordinatorDispatch — LFI envelope dispatch in start-decepticon-session.ts

- `apps/api/src/scope-engine/start-decepticon-session.ts` extended: when `candidate.type === 'lfi'`, publish a `validator.lfi.replay` envelope.
- Payload inline object literal (mirror SSRF dispatch, no token):
  ```
  { tenantId, projectId, assessmentId, candidateFindingId, candidateType: 'lfi', traceId }
  ```
- **No token embedding** — LFI uses the candidate's `affectedUrl` loaded from DB (no OOB callback needed).
- `services/coordinator/src/payloads.ts` **NOT modified** (M2 frozen — same as SSRF R7).
- Existing `xss_reflected` and `ssrf` dispatch paths unchanged.

### A-19-LfiPayloadSchema — additive schema export

- `services/validator-worker/src/payload-schema.ts` gains additive export:
  ```typescript
  // Sprint 19 — LFI replay envelope payload schema (additive).
  // affectedUrl is intentionally absent — loaded from DB by worker (HIGH-1 S18 lesson).
  export const validateLfiReplayPayloadSchema = z.object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('lfi'),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  }).strict();
  export type ValidateLfiReplayPayload = z.infer<typeof validateLfiReplayPayloadSchema>;
  ```
- **No `affectedUrl` in the envelope payload** — worker loads `candidate.affectedUrl` from DB (HIGH-1 S18 codex lesson).
- All existing exports (`validateFindingPayloadSchema`, `validateSsrfReplayPayloadSchema`) unchanged.

### A-19-AuditActions — AUDIT_ACTIONS cardinality bump 64 → 67

- `packages/contracts/src/audit.ts` AUDIT_ACTIONS gains 3 new entries at the end:
  - `'validator.lfi.replay_denied'`
  - `'validator.lfi.confirmed'`
  - `'validator.lfi.unmatched'`
- `packages/contracts/src/audit.test.ts`:
  - Test description updated to include `Sprint 19 LFI validator (3)`.
  - Expected array includes all 3 under comment `// Sprint 19 — LFI validator (3).`
  - `expect(AUDIT_ACTIONS.length).toBe(67); // Sprint 19: 64 + 3 = 67`

### A-19-EnvelopeKind — ENVELOPE_KINDS cardinality bump 8 → 9

- `packages/contracts/src/queue-envelope.ts` ENVELOPE_KINDS gains `'validator.lfi.replay'` with comment `// Sprint 19 — validator-worker subscribes to replay LFI candidates.`
- `packages/contracts/src/queue-envelope.test.ts` updated: `expect(ENVELOPE_KINDS.length).toBe(9);`
- If `packages/queue/src/index.test.ts` has a canonical-list parity assertion: bump to match.

### A-19-RbacMatrix — NO change (stays 1575)

- No new resource. LFI findings use the existing `finding` resource.
- `packages/authz/src/matrix.test.ts`: `expect(RBAC_MATRIX.size).toBe(1575);` stays unchanged.
- **No role files modified.**
- **H4 pre-flight grep result (locked):** `grep -rn "'xss_reflected'\|'ssrf'" packages/authz tests/integration/auth apps/api/src/routes` returned **zero hits** at `5df0795` baseline. No type-enumeration sites exist that need `'lfi'` added. No surfaces beyond `findingsWriter(type:'lfi')` require updating.

### A-19-NoMigration — no new migration, no new table, no new bytea

- No file added under `packages/db/migrations/`.
- B6 rollback loop K stays 9 (`for (let i = 0; i < 9; i++)` in `migrations.test.ts` — unchanged).
- `tests/integration/db/schema-shape.test.ts` passes without any changes.
- `tests/integration/db/append-only.test.ts` — no new cases needed.
- `tests/integration/auth/helpers/auth-fixture.ts` — **no change needed** (no new tables, no new append-only tables).

### A-19-UnitTests — unit tests for lfi-validator.ts

- `services/validator-worker/src/lfi-validator.test.ts` (NEW).
- **Required test paths (minimum 4 + M3 + M4 = 6 required):**
  1. **Scope deny path (decide-denied):** `decide` returns `allowed=false` → `status === 'out_of_scope'`, `validator.lfi.replay_denied` audit emitted with `outcome:'denied'`, `httpClient.callCount === 0`.
  2. **Confirmed path (Unix passwd):** scope passes, `httpClient.get` returns `{ body: 'root:x:0:0:root:/root:/bin/bash\n...' }` → `status === 'confirmed'`, `sentinelKey === 'unix_passwd'`, `validator.lfi.confirmed` audit emitted.
  3. **Unmatched path:** scope passes, `httpClient.get` returns `{ body: 'hello world' }` → `status === 'unmatched'`, `validator.lfi.unmatched` audit emitted with `outcome:'success'`.
  4. **Oversized body (M3):** `httpClient.get` returns `{ body: 'A'.repeat(2_097_152) + 'root:x:0:0:' }` — sentinel only present beyond 1MB mark → `status === 'unmatched'` (body truncated before regex; sentinel match at byte 2M+ not seen). Confirms truncation is applied.
  5. **Match-priority ordering (M4):** body contains BOTH `root:x:0:0:root:/root:/bin/bash` AND `root:$6$abc:19000:0:` → `sentinelKey === 'unix_passwd'` (priority #1 over #2).
- **Additional sentinel category tests (one per remaining category):**
  6. Unix shadow: body `root:$6$salt$hash:19000:0:99999:7:::` → `sentinelKey === 'unix_shadow'`.
  7. Windows hosts: body `# Copyright (c) 1993-2009 Microsoft Corp.\n127.0.0.1 localhost` → `sentinelKey === 'windows_hosts'`.
  8. Windows boot.ini: body `[boot loader]\ntimeout=30` → `sentinelKey === 'windows_boot_ini'`.
  9. PHP config (anchored): body `short_open_tag = On\n` → `sentinelKey === 'php_config'`; body `<p>short_open_tag = On</p>` (inline in HTML, no newline at start of match) → `status === 'unmatched'` (anchor prevents false positive).
  10. Generic Linux fallback: body `root:x:0:0:root:/root:/bin/bash\nbin:x:1:1:bin:/bin:/sbin/nologin` → `sentinelKey === 'unix_passwd'` (priority #1; fallback linux_generic only fires when passwd line absent).
- **Coverage ≥80%** for `lfi-validator.ts`.

### A-19-IT — integration test: LFI pipeline

- `tests/integration/validator/lfi-pipeline.test.ts` (NEW).
- `resetAuthState` called in `beforeEach` AND `afterAll` (P27: `grep -c resetAuthState lfi-pipeline.test.ts ≥ 2`).
- **Happy path:** seed candidate with `type='lfi'`, `affectedUrl='http://target.local/?file=../../../etc/passwd'` → call `handleLfiReplay` → mock `lfiHttpClient.get` returns `{ body: 'root:x:0:0:root:/root:/bin/bash\n...' }` → `status === 'confirmed'` → `findings` row inserted with `type='lfi'` → `findings.reproduction` jsonb has `sentinelKey: 'unix_passwd'` + `affectedUrl` (H2 assertion) → `validator.lfi.confirmed` audit row in `audit_events` with `outcome='success'`.
- **Deny path:** assessment scope configured to deny the affectedUrl → `handleLfiReplay` returns `{ kind: 'ack' }`, `validator.lfi.replay_denied` audit emitted with `outcome='denied'`; `lfiHttpClient.callCount === 0`; no `findings` row inserted.
- **Unmatched path:** scope passes, `lfiHttpClient.get` returns `{ body: 'HTTP/1.1 200 OK\nContent-Type: text/html\n\n<html>...</html>' }` → `validator.lfi.unmatched` audit emitted with `outcome='success'` and `resource_type='candidate_finding'` (H3 assertion); no `findings` row inserted.
- **Missing deps path:** call `handleLfiReplay` with `lfiHttpClient` absent from deps → returns `{ kind: 'nack' }`, `validation.inconclusive` audit row in `audit_events` with `reason:'config_error'`.
- Mock `lfiHttpClient.get(url)` returns `{ body: string }` — no real HTTP.

### A-19-LintTC — lint and typecheck clean

- `bun run lint` → 0 errors.
- `bun run typecheck` → 0 errors.

### A-19-Tests — full suite within budget

- No-DB: ≥1074 pass / 0 fail (≥ baseline).
- Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`, no path filter per P40): ≤3 fail (≤3 flake budget; S11 baseline fail permitted).

### A-19-P36Compliance — generator does NOT write evaluator-result.md

- Generator writes `sprint-19-implementation-summary.md` only.
- No file named `sprint-19-evaluator-result.md` created by generator at any handoff.

---

## Pure-fn values (code-verified per P37)

- `AUDIT_ACTIONS.length` after S19: **67** (64 base + 3 = 67)
- `ENVELOPE_KINDS.length` after S19: **9** (8 base + 1 = 9)
- `RBAC_MATRIX.size` after S19: **1575** (unchanged — no new resource)
- B6 rollback loop K: **9** (unchanged — no new migration)
- New audit actions: `validator.lfi.replay_denied`, `validator.lfi.confirmed`, `validator.lfi.unmatched`
- New envelope kind: `validator.lfi.replay`
- New files: `services/validator-worker/src/lfi-validator.ts`, `services/validator-worker/src/lfi-validator.test.ts`, `tests/integration/validator/lfi-pipeline.test.ts`
- Modified files (non-test): `services/validator-worker/src/worker.ts`, `services/validator-worker/src/payload-schema.ts`, `apps/api/src/scope-engine/start-decepticon-session.ts`, `packages/contracts/src/audit.ts`, `packages/contracts/src/queue-envelope.ts`
- Findings reproduction jsonb shape: `{ sentinelKey: string, affectedUrl: string, matchedSnippet?: string | null }` (H2)
- PHP regex: `/^short_open_tag\s*=\s*(On|Off)/im` (H1 — line-anchored)
- Body cap: `safeBody = response.body.slice(0, 1_048_576)` before regex (M3)

---

## R# Risk notes (for evaluator)

| R | Risk | Mitigation |
|---|---|---|
| R1 | Sentinel regex false-positive on legitimate content | Acceptable by design — candidates only reach validator after decepticon has flagged the URL; PHP regex now line-anchored (H1) to reduce major false-positive risk |
| R2 | M2 frozen — coordinator/payloads.ts | Not modified; LFI dispatch uses inline literal in start-decepticon-session.ts only |
| R3 | HIGH-1 lesson (S18) — affectedUrl from DB not envelope | `affectedUrl` absent from schema; worker loads `candidate.affectedUrl` after DB fetch |
| R4 | httpClient.get signature difference from SSRF | LFI returns `{ body: string }`; SSRF returns `Promise<void>`. Different interface — do NOT reuse ssrfHttpClient |
| R5 | P27 — resetAuthState ≥2 per IT file | lfi-pipeline.test.ts calls resetAuthState in beforeEach + afterAll |
| R6 | No-scope null → ack (terminal) not nack | Worker owns null-scope: audit + ack, no validator call (M1). Mirror S18 SSRF worker.ts:557-576. |
| R7 | Body-cap DoS (M3) | Validator truncates at 1MB before regex; unit test confirms sentinel beyond 1MB not matched |

---

## Audit ownership split (M1 — explicit)

| Event | Owner | Trigger |
|---|---|---|
| `validator.lfi.replay_denied` reason:`no_scope` | **worker** (`handleLfiReplay` step 5) | `buildScope()` returns null — validator not called |
| `validator.lfi.replay_denied` reason:`<engine reason>` | **validator** (`validateLfiCandidate`) | `decide()` returns `allowed=false` — httpClient not called |
| `validator.lfi.confirmed` | **validator** | sentinel match |
| `validator.lfi.unmatched` | **validator** | no sentinel match |

---

## Verification matrix (evaluator will check)

| Gate | Method |
|---|---|
| A-19-LfiValidator | Read lfi-validator.ts; scope is EffectiveScope (non-null); scope-gate-first; callCount=0 on deny; 6 sentinel patterns w/ correct regexes; body truncation present; no findingsWriter call |
| A-19-LfiWorkerWiring | worker.ts handleLfiReplay exported; lfiHttpClient dep; candidateLoader+type check; null-scope→worker-audit+ack (not validator); confirmed→findingsWriter with locked payload shape |
| A-19-LfiCoordinatorDispatch | start-decepticon-session.ts LFI block; git diff coordinator/payloads.ts = empty |
| A-19-LfiPayloadSchema | payload-schema.ts additive; no affectedUrl in schema; existing exports unchanged |
| A-19-AuditActions | AUDIT_ACTIONS.length === 67 in no-DB run |
| A-19-EnvelopeKind | ENVELOPE_KINDS.length === 9 |
| A-19-RbacMatrix | RBAC_MATRIX.size === 1575 unchanged; impl-summary cites H4 grep result = empty |
| A-19-NoMigration | No new migration file; B6 K=9 unchanged; schema-shape.test.ts clean |
| A-19-UnitTests | 6 required paths (4+M3+M4) + sentinel categories; priority test (M4); PHP anchor false-pos test (H1); coverage ≥80% lfi-validator.ts; callCount=0 on deny |
| A-19-IT | 4 IT paths; P27 ≥2 resetAuthState; H2 findings.reproduction assertion; H3 unmatched audit full-shape assertion; mock httpClient |
| A-19-LintTC | 0/0 |
| A-19-Tests | ≥1074/0 no-DB; ≤3 PG fail (P35+P40) |
| A-19-P36Compliance | No sprint-19-evaluator-result.md written by generator |

---

## Stretch goal (non-gating)

### B-17a — Four-step rollback test for mig 020

Per S17/S18 backlog carry: dedicated file `tests/integration/db/mig020-rollback.test.ts` with four-step verification and `afterAll` re-applying all migrations. **Not a gate for S19 PASS verdict.** If skipped, carry to S20.
