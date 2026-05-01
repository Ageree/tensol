# Sprint 19 Contract — Review r1 (REVISE)

**Reviewer:** evaluator-s19 (Opus 4.7, isolated context)
**Round:** R1 of ≤2
**Verdict:** **REVISE** — 4 mandatory changes + 4 recommended hardenings. No blockers; all addressable in one v2 pass.
**Contract under review:** `sprint-19-contract.md` v1
**Base:** `5df0795` (S18 CLOSED)

---

## Summary

Contract is structurally sound and well-grounded in S18 SSRF baseline. Acceptance criteria clear, frozen-surfaces honored, AUDIT/ENVELOPE bumps correct, RBAC unchanged justified, NO migration justified. The 6-pattern sentinel set is reasonable.

Issues below are mostly **architectural-clarity** (worker-vs-validator audit-ownership ambiguity that could re-emerge as a codex P2) and **pre-emptive codex hardening** (body-size DoS, regex anchoring, match-priority assertion, payload jsonb shape). Address all 8 in v2.

---

## MANDATORY changes (v2 must include)

### M1 — Audit ownership: worker emits no_scope, validator emits scope-deny

**Issue:** §35 (A-19-LfiValidator) and §57 (A-19-LfiWorkerWiring) both claim ownership of the `validator.lfi.replay_denied` no_scope audit. Risk: double-emission OR architectural confusion replicated downstream.

**S18 baseline (verified):**
- `services/validator-worker/src/worker.ts:557-576` (`handleSsrfReplay`) — emits `validator.ssrf.replay_denied` `reason:'no_scope'` BEFORE calling validator. Returns `{ kind: 'ack' }` without invoking `validateSsrfCandidate`.
- `services/validator-worker/src/ssrf-validator.ts:89-94` — emits `validator.ssrf.replay_denied` with `reason: decision.reason` (the actual deny reason from scope-engine). Validator is only ever called with non-null scope.

**Required in v2:**
- §35 (A-19-LfiValidator): clarify validator only handles **decide() deny path** — `validator.lfi.replay_denied` `reason: decision.reason`. Remove `scope === null` branch from validator description.
- §57 (A-19-LfiWorkerWiring step 5): keep `buildScope` null → `validator.lfi.replay_denied` `reason:'no_scope'` ack, owned by worker. Mirror exact S18 SSRF text at worker.ts:557-576.
- §47 wording "On scope deny (either branch above)" → make explicit which branch is worker-emitted vs validator-emitted.

### M2 — Confirmed-finding insertion is worker's job, not validator's

**Issue:** §45 says validator "insert confirmed finding" — but §59 also has `findingsWriter(...)` in worker. Mirror S18: validator returns `{status, sentinelKey?}`; worker.ts (lines ~598-630 of S18 SSRF baseline) calls `deps.findingsWriter` on `result.status === 'confirmed'`.

**Required in v2:**
- §45 reword: validator returns `{ status: 'confirmed', sentinelKey }` — does NOT insert. Worker's `handleLfiReplay` calls `findingsWriter(...)` on confirmed.
- §59 already specifies this — keep + cross-reference to §45 to remove ambiguity.

### M3 — Body-cap before sentinel regex (pre-empt codex P2 DoS)

**Issue:** S18 codex P2 added `BODY_LIMIT_BYTES = 64 * 1024` for OOB HTTP listener (http-listener.ts:16-17, 54-57). LFI runs sentinel regex against arbitrary HTTP-response body — a 100MB response makes regex evaluation pathological.

**Required in v2:**
- Add to A-19-LfiValidator: `httpClient.get` contract returns `{ body: string }` with body **already capped at 1MB** by the httpClient implementation, OR validator truncates `response.body.slice(0, 1_048_576)` before regex matching. Pick one and lock it.
- Unit test: oversized body (e.g. 2MB) → either rejected by httpClient or truncated by validator → regex still runs deterministically.

### M4 — Match-priority assertion in unit tests

**Issue:** §38 says "first match wins" but no unit test asserts ordering. An implementation reordering patterns silently is undetectable.

**Required in v2:**
- Add unit test case: body contains BOTH `root:x:0:0:` (passwd) AND `root:$6$:19000:0:` (shadow line) → asserts `sentinelKey === 'unix_passwd'` (priority #1 wins over priority #2). One test is sufficient — locks the pattern array order.

---

## RECOMMENDED hardenings (v2 should include)

### H1 — Anchor the PHP regex (regex #5)

**Issue:** §43 sentinel #5 = `/short_open_tag\s*=\s*(On|Off)/i` — **NOT line-anchored**. Any HTML page documenting `php.ini` (e.g. tutorial / help wiki on the target webapp) trips a false confirmed finding.

**Recommended:**
- Change to `/^short_open_tag\s*=\s*(On|Off)/im` — line-start anchor matches actual config files but not prose. Consistent with regexes #1-#4 and #6.

### H2 — Specify `findings.payload` jsonb shape for LFI

**Issue:** §59 says `findingsWriter(...)` with `type: 'lfi'` — but the jsonb `payload` shape is unspecified. S18 SSRF stores `{ token, replayUrl }` per audit; LFI should mirror.

**Recommended:**
- Lock LFI confirmed-finding `payload` to `{ sentinelKey, affectedUrl, matchedSnippet?: string }` (snippet optional, capped at e.g. 256 chars). Add to A-19-LfiWorkerWiring §59 + assert in IT happy-path.

### H3 — `validator.lfi.unmatched` audit metadata shape

**Issue:** §46 says emit `{ affectedUrl }`. Mirror S18 SSRF success-path audit emission shape — include `outcome: 'success'`, `resourceType: 'candidate_finding'`, full `AuditEmitterArgs`. Lock down so codex doesn't ding inconsistency.

**Recommended:**
- A-19-LfiValidator §46: explicit `{ outcome:'success', resourceType:'candidate_finding', resourceId: candidateFindingId, metadata: { affectedUrl } }`. Mirror SSRF `validator.ssrf.timeout` audit-emit pattern at ssrf-validator.ts:122-126.

### H4 — RBAC type-list grep evidence

**Issue:** §111-114 says no RBAC change needed. But: routes/views may filter by finding-type list (e.g. `WHERE type IN ('xss_reflected', 'ssrf')`). If such enumerations exist, they need `'lfi'` added — silently missing means LFI findings invisible in some role views.

**Recommended:**
- Pre-flight grep: `grep -rn "'xss_reflected'\|'ssrf'" packages/authz tests/integration/auth apps/api/src/routes` and lock evidence into the contract:
  - If ZERO hits → A-19-RbacMatrix `Pre-flight grep returned no type-enumeration sites; no other surfaces need updating.`
  - If HITS → enumerate them in v2 and either patch (with file:line) or justify why each is not affected.

---

## Verification matrix the evaluator will run on v2 implementation

I'll verify the following at impl handoff (when generator-s19 SendMessages "ready for review" with SHA, per P44):

| Gate | How |
|---|---|
| M1 audit ownership | grep `validator.lfi.replay_denied` in worker.ts (no_scope) + lfi-validator.ts (decide-deny). Each emits exactly once per code path. |
| M2 finding insertion | grep `findingsWriter` in worker.ts handleLfiReplay; absent from lfi-validator.ts. |
| M3 body cap | unit test for oversized-body path; regex evaluation deterministic. |
| M4 priority assertion | unit test asserting passwd > shadow when both present. |
| H1 PHP anchor | regex source contains `^` line-start. |
| H2 payload shape | IT happy-path asserts `findings.payload` jsonb has `sentinelKey` + `affectedUrl`. |
| H3 unmatched audit shape | IT unmatched path asserts full audit row including `outcome:'success'`, `resource_type:'candidate_finding'`. |
| H4 RBAC grep | impl-summary cites the pre-flight grep result. |

Plus standard Sprint-18-pattern gates: lint 0 / tsc 0 / no-DB 0 fail / full-PG ≤3 fail / AUDIT 67 / ENVELOPE 9 / RBAC 1575 / B6 K=9 / frozen-surface M2 vs `5df0795` clean.

---

## Process notes

- This is **R1 of ≤2 contract review rounds** per ship-velocity rule. v2 should consolidate all 4 mandatory + 4 recommended changes — single revision pass.
- P43 durable file written (this file).
- Generator: SendMessage me when v2 is on disk; do NOT wait for me to poll (P44).
- After v2 APPROVE I lock in for impl-handoff. Generator must then SendMessage with commit SHA when implementation is ready (P44).

Standing by for v2.
