# DEPRECATED — validator-worker

**Status: deprecated 2026-05-12. Frozen at SSRF/LFI/RCE/XSS validators. New per-type validators MUST NOT be added.**

## Why deprecated

Architectural audit on 2026-05-12 (`memory/project_tensol_architectural_audit_2026-05-12.md`) found that per-type Tensol-side HTTP-replay validators duplicate functionality already provided by Decepticon's `verifier` agent (Apache-2.0, `external/decepticon/decepticon/agents/verifier.py`):

- Decepticon's `verifier` does Zero-False-Positive validation with PoC + CVSS for ALL vulnerability classes, not just the 4 we wrote (SSRF/LFI/RCE/XSS).
- Decepticon's `validate_finding` tool enforces a success-pattern + negative-control contract that's stricter than our ad-hoc per-type signal detection.
- Adding new types (info_disclosure, broken_auth, idor, xxe, ...) here is wasted work — `verifier` already covers them by design.

## What changed

- `apps/api/src/scope-engine/start-decepticon-session.ts` step 8 no longer dispatches `validator.{ssrf,lfi,rce}.replay` envelopes. Comment in code points at this README.
- Workspace findings now flow through step 8.5 extractor → `candidate_findings` directly (without per-type validator promotion).
- SQLi validator (commit `166e535`) was rolled back in commit `a8acfc8` before it ever wired into production.

## What's retained

This package STAYS in the codebase for:

1. **Existing IT test coverage** (`tests/integration/validator/{ssrf,lfi,rce}-pipeline.test.ts` — these tests are self-contained, they construct their own envelopes and call `handleSsrfReplay` / `handleLfiReplay` / `handleRceReplay` directly without going through `start-decepticon-session.ts`).
2. **Hot-rollback safety** — if Decepticon's `verifier` integration (Phase 3) reveals gaps for specific vuln classes, we can re-wire dispatch from `start-decepticon-session.ts` step 8 in 15 minutes.
3. **Reference for understanding the legacy pattern** — useful for new contributors reviewing the migration history.

## Removal plan (Phase 3, deferred)

After Decepticon `verifier` agent integration ships and is validated on ≥10 real scans across diverse target classes:

1. Delete `services/validator-worker/src/{ssrf,lfi,rce,xss}-validator*.ts`
2. Delete `services/validator-worker/src/worker.ts` + `payload-schema.ts`
3. Delete `tests/integration/validator/*-pipeline.test.ts`
4. Remove `validator.{ssrf,lfi,rce}.*` and `validation.*` actions from `AUDIT_ACTIONS` (cardinality bump down) — note this is a BREAKING change for any historical audit_events rows with those action strings, evaluate impact before merging
5. Remove `validator.{ssrf,lfi,rce}.replay` and `validate.finding` kinds from `ENVELOPE_KINDS`

Phase 3 owners: whoever picks up the «full validator-worker removal» task. Estimated 4-6h with care.

## DO NOT

- Add new per-type validators here. Use `assistant_id=verifier` against Decepticon instead.
- Restore the dispatch in `start-decepticon-session.ts` step 8 unless reversing the deprecation explicitly with the user.
- Ship new audit actions in the `validator.{type}.*` namespace.
