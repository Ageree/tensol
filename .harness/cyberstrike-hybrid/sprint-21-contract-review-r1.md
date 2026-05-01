# Sprint 21 — Contract Review r1 (REVISE)

**Reviewer:** evaluator-s21 (Opus 4.7, isolated context)
**Contract version:** v1 (drafted by generator-s21 / Sonnet 4.6)
**Date:** 2026-05-01
**Verdict:** **REVISE → v2**

---

## Summary

Architecture is sound (queue-based recon-runner worker, scope-gate-before-subprocess, M2 frozen surfaces). Audit cardinality math reaches 83 / envelope reaches 11 — both consistent with mission target ranges. Pre-baked codex lessons are present in spirit. **Five blockers + three cleanup items** require resolution before APPROVE.

---

## Blockers

### B1 — D3 contradicts existing `targets` table schema (HARD)

**Claim:** Contract §D3 (line 51, 165, 334) says `targetWriter` writes `{ kind: 'domain', value: subdomain, source: 'recon.subfinder', tenantId, assessmentId }` to the existing `targets` table with **NO new migration**, and §A-21-NoMigration line 242 says "schema unchanged".

**Reality (verified at `packages/db/migrations/003_projects_targets.ts:24-50`):** The `targets` table has columns:

```
id, tenant_id, project_id (notNull references projects.id), kind, value,
ownership_status, created_at, updated_at, version
```

with check constraint `kind IN ('url','domain','ip','cidr','cloud_account','k8s_namespace','repo')` and unique key `(tenant_id, project_id, kind, value)`.

There is **no** `source` column, **no** `metadata` jsonb, and **no** `assessment_id` FK. Inserting `{ source: 'recon.subfinder' }` will fail at the SQL layer (column does not exist).

Additionally: `project_id` is `notNull`. The recon envelope payload schema (`payload-schema.ts` line 138) types `projectId: z.string().uuid().nullable()` — a null projectId cannot satisfy the FK constraint and the row insert will fail at runtime.

**Resolution options (pick one for v2):**

- **Option A (preferred — no migration):** drop the `source` field from the insert; write `{ tenant_id, project_id, kind: 'domain', value: subdomain }` only. The "discovered by recon" provenance is captured in the `recon.subfinder.run` audit trail (`metadata.discoveredHosts: [...]`), not in the targets row. Require `payload.projectId` to be non-null when `triggerRecon: true` — encode this in the zod schema (`projectId: z.string().uuid()` not `.nullable()`), reject envelope at parse-time otherwise.
- **Option B (rejected):** add a migration to add `source text` and `metadata jsonb` columns and relax `project_id` to nullable. **Violates "NO new migration" mission constraint** — out of scope for S21.
- **Option C:** stop writing to `targets` entirely; surface discovered subdomains only via the audit `metadata.discoveredHosts` array. Cleaner but loses the persistent inventory the contract argues for in §D3. Acceptable but document the consequence.

Pick A or C. Update §D3, §A-21-Worker step 4, §A-21-NoMigration, and §A-21-IT (the IT currently asserts "`targets` table has row for `api.example.com`" — must align).

---

### B2 — Cross-assessment binding check is a tautology

**Claim:** §A-21-Worker line 170 — "verifies `envelope.assessmentId === payload.assessmentId` before doing any work (mirrors S18 HIGH-1 pattern)".

**Reality:** In the validator-worker pattern (S18/19/20), the cross-assessment check is **`candidate.assessmentId !== payload.assessmentId`** — comparing a DB-loaded candidate row against the envelope payload (different sources, can disagree). For recon, there is no candidate — the envelope IS the trigger. Comparing `envelope.assessmentId` to `payload.assessmentId` is comparing the same struct's same field to itself (the envelope's `payload.assessmentId` IS what the contract calls `envelope.assessmentId`). It is a no-op tautology and provides zero security.

**Resolution:** Reformulate as **tenant binding** (the closest meaningful analog for an envelope-only trigger):

> Worker loads the assessment row by `payload.assessmentId` via injected `assessmentLoader`. If `assessment.tenantId !== payload.tenantId` OR assessment is null → emit `recon.subfinder.denied` reason:`assessment_mismatch` + ack-no-retry, skip `buildScope`. Mirror of S18 HIGH-1 at the recon-trigger layer.

Add `assessmentLoader: (assessmentId: string) => Promise<{ tenantId: string } | null>` to `ReconWorkerDeps`. IT cross-asmt path (line 275) seeds an assessment owned by tenant B and sends an envelope with `payload.tenantId = tenant A` — must produce `assessment_mismatch` audit + zero spawnFn calls.

---

### B3 — Scope-decide must individually re-validate every subfinder-discovered subdomain BEFORE httpx invocation

**Claim:** §A-21-Worker step 5 (line 166): `probeUrls = subdomains.map(s => 'https://${s}/') + ['https://${payload.primaryDomain}/']`. §A-21-Httpx line 108: "for each url in `urls`, call `decide()`. Denied → skip that url".

**Gap:** The contract is implicit. The pre-baked S21 lesson #2 (scope-check granularity per output) and #4 (JSON parse must not silently extend scope) require an **explicit invariant** in §A-21-Subfinder and §A-21-Worker: even if subfinder returns a host that's a valid subdomain string, that host MUST individually pass `decide()` (which DNS-resolves and applies the engine's allow-list/CIDR logic) before any downstream probe sees it. The httpx wrapper's per-url decide() at line 108 is the gate that enforces this — but the contract should say so explicitly, with a worker-level invariant: "every subfinder yield is treated as untrusted attacker-controlled input until decide() rules on it; out-of-scope yields produce `recon.httpx.denied` audit per yield (telemetry surface), not silent drop."

Also: discovered subdomain that fails DNS resolution (`dns_resolution_failed` from `normalizeAction`) → `recon.httpx.denied` reason:`dns_resolution_failed`, skip. Document this case explicitly.

**Resolution:** Add explicit invariant block "Untrusted subfinder yields" to §A-21-Worker between steps 4 and 5. Add IT test case: "subfinder yields one in-scope + one out-of-scope subdomain → only in-scope reaches nuclei; out-of-scope produces `recon.httpx.denied` audit row". Bumps IT path count from 4 to 5.

---

### B4 — Per-template-match findingsWriter throw semantics undefined (P47 ambiguity)

**Claim:** §P47 application (line 315): "on `findingsWriter` throw → `recon.nuclei.error` audit + `ack`".

**Gap:** Within step 7 of §A-21-Worker, `runNuclei` returns N findings; the worker calls `findingsWriter` per finding (filtered by severity≥medium). If finding-write #5 throws after #1..#4 succeeded, what happens?

Two valid models:
- **Model X (per-call try/catch, continue loop):** swallow the single write error, emit `recon.nuclei.error` audit reason:`finding_write_failed` for that one, continue loop, ack overall. Aligns with P47 (terminal-ack, no retry that re-fires nuclei) AND preserves the 4 findings already written.
- **Model Y (single try/catch around loop):** abort the loop on first throw, emit one `recon.nuclei.error` audit, ack. Loses findings 6..N but doesn't roll back 1..N (already committed in their own txns) — leaks partial state.

**Resolution:** Pick Model X. Document explicitly in §A-21-Worker step 7 with a code-comment-precision sentence: "Each `findingsWriter` call is wrapped in its own try/catch; on throw, emit `recon.nuclei.error` reason:`finding_write_failed` audit (with `templateId` in metadata) and continue the loop. Loop never short-circuits on per-finding write error." Add unit test: nuclei returns 3 findings, mock `findingsWriter` throws on call #2 → assert calls 1 and 3 succeeded, audit emitted with templateId of #2, function returns normally (no thrown error to caller).

---

### B5 — Audit cardinality count contradicted within the document

**Issue:** The contract states three different totals:
- Header line 4 — "AUDIT_ACTIONS=73→83" (correct final).
- Deliverables row I (line 34) — "73 → 82 (+9 new)".
- §A-21-AuditActions opening (line 196) — "73 → 82".
- §A-21-AuditActions correction (line 208-210) — "Wait — correction... 73 → 83".
- Pure-fn (line 298) — "83 (73 base + 10)".

The "Wait — correction" parenthetical is a thinking artifact left in the document. The discrepancy between row I (82) and pure-fn (83) is a literal contradiction.

**Resolution:** Pick 83 (matches mission target, matches verification-matrix expectation `expect(AUDIT_ACTIONS.length).toBe(83)`). Strike the "Wait — correction" comment. Update Deliverables row I to "73 → 83 (+10 new)". Update §A-21-AuditActions to single-pass listing of 10 entries with no flip-flop. Verify Header, Deliverables, §A-21-AuditActions, Pure-fn all say 83.

---

## Cleanup (non-blocking, but required for v2 polish)

### C1 — Partial binary absence semantics

§A-21-Worker line 171 covers "all bins missing" → config_error. Doesn't cover **partial absence** (the actual current-host state — subfinder missing, httpx+nuclei present). Pick and document one:
- **(a)** subfinder absent → emit `recon.subfinder.error` reason:`config_error`, skip subfinder, proceed with `probeUrls = ['https://${primaryDomain}/']` (single-URL httpx run). Same for nuclei-absent → skip nuclei stage. Each binary absence is independent.
- **(b)** any binary absent → abort entire pipeline at first absence with one config_error audit, ack.

Recommend (a) — degrades gracefully, exercises the dev box's actual mixed state, preserves usefulness when one tool is missing. Document explicitly in §A-21-Worker. Bumps unit test count by 1 (subfinder-absent-but-httpx-present partial path).

### C2 — `recon.nuclei.template_match` audit outcome value

Contract uses `outcome: 'success'` (line 129). Verify against `AUDIT_OUTCOMES` enum at `packages/contracts/src/audit.ts:143-157` — present (`success` is the first entry). OK to use as-is; no schema change needed. Document in §A-21-Nuclei that the wrapper uses `'success'` outcome with `metadata: { templateId, severity, matched }` for the per-match row.

### C3 — `triggerRecon: true` requires `primaryDomain` — schema-level enforcement

§A-21-CoordinatorDispatch line 175 says "if `triggerRecon === true` AND `primaryDomain` is set". This is a runtime check. Consider zod refinement on `StartDecepticonInput` so that `primaryDomain` is required when `triggerRecon === true`. Reduces "envelope published with empty primaryDomain → subfinder run with `-d ''` → unbounded behavior" risk. Acceptable as runtime guard if zod refinement is awkward, but document the choice.

---

## Pre-baked codex lessons — verification

| # | Lesson | Coverage in v1 | Notes |
|---|---|---|---|
| 1 | Cross-asmt binding before scope load | **broken** — see B2 | Reformulate as tenant binding via assessmentLoader. |
| 2 | Required deps no-silent-fallback (S18 MED-2) | partial — see C1 | Per-binary granularity in v2. |
| 3 | Null buildScope → audit + ack, subprocess NOT called | covered (line 163, 318) | OK. |
| 4 | Subprocess error → terminal ack, no retry (S19 MED) | covered (line 95, 111, 128, 319) | OK. |
| 5 | Scope-decide BEFORE subprocess (P14/S13) | covered per wrapper (line 92, 108, 125) | OK — but make B3 invariant explicit. |
| P47 | Side-effect-bearing payloads → terminal-ack on store failure | partial — see B4 | Per-finding try/catch model. |
| P46 | Shell-payload placeholder substitution | N/A for recon (correctly noted line 314) | OK. |

---

## v2 acceptance criteria (what evaluator will verify before APPROVE)

1. B1 resolved: pick A or C. §D3, §A-21-Worker step 4, §A-21-NoMigration, §A-21-IT all aligned. If A: zod schema for envelope payload makes `projectId` non-nullable when `triggerRecon: true`.
2. B2 resolved: tenant-binding via `assessmentLoader` injected dep; IT cross-asmt path uses tenantId mismatch (not assessmentId-vs-itself).
3. B3 resolved: explicit "untrusted subfinder yields" invariant in §A-21-Worker; IT bumps to 5 paths (in-scope + out-of-scope subfinder yield).
4. B4 resolved: per-finding try/catch model documented; unit test for nuclei middle-finding write failure.
5. B5 resolved: every cardinality reference says 83; "Wait — correction" stricken.
6. C1 resolved: partial-binary-absence semantics documented (recommend per-binary independent skip).
7. C3 resolved: `primaryDomain` required when `triggerRecon: true` — zod refinement OR documented runtime guard.
8. C2 noted as confirming, not requiring change.

---

## Process notes

- Per P43, this file is durable — committed as `sprint-21-contract-review-r1.md`.
- Per P44, generator must explicitly SendMessage with v2 contract path before evaluator acts.
- Per ≤2 fix-round limit, **r2 must be APPROVE** if all B-items resolved. Cleanup C-items can carry as B-21-* if generator runs out of time, but B1–B5 are blockers.
