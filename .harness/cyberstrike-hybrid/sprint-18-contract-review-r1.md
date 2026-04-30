# Sprint 18 — Contract Review r1 (REVISE)

**Reviewer:** evaluator-s18 (Opus 4.7, isolated context)
**Drafter:** generator-s18 (Sonnet 4.6)
**Date:** 2026-04-30
**Contract reviewed:** `.harness/cyberstrike-hybrid/sprint-18-contract.md` (v1, drafted by generator-s18)
**Verdict:** **REVISE r1** — well-structured contract, pure-fn values code-verified, 7 items need tightening before APPROVE.

---

## Verified-good (no change needed)

- AUDIT_ACTIONS=61 baseline matches `packages/contracts/src/audit.test.ts:11`. +3 → 64 ✓
- ENVELOPE_KINDS=7 baseline matches `packages/contracts/src/queue-envelope.test.ts:17`. +1 → 8 ✓
- RBAC_MATRIX=1470 baseline matches `packages/authz/src/matrix.test.ts:11`. 7 × 15 × 15 = 1575 ✓
- B6 K=8 at `tests/integration/db/migrations.test.ts:177` confirmed. K=9 covers down(021) → down(013) = 9 steps ✓
- Envelope dispatch lives at `apps/api/src/scope-engine/start-decepticon-session.ts:456` (existing XSS site) — coordinator surface stays frozen for additive payload only ✓
- Migrations 013–020 all exist, no off-by-one ✓

---

## Required revisions

### R1 — resetAuthState DISABLE TRIGGER missing

§A-18-ResetAuthChain only adds `DELETE FROM oob_callbacks;`. Per `tests/integration/auth/helpers/auth-fixture.ts` pattern, append-only tables need `ALTER TABLE oob_callbacks DISABLE TRIGGER USER;` BEFORE the DELETE block (analogous to S15 `target_credentials`, S14 `reports`, S10 `finding_evidence`, S8 `assessment_artifacts`).

**Add explicit acceptance:** "DISABLE TRIGGER USER for `oob_callbacks` added in `DO $$ BEGIN` block before any DELETE; `DELETE FROM oob_callbacks` placed in DELETE chain (position determined by FK deps — see R2)."

### R2 — `candidate_id` FK status ambiguous

§A-18-OobTable line 47 declares `candidate_id uuid nullable` with no FK clause. R6 in the contract's risk table claims FK exists. Pick one and document:

- **(a) NO FK → soft pointer.** `oob_callbacks` DELETE order is independent (can come anywhere). Document: "soft pointer, no FK to `candidate_findings` — receiver may log callbacks for tokens without canonical candidates".
- **(b) FK with `ON DELETE SET NULL`.** Must place `DELETE FROM oob_callbacks` BEFORE `DELETE FROM candidate_findings`.

**Recommend (a)** — the callback receiver runs at network edge and shouldn't FK-block on candidate row presence (token-based correlation is the design).

### R3 — A-18-OobTableAppendOnly assertion gap

Migration adds DELETE + TRUNCATE triggers; test only verifies DELETE fires. Add explicit case asserting `TRUNCATE oob_callbacks` also throws `append_only` error (S2 lesson — both triggers must be exercised).

### R4 — A-18-IT missing security invariant assertion

Out-of-scope deny path must explicitly assert: **NO outgoing HTTP request was made** (network-call counter on injected HTTP client = 0). Order matters: scope gate BEFORE network egress (S13 per-candidate-gate lesson). The mock HTTP client should track `callCount`, and the deny IT must assert it remained 0.

**Promote this to its own line in §A-18-IT acceptance.**

### R5 — A-18-RbacMatrix role spec underspecified

Contract says "platform_admin and security_lead get read; all other roles no permissions". Verify and document each of 7 role files explicitly:

- `platform_admin`: `oob_callback:read=allow`, `oob_callback:list=allow` (other 13 actions=deny)
- `security_lead`: same
- The remaining 5 roles (`analyst`, `auditor`, `triage`, `customer_admin`, `lab_operator` — or whatever names the 7 actually are): all 15 actions on `oob_callback` = deny

**Each of the 7 role files MUST be touched** (otherwise the per-role file would have no entry for the new resource and the matrix builder behavior is undefined). Make explicit in the contract: "all 7 role files updated with explicit `oob_callback` action map."

### R6 — A-18-SsrfValidator scope-decide kind value

Contract says `kind:'http_request'`. Confirm against `packages/scope-engine/src/decide.ts` action-kind catalog — current canonical kinds are `http_request`, `dns_resolve`, `tool_invoke`, etc.

If SSRF replay needs DNS resolution gate FIRST (token subdomain), document: "scope gate runs `http_request` decide; DNS resolution of the OOB host happens via injected resolver and is NOT a separate scope decision (handled by the `http_request` normalizer per S6 `normalizeAction`)."

If validator does its own DNS lookup outside the `http_request` decide, that's a P14 fail-closed risk and must be addressed.

### R7 — Coordinator payload type

§A-18-SsrfCoordinatorDispatch publishes a new envelope kind. The payload schema (`{ tenantId, projectId, assessmentId, candidateFindingId, candidateType:'ssrf', replayUrl, token, traceId }`) needs:

1. A Zod schema in `services/coordinator/src/payloads.ts` (analogous to existing `validate.finding` payload).
2. Consumption in `services/validator-worker/src/payload-schema.ts`.

**Frozen surface clarification:** `services/coordinator/src/payloads.ts` IS in the M2 frozen-surface set. Brief authorized "coordinator (envelope dispatch)" — confirm this includes a new SSRF payload type addition (additive, append-only).

**State explicitly in contract:** "additive new export `validateSsrfReplayPayloadSchema` in `payloads.ts`; existing exports unchanged."

---

## Carry-in J (B-17a) clarification

Contract lists B-17a as "optional time-permitting" but the S17 verdict carried it as a named backlog item. Confirm intent: shipped-when-ready or genuinely optional?

**If optional**, demote from §10 deliverable list to a separate "Stretch" section so the verification matrix is unambiguous about whether it's a gate.

---

## Resolution path

Once R1–R7 are addressed, contract is APPROVE-ready. Generator may reply with:
- v2 contract (preferred), OR
- specific R# rebuttals if any item is technically incorrect.

**This is round 1 of ≤2 contract rounds.** R2 must converge or evaluator will recommend team-lead truncate scope.
