# Sprint 21 Contract v2 — PD-Stack Integration (subfinder + httpx + nuclei subprocess wrappers)

**Generator:** generator-s21 (Sonnet 4.6)
**Phase:** 4 — PD-stack recon integration (Sprint 1 of phase)
**Base commit:** `ff9b5ef` (S20 CLOSED)
**Baseline:** no-DB 1103/0/404, full-PG 1361/1/19, AUDIT_ACTIONS=73, ENVELOPE_KINDS=10, RBAC_MATRIX=1575, B6 K=9
**Review:** r1 REVISE resolved — B1/B2/B3/B4/B5 + C1/C2/C3 addressed below.

---

## Binary availability (pre-checked)

| Binary | Status | Path |
|---|---|---|
| `subfinder` | **MISSING** — not in PATH | n/a |
| `httpx` | present | `/opt/homebrew/bin/httpx` |
| `nuclei` | present | `/Users/saveliy/.local/bin/nuclei` |

Missing binary treatment: each binary absence is independent (C1/Option A — graceful degradation). `subfinder` absent → emit `recon.subfinder.error` reason:`config_error`, skip subfinder stage, proceed with `probeUrls = ['https://${primaryDomain}/']`. `httpx` absent → emit `recon.httpx.error` reason:`config_error`, skip httpx, proceed to nuclei against primary domain. `nuclei` absent → emit `recon.nuclei.error` reason:`config_error`, skip nuclei. Pipeline continues with whatever stages have working binaries. Install path: `brew install projectdiscovery/tap/subfinder`. Documented in implementation-summary.md.

All tests use injected `spawnFn` dep — no real binary invoked in any test path.

---

## Deliverables summary

| ID | Deliverable |
|---|---|
| A | NEW `services/recon-runner/src/index.ts` — package entry/re-exports |
| B | NEW `services/recon-runner/src/subfinder.ts` — subprocess wrapper |
| C | NEW `services/recon-runner/src/httpx.ts` — subprocess wrapper |
| D | NEW `services/recon-runner/src/nuclei.ts` — subprocess wrapper |
| E | NEW `services/recon-runner/src/types.ts` — shared output types |
| F | NEW `services/recon-runner/src/payload-schema.ts` — Zod schemas for recon envelope payloads |
| G | `apps/api/src/scope-engine/start-decepticon-session.ts` — add `recon.subfinder.run` envelope dispatch at assessment start |
| H | NEW `services/recon-runner/src/worker.ts` — queue worker handling `recon.subfinder.run` envelope, orchestrates subfinder→httpx→nuclei pipeline |
| I | AUDIT_ACTIONS 73 → 83 (+10 new `recon.*` actions) |
| J | ENVELOPE_KINDS 10 → 11 (+1: `recon.subfinder.run`) |
| K | RBAC_MATRIX stays 1575 (recon reuses `target`/`finding` resources) |
| L | NO new migration. B6 K stays 9. Discovered subdomains written to existing `targets` table (B1/Option A: no `source` field, `projectId` non-nullable in envelope schema). |
| M | Tests: unit (per-wrapper mocks + scope-deny paths + partial-absence path) + 1 IT (5 paths) |

---

## Architecture decision: recon coordination model

**Chosen model:** New `services/recon-runner` package as standalone worker (not inline in coordinator). Rationale:

1. **Separation of concerns** — recon is a long-running I/O-bound pipeline (subfinder can run 60s); inlining in start-decepticon-session.ts would block the coordinator response path.
2. **Queue-based dispatch** — coordinator publishes `recon.subfinder.run` envelope at assessment start; recon-runner worker subscribes and drives the pipeline asynchronously.
3. **Mirror pattern** — matches the validator-worker pattern (coordinator publishes → worker subscribes → worker owns findings/targets insertion).
4. **`start-decepticon-session.ts` change is additive and minimal** — one new `if (input.triggerRecon)` block publishes the `recon.subfinder.run` envelope. No behavioral change to existing decepticon flow.

---

## B1 resolution — Discovered subdomains → `targets` table (Option A, no migration)

**Schema verified at `packages/db/migrations/003_projects_targets.ts:24-50`:**
```
id, tenant_id, project_id (notNull references projects.id), kind, value,
ownership_status (default 'unverified'), created_at, updated_at, version
unique: (tenant_id, project_id, kind, value)
kind check: ('url','domain','ip','cidr','cloud_account','k8s_namespace','repo')
```

**Insert shape (Option A — no source field, no metadata, no assessment_id):**
```typescript
{ tenant_id: payload.tenantId, project_id: payload.projectId, kind: 'domain', value: subdomain }
```
- `source` field dropped. Provenance of discovery is captured in `recon.subfinder.run` audit `metadata.discoveredHosts: string[]`.
- `project_id` is notNull in schema — envelope payload `projectId` is **non-nullable** (`z.string().uuid()` not `.nullable()`). `start-decepticon-session.ts` enforces `triggerRecon: true` requires non-null `projectId` (C3).
- On unique-key conflict (subdomain already in targets) → swallow `UniqueViolationError` (idempotent upsert).
- IT assertions: IT happy path asserts `targets` row exists with `{ kind: 'domain', value: 'api.example.com', project_id: <id> }` (no `source` field asserted).

---

## Acceptance Criteria

### A-21-ReconRunner — `services/recon-runner/` package structure

- `services/recon-runner/src/index.ts` re-exports all public symbols.
- `services/recon-runner/src/types.ts` defines:
  ```typescript
  export interface SubfinderResult { readonly subdomains: readonly string[]; }
  export interface HttpxProbeResult {
    readonly url: string;
    readonly statusCode: number;
    readonly title: string;
    readonly tech: readonly string[];
    readonly webServer?: string;
  }
  export interface NucleiFinding {
    readonly templateId: string;
    readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    readonly info: { readonly name: string; readonly description?: string };
    readonly matched: string;
  }
  ```

### A-21-Subfinder — `subfinder.ts` subprocess wrapper

- Exports `runSubfinder(domain: string, deps: SubfinderDeps): Promise<string[]>`.
- `SubfinderDeps`:
  - `spawnFn` — injectable subprocess factory (default `Bun.spawn` / `child_process.spawn`).
  - `subfinderBin: string | undefined` — binary path from env `SUBFINDER_BIN`.
  - `auditEmitter`: same `AuditEmitter` type used in validator-worker.
  - `tenantId`, `assessmentId`, `projectId: string`, `traceId`.
  - `scopeDeps: ValidatorScopeDeps` + `scope: EffectiveScope | null`.
  - `timeoutMs?: number` — defaults to `SUBFINDER_TIMEOUT_MS ?? 60_000`.
- **Missing binary:** if `subfinderBin` is `undefined` → emit `recon.subfinder.error` audit reason:`config_error` + return `[]`. No subprocess spawned. Caller proceeds with fallback `probeUrls = [primaryDomain]`.
- **Null scope:** if `scope === null` → emit `recon.subfinder.denied` audit reason:`no_scope` + return `[]`. No subprocess spawned.
- **Scope gate BEFORE subprocess (S13/P14):** calls `decide(scope, { kind: 'http_request', url: 'https://${domain}/', method: 'GET' }, scopeDeps)`. Denied → emit `recon.subfinder.denied` audit (reason: engine decision reason) + return `[]`. Zero subprocess calls.
- **Subprocess invocation (allowed):** `subfinder -d <domain> -json -silent` with bounded `timeoutMs`.
- **JSON-lines parse:** each stdout line is `{ host: string }`. Collects `host` values into `string[]`. Malformed lines silently skipped (recon output is untrusted — parse defensively).
- **Subprocess error/timeout:** emit `recon.subfinder.error` audit + return `[]` (terminal — no retry).
- **Success:** emit `recon.subfinder.run` audit (`outcome: 'success'`, `metadata: { domain, discoveredHosts: string[], count: N }`). Returns `string[]`.

### A-21-Httpx — `httpx.ts` subprocess wrapper

- Exports `probeHttpx(urls: readonly string[], deps: HttpxDeps): Promise<HttpxProbeResult[]>`.
- `HttpxDeps`:
  - `spawnFn` — injectable subprocess factory.
  - `httpxBin: string | undefined` — if `undefined` → emit `recon.httpx.error` audit reason:`config_error` + return `[]`.
  - `auditEmitter`, `tenantId`, `assessmentId`, `projectId`, `traceId`.
  - `scopeDeps: ValidatorScopeDeps` + `scope: EffectiveScope | null`.
  - `timeoutMs?: number` — defaults to `HTTPX_TIMEOUT_MS ?? 30_000`.
- **Null scope:** if `scope === null` → emit `recon.httpx.denied` per url reason:`no_scope` + return `[]`. No subprocess.
- **Per-url scope gate (untrusted yields — B3):** for each url in `urls`, call `decide(scope, { kind: 'http_request', url, method: 'GET' }, scopeDeps)`. Every subfinder-discovered hostname is treated as untrusted attacker-controlled input until decide() rules on it. Denied (including `dns_resolution_failed` from NXDOMAIN) → emit `recon.httpx.denied` audit per url (NOT silent drop — telemetry surface). Only scope-approved urls are passed to the subprocess.
- **Missing binary:** if `httpxBin` is `undefined` → emit `recon.httpx.error` audit reason:`config_error` + return `[]`. Caller proceeds to nuclei with fallback url list.
- **Subprocess invocation (on approved urls):** `httpx -json -silent` with urls via stdin pipe. Bounded `timeoutMs`.
- **JSON-lines parse:** each stdout line is `{ url, status_code, title, tech, webserver }`. Maps to `HttpxProbeResult`.
- **Subprocess error/timeout:** emit `recon.httpx.error` audit + return `[]` (terminal).
- **Success:** emit `recon.httpx.run` audit (`outcome: 'success'`, `metadata: { inputCount: approvedUrls.length, aliveCount: N }`).
- Returns `HttpxProbeResult[]`.

### A-21-Nuclei — `nuclei.ts` subprocess wrapper

- Exports `runNuclei(url: string, deps: NucleiDeps): Promise<NucleiFinding[]>`.
- `NucleiDeps`:
  - `spawnFn` — injectable subprocess factory.
  - `nucleiBin: string | undefined` — if `undefined` → emit `recon.nuclei.error` audit reason:`config_error` + return `[]`.
  - `auditEmitter`, `tenantId`, `assessmentId`, `projectId`, `traceId`.
  - `scopeDeps: ValidatorScopeDeps` + `scope: EffectiveScope | null`.
  - `timeoutMs?: number` — defaults to `NUCLEI_TIMEOUT_MS ?? 120_000`.
  - `rateLimit?: number` — defaults to `25` (passed as `-rl <N>`).
- **Null scope:** emit `recon.nuclei.denied` reason:`no_scope` + return `[]`.
- **Scope gate BEFORE subprocess (P14):** `decide(scope, { kind: 'http_request', url, method: 'GET' }, scopeDeps)`. Denied → emit `recon.nuclei.denied` audit + return `[]`.
- **Subprocess invocation:** `nuclei -u <url> -json -silent -rl <rateLimit>` with bounded `timeoutMs`. Uses default/auto-updated templates (no `-t` flag). Empty template dir → nuclei exits 0 with no findings (not an error).
- **JSON-lines parse:** each stdout line is `{ "template-id": string, info: { name, description?, severity }, "matched-at": string }`. Maps to `NucleiFinding`.
- **Per-match audit:** for each parsed finding → emit `recon.nuclei.template_match` audit (`outcome: 'success'`, `metadata: { templateId, severity, matched }`) (C2 — `'success'` is valid per AUDIT_OUTCOMES enum at audit.ts:145).
- **Subprocess error/timeout:** emit `recon.nuclei.error` audit + return `[]` (terminal).
- **Success:** emit `recon.nuclei.run` audit (`outcome: 'success'`, `metadata: { url, findingCount: N }`).
- Returns `NucleiFinding[]`.

### A-21-PayloadSchema — `payload-schema.ts`

```typescript
export const reconSubfinderRunPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid(),        // non-nullable (B1/Option A — targets.project_id notNull)
  assessmentId: z.string().uuid(),
  primaryDomain: z.string().min(1).max(253),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
}).strict();
export type ReconSubfinderRunPayload = z.infer<typeof reconSubfinderRunPayloadSchema>;
```

Note: `projectId` is `z.string().uuid()` (not `.nullable()`). Envelope parse fails fast if null projectId is passed — prevents SQL FK constraint violation at runtime.

### A-21-Worker — `worker.ts` pipeline orchestrator

- Exports `handleReconSubfinderRun(deps: ReconWorkerDeps, envelope: JobEnvelope): Promise<HandlerOutcome>`.
- `ReconWorkerDeps` includes:
  - `db: Kysely<Database>` (for target insertion).
  - `auditEmitter`.
  - `assessmentLoader: (assessmentId: string) => Promise<{ tenantId: string } | null>` — **(B2) tenant binding dep.**
  - `buildScope: (assessmentId: string) => Promise<EffectiveScope | null>`.
  - `scopeDeps: ValidatorScopeDeps`.
  - `subfinderBin?: string` — from env `SUBFINDER_BIN`.
  - `httpxBin?: string` — from env `HTTPX_BIN`.
  - `nucleiBin?: string` — from env `NUCLEI_BIN`.
  - `spawnFn?` — injectable subprocess factory.
  - `targetWriter: (row: { tenantId: string; projectId: string; kind: 'domain'; value: string }) => Promise<void>` — upserts into `targets`, swallows unique-key violations.
  - `findingsWriter` — same interface as validator-worker (for severity≥medium nuclei findings).

**Pipeline steps:**

1. Parse payload with `reconSubfinderRunPayloadSchema.safeParse(envelope.payload)` — ack on parse failure (terminal; malformed envelope won't fix on retry).

2. **(B2) Tenant binding — BEFORE buildScope:** load `assessment = await deps.assessmentLoader(payload.assessmentId)`. If `assessment === null` OR `assessment.tenantId !== payload.tenantId` → emit `recon.subfinder.denied` audit (`outcome: 'denied'`, `metadata: { reason: 'assessment_mismatch', assessmentId: payload.assessmentId }`) → return `{ kind: 'ack' }`. The security property: `assessment.tenantId` is a DB-loaded value; `payload.tenantId` comes from the envelope. These are different sources — disagreement proves the envelope was forged or misrouted. Zero subprocess calls, zero downstream effects.

3. `const scope = await deps.buildScope(payload.assessmentId)` — if `null` → emit `recon.subfinder.denied` audit reason:`no_scope` → return `{ kind: 'ack' }` (terminal). No subprocess called.

4. Run `runSubfinder(payload.primaryDomain, { subfinderBin: deps.subfinderBin, spawnFn: deps.spawnFn, scope, scopeDeps, ... })` → `subdomains: string[]`.
   - **(C1) If subfinder absent or errors:** `subdomains` is `[]`; pipeline continues with `probeUrls = ['https://${payload.primaryDomain}/']` (graceful degradation — httpx still probes the primary domain).

5. **(B3) Untrusted subfinder yields invariant:** Every string in `subdomains` is untrusted attacker-controlled input from a third-party subprocess. The httpx wrapper's per-url `decide()` call (step 6) is the mandatory scope gate that validates each yield individually. Out-of-scope yields produce `recon.httpx.denied` audit rows per yield (NOT silent drops — telemetry surface required). `dns_resolution_failed` from `normalizeAction` within `decide()` when a subdomain fails DNS resolution also produces `recon.httpx.denied` reason:`dns_resolution_failed` per yield. The invariant: **no subfinder-yielded host reaches nuclei without individually passing decide().**

   Build `probeUrls`: for each discovered subdomain, prefix with `https://`; add `https://${payload.primaryDomain}/` as the primary. This forms the candidate list.

6. Run `probeHttpx(probeUrls, { httpxBin: deps.httpxBin, spawnFn: deps.spawnFn, scope, scopeDeps, ... })` → `aliveHosts: HttpxProbeResult[]`. Per-url decide() inside httpx wrapper enforces B3 invariant.
   - **(C1) If httpx absent or errors:** `aliveHosts = []`; pipeline continues to nuclei with fallback `[{ url: 'https://${payload.primaryDomain}/' }]`.

7. For each alive host url in `aliveHosts` (or fallback): run `runNuclei(url, { nucleiBin: deps.nucleiBin, spawnFn: deps.spawnFn, scope, scopeDeps, ... })` → `findings: NucleiFinding[]`.
   - **(B4) Per-finding write: each `findingsWriter` call is individually try/caught.** For each finding where `severity` is `'medium' | 'high' | 'critical'`: wrap `findingsWriter(...)` call in try/catch. On throw → emit `recon.nuclei.error` audit reason:`finding_write_failed` with `metadata: { templateId: finding.templateId }` → **continue loop** (do not short-circuit). All other findings in the same nuclei run are still attempted. Function never throws to caller.

8. Return `{ kind: 'ack' }` for all paths (recon is best-effort; never nack).

**Workers never nack:** config errors, scope denials, parse failures, write failures — all ack. Re-queuing recon would re-fire subprocesses that already ran or re-encounter the same config error.

### A-21-CoordinatorDispatch — `start-decepticon-session.ts` additive change

- `StartDecepticonInput` gains two optional fields: `triggerRecon?: boolean` and `primaryDomain?: string`.
- **C3 — Enforcement:** `StartDecepticonInput` is augmented with a runtime guard: if `triggerRecon === true` and (`primaryDomain` is undefined or `projectId === null`) → skip envelope publish + emit no audit (silent no-op with warning log). This prevents publishing a malformed recon envelope. Choice of runtime guard (not zod refinement) because `StartDecepticonInput` is an internal interface used by coordinator; adding a zod refinement would require restructuring the input validation path. Documented in implementation-summary.md.
- After all candidates are processed (end of candidate drain loop), if `input.triggerRecon === true` AND `input.primaryDomain !== undefined` AND `input.projectId !== null`:
  ```typescript
  const reconEnvelope: JobEnvelope = {
    jobId: randomUUID(),
    tenantId: input.tenantId,
    projectId: input.projectId,
    assessmentId: input.assessmentId,
    kind: 'recon.subfinder.run',
    idempotencyKey: `${input.parentEnvelope.idempotencyKey}:recon:${input.assessmentId}`,
    createdAt: clockIso(),
    attempt: 0,
    maxAttempts: 3,
    traceId: input.traceId,
    payload: {
      tenantId: input.tenantId,
      projectId: input.projectId,   // non-nullable (B1)
      assessmentId: input.assessmentId,
      primaryDomain: input.primaryDomain,
      traceId: input.traceId,
    },
  };
  await deps.queueAdapter.publish(reconEnvelope);
  ```
- `services/coordinator/src/payloads.ts` **NOT modified** (M2 frozen).
- When `triggerRecon` is absent/false: no envelope published — zero behavioral change to existing flow.

### A-21-AuditActions — AUDIT_ACTIONS cardinality bump 73 → 83

New entries appended (+10):
- `'recon.subfinder.run'`
- `'recon.subfinder.denied'`
- `'recon.subfinder.error'`
- `'recon.httpx.run'`
- `'recon.httpx.denied'`
- `'recon.httpx.error'`
- `'recon.nuclei.run'`
- `'recon.nuclei.denied'`
- `'recon.nuclei.error'`
- `'recon.nuclei.template_match'`

`packages/contracts/src/audit.ts`: append these 10 entries.
`packages/contracts/src/audit.test.ts`: `expect(AUDIT_ACTIONS.length).toBe(83); // Sprint 21: 73 + 10 = 83`

### A-21-EnvelopeKind — ENVELOPE_KINDS cardinality bump 10 → 11

- `packages/contracts/src/queue-envelope.ts` gains `'recon.subfinder.run'` with comment `// Sprint 21 — recon-runner worker subscribes to drive subfinder+httpx+nuclei pipeline.`
- `packages/contracts/src/queue-envelope.test.ts`: `expect(ENVELOPE_KINDS.length).toBe(11);`
- `packages/queue/src/types.ts` and `packages/queue/src/index.test.ts` — parity bump (mirror S20 pattern).

### A-21-RbacMatrix — NO change (stays 1575)

- No new resource. Recon reuses existing `target` and `finding` resources.
- `packages/authz/src/matrix.test.ts`: `toBe(1575)` unchanged.
- **Pre-flight grep:** `grep -rn "'xss_reflected'\|'ssrf'\|'lfi'\|'rce'" packages/authz tests/integration/auth apps/api/src/routes` — expected empty (no type-enumeration sites need updating for recon).

### A-21-NoMigration — no new migration, no new table

- No file added under `packages/db/migrations/`.
- B6 rollback loop K stays 9 (unchanged in `migrations.test.ts`).
- `tests/integration/db/schema-shape.test.ts` passes without changes.
- `targets` table write uses existing columns only: `{ tenant_id, project_id, kind: 'domain', value }`. No `source`, no `metadata`, no `assessment_id` (B1/Option A).

### A-21-UnitTests — unit tests for recon-runner wrappers

New unit test files:
- `services/recon-runner/src/subfinder.test.ts`
- `services/recon-runner/src/httpx.test.ts`
- `services/recon-runner/src/nuclei.test.ts`

**Required test paths — subfinder (5 paths):**
1. **Scope deny:** `decide` denied → `recon.subfinder.denied` audit, returns `[]`, `spawnFn.callCount === 0`.
2. **Null scope:** scope null → `recon.subfinder.denied` reason:`no_scope`, returns `[]`, `spawnFn.callCount === 0`.
3. **Missing binary:** `subfinderBin` undefined → `recon.subfinder.error` reason:`config_error`, returns `[]`, `spawnFn.callCount === 0`.
4. **Happy path:** mock `spawnFn` emits 3 JSON-lines `{ host }` → returns `string[]` length 3, `recon.subfinder.run` audit with `count: 3`.
5. **Subprocess error:** mock `spawnFn` exits non-zero → `recon.subfinder.error` audit, returns `[]`.

**Required test paths — httpx (6 paths):**
1. Scope deny per-url → `recon.httpx.denied` per denied url, denied url NOT passed to subprocess (spawnFn only sees approved urls).
2. Null scope → `recon.httpx.denied` for all urls, returns `[]`.
3. Missing binary → `recon.httpx.error` reason:`config_error`, returns `[]`.
4. Happy path → 2 JSON-lines results, returns `HttpxProbeResult[]` of length 2, `recon.httpx.run` audit with `aliveCount: 2`.
5. Subprocess error → `recon.httpx.error` audit, returns `[]`.
6. **(C1 / partial-absence):** `httpxBin` undefined while other bins present — wrapper returns `[]` + emits config_error audit, does NOT throw; caller continues pipeline.

**Required test paths — nuclei (7 paths):**
1. Scope deny → `recon.nuclei.denied` audit, returns `[]`, `spawnFn.callCount === 0`.
2. Null scope → `recon.nuclei.denied` reason:`no_scope`, returns `[]`.
3. Missing binary → `recon.nuclei.error` reason:`config_error`, returns `[]`.
4. Happy path (2 findings) → `recon.nuclei.template_match` audit emitted **per finding** (2 rows, `outcome: 'success'` — C2 confirmed), `recon.nuclei.run` audit emitted once, returns `NucleiFinding[]` length 2.
5. Subprocess error → `recon.nuclei.error` audit, returns `[]`.
6. Severity threshold: finding with `severity: 'info'` is included in returned `NucleiFinding[]` but NOT passed to `findingsWriter` (caller/worker filters by severity).
7. **(B4) Per-finding write failure — middle-throw:** nuclei returns 3 findings (all `severity: 'medium'`). Mock `findingsWriter` throws on call #2. Worker-level test (in `worker.test.ts` or `nuclei.test.ts`): assert `findingsWriter` called 3 times total (1, 2-throw, 3), `recon.nuclei.error` reason:`finding_write_failed` audit emitted with templateId of finding #2, function returns normally without rethrowing.

**Coverage ≥80%** for each new source file in `services/recon-runner/src/`.

### A-21-IT — integration test: recon pipeline (5 paths, P45 mandatory PG run)

- `tests/integration/recon/recon-pipeline.test.ts` (NEW).
- **P45 mandate: generator MUST run full-PG on this file before ready-for-review SendMessage.**
- `resetAuthState` called in `beforeEach` AND `afterAll` (P27: `grep -c resetAuthState recon-pipeline.test.ts ≥ 2`).

**Path 1 — Happy path (mocked binaries, in-scope subdomain):**
Seed assessment with project (non-null projectId), scope allowing `example.com` and `api.example.com`. Call `handleReconSubfinderRun` with mocked `spawnFn`: subfinder emits `{ host: "api.example.com" }`, httpx emits `{ url: "https://api.example.com/", status_code: 200 }`, nuclei emits `{ "template-id": "http-missing-headers", info: { name: "Missing Headers", severity: "medium" }, "matched-at": "https://api.example.com/" }`. Assertions: `targets` table has row `{ kind: 'domain', value: 'api.example.com', project_id: <seeded-project-id> }` (no source field — B1); `findings` table has row with `severity='medium'`; `recon.subfinder.run` + `recon.httpx.run` + `recon.nuclei.run` + `recon.nuclei.template_match` audit rows in `audit_events`.

**Path 2 — Scope deny (subfinder stage):**
Scope configured to deny `example.com`. Assert: `{ kind: 'ack' }` returned, `recon.subfinder.denied` audit in `audit_events`, `spawnFn.callCount === 0`, no `targets` row inserted, no `findings` row.

**Path 3 — Tenant binding mismatch (B2):**
Seed assessment owned by tenant B. Send envelope with `payload.tenantId = tenantA_id`. Assert: `recon.subfinder.denied` reason:`assessment_mismatch` audit, `spawnFn.callCount === 0`, no `targets` row, no `findings` row. Return `{ kind: 'ack' }`.

**Path 4 — Config error (all bins undefined, C1):**
`subfinderBin`, `httpxBin`, `nucleiBin` all undefined. Assert: at minimum `recon.subfinder.error` reason:`config_error` audit row present; return `{ kind: 'ack' }`, no `targets` row, no `findings` row. (Httpx + nuclei config_error audits may also be present depending on pipeline fallback path — either outcome acceptable.)

**Path 5 — (B3) Mixed subfinder yield: in-scope + out-of-scope subdomain:**
Scope allows `example.com` but denies `evil.example.com`. Mock subfinder emits both `{ host: "api.example.com" }` (in-scope) AND `{ host: "evil.example.com" }` (out-of-scope). Assert: `recon.httpx.denied` audit row with metadata containing `evil.example.com`; `targets` row exists for `api.example.com` only; no `targets` row for `evil.example.com`.

P27: `grep -c resetAuthState tests/integration/recon/recon-pipeline.test.ts ≥ 2`.

### A-21-LintTC — lint and typecheck clean

- `bun run lint` → 0 errors.
- `bun run typecheck` → 0 errors.

### A-21-Tests — full suite within budget

- No-DB: ≥1103 pass / 0 fail (≥ baseline).
- Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`, no path filter per P40): ≤3 fail (≤3 flake budget; S11 baseline + B-18a carry permitted).

### A-21-P36Compliance — generator does NOT write evaluator-result.md

- Generator writes `sprint-21-implementation-summary.md` only.
- No file named `sprint-21-evaluator-result.md` created by generator at any handoff.

---

## Pure-fn values (code-verified per P37)

- `AUDIT_ACTIONS.length` after S21: **83** (73 base + 10 = 83)
- `ENVELOPE_KINDS.length` after S21: **11** (10 base + 1 = 11)
- `RBAC_MATRIX.size` after S21: **1575** (unchanged)
- B6 rollback loop K: **9** (unchanged — no new migration)
- New audit actions (10): `recon.subfinder.{run,denied,error}`, `recon.httpx.{run,denied,error}`, `recon.nuclei.{run,denied,error,template_match}`
- New envelope kind (1): `recon.subfinder.run`
- New package: `services/recon-runner/`
- New files (non-test): `services/recon-runner/src/{index,types,payload-schema,subfinder,httpx,nuclei,worker}.ts`
- Modified files (non-test): `apps/api/src/scope-engine/start-decepticon-session.ts` (additive), `packages/contracts/src/audit.ts`, `packages/contracts/src/queue-envelope.ts`, `packages/queue/src/{types,index.test}.ts`
- `targets` insert shape: `{ tenant_id, project_id, kind: 'domain', value }` — no `source` or `metadata` column (B1/Option A)

---

## Pre-baked codex lessons (all carry from S18–S20 — applied in v2)

| # | Lesson | Application in S21 v2 |
|---|---|---|
| B2/S18 HIGH-1 | Cross-assessment binding via DB-loaded source BEFORE buildScope | `assessmentLoader` dep: load assessment row, verify `assessment.tenantId === payload.tenantId` BEFORE `buildScope`. DB-loaded vs envelope — different sources, can disagree. IT path 3 asserts tenantId mismatch → denied+ack. |
| S18 MED-2 | Required deps no-silent-fallback | Per-binary independent check (C1/Option A). Each wrapper checks its own bin. Missing → `config_error` audit + return `[]` + pipeline degrades gracefully to next stage. |
| S18 P2 | Null buildScope → worker audits + ack, subprocess NOT called | Worker step 3: `scope === null` → `recon.subfinder.denied` reason:`no_scope` + ack, no subprocess. |
| S19 MED | Subprocess error → terminal ack, no retry | All three wrappers: catch around spawn → emit `recon.*.error` + return `[]`. Worker always returns `ack`. |
| P14/S13 | Scope-decide BEFORE subprocess (B3) | Each wrapper calls `decide()` before `spawnFn`. httpx wrapper's per-url decide() enforces B3 untrusted-yields invariant. NXDOMAIN → `dns_resolution_failed` deny, not an error. |
| P47 | Side-effect-bearing payloads → terminal-ack on store failure (B4) | Per-finding try/catch in nuclei write loop. On throw → `recon.nuclei.error` reason:`finding_write_failed` + continue loop. Overall ack. Loop never short-circuits. |
| P46 | Shell-payload placeholder substitution | N/A for recon. |

---

## Backlog carries from S20 (non-gating)

- **B-20codex-a** — `validator.rce.replay_denied` audit reason semantics review.
- **B-20codex-b** — Decepticon-adapter `<TOKEN>` zod enforcement.
- **B-20a** — Rename `RceValidatorInput.affectedUrl` → `replayUrl`.
- **B-20b** — Per-validator OOB poll timeout tunables.
- **B-19codex-a/b**, **B-19a**, **B-18a/b/c**, **B-17a** — unchanged carries.

---

## Verification matrix (evaluator will check)

| Gate | Method |
|---|---|
| A-21-ReconRunner | ls services/recon-runner/src/; read index.ts + types.ts |
| A-21-Subfinder | scope-gate-first; spawnFn.callCount=0 on deny/null-scope/missing-bin; JSON-lines parse; timeout bounded |
| A-21-Httpx | per-url scope gate (B3 invariant); denied → `recon.httpx.denied` per url NOT silent drop; dns_resolution_failed → denied; only approved urls reach subprocess |
| A-21-Nuclei | per-url scope gate; template_match audit per finding with `outcome:'success'` (C2); severity threshold enforced by worker not wrapper; per-finding try/catch in worker (B4) |
| A-21-PayloadSchema | reconSubfinderRunPayloadSchema exported; `projectId: z.string().uuid()` non-nullable (B1) |
| A-21-Worker | (B2) assessmentLoader BEFORE buildScope; `assessment.tenantId !== payload.tenantId` → denied+ack; (B3) probeUrls from subfinder output; (B4) per-finding try/catch loop continues on throw; (C1) graceful degradation when bin absent |
| A-21-CoordinatorDispatch | start-decepticon-session.ts additive; `triggerRecon` optional; `projectId` non-null in payload (B1); C3 runtime guard documented; coordinator/payloads.ts diff empty |
| A-21-AuditActions | AUDIT_ACTIONS.length === **83** in no-DB run; all 10 recon.* entries listed once; no contradiction (B5) |
| A-21-EnvelopeKind | ENVELOPE_KINDS.length === **11** |
| A-21-RbacMatrix | RBAC_MATRIX.size === 1575 unchanged; impl-summary cites H4 grep = empty |
| A-21-NoMigration | No new migration file; B6 K=9 unchanged; targets insert uses only existing columns (no source/metadata) |
| A-21-UnitTests | subfinder: 5 paths; httpx: 6 paths (incl C1 partial-absence); nuclei: 7 paths (incl B4 middle-throw, C2 outcome confirm); coverage ≥80% |
| A-21-IT | 5 paths; P27 ≥2 resetAuthState; (B2) tenantId-mismatch path; (B3) mixed-yield path asserts httpx.denied for out-of-scope subdomain; targets row assertion aligned with B1 (no source field) |
| A-21-LintTC | 0/0 |
| A-21-Tests | ≥1103/0 no-DB; ≤3 PG fail (P35+P40) |
| A-21-P36Compliance | No sprint-21-evaluator-result.md written by generator |
