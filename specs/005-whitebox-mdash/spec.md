# 005 — Whitebox MDASH-style Multi-Model Agentic Harness

**Status:** Design approved (interactive forks answered 2026-06-03)
**Author:** Claude (Opus 4.8) for nikto256@gmail.com
**Supersedes deep-mode internals of:** `specs/003-whitebox/plan.md` (the `runResearch` recon→12-experts→triage chain)
**Reference architecture:** Microsoft MDASH — *multi-model agentic scanning harness* (Microsoft Security blog, 2026-05-12) — tops CyberGym at 88.45%.

---

## 1. Problem & Goal

The whitebox service today is **single-model (qwen3.7-max) and non-agentic**:
- *Fast mode* = one blind `review()` `complete()` call over a pre-packed context bundle.
- *Deep mode* = a static `recon → route → 12 one-shot experts → triage` DAG. No node decides to read more code, re-route, or iterate. One model fills every role.

MDASH's thesis is the opposite: **"the harness does the work, and the model is one input"**, **"no single model is best at every stage"**, and **"an auditor does not reason like a debater, which does not reason like a prover."** Discovery, validation, and proof are decomposed into specialized stages, each with its own role, prompt regime, tools, stop criteria, and *model*.

**Goal:** Rebuild whitebox **deep mode** as a 5-stage, multi-model, tool-using agentic harness modeled on MDASH, while preserving Sthrip's deterministic moat (Generator ≠ Judge; deterministic CVSS scorer is the only thing that emits a number) and the existing fail-closed safety posture. Default-OFF behind a flag; fast mode untouched; old deep pipeline retained as fallback.

### Non-goals
- Do **not** change fast mode.
- Do **not** add a new code-execution surface (Prove reuses the existing, gated Exploit Lab only).
- Do **not** retire the old `runResearch` chain — it stays as the fallback when the harness flag is off.

---

## 2. Architecture — the 5 MDASH stages mapped to Sthrip

```
POST /v1/review/whitebox (mode:"deep")
        │
        ▼  whitebox_scan job → clone repo (repoDir + files)
        │
   ┌────────────────────────── HARNESS (server/src/review/harness/) ──────────────────────────┐
   │                                                                                            │
   │  1. PREPARE   repo map + SAST sweep + git-history attack surface + threat model            │
   │               → AttackSurfaceUnit[] (prioritized), index               [model: recon=cheap]│
   │                                                                                            │
   │  2. SCAN      parallel AUDITOR agents (runAgentLoop + repo tools), one per lens/unit        │
   │               each investigates with tools, emits CandidateFinding[]   [model: auditor=SOTA]│
   │               (hypothesis + evidence + decomposed CVSS + confidence; NEVER a number)        │
   │                                                                                            │
   │  3. VALIDATE  adversarial DEBATERS per candidate (multi-model):                             │
   │               R1 cheap refuter tries to refute  → reject/downgrade     [model: debater=cheap]│
   │               R2 (survivors only) independent SOTA counterpoint        [model: counterpoint]│
   │               → credibility (posterior) + verdict accept|downgrade|reject                   │
   │               "auditor flags X, debaters can't refute ⇒ credibility ↑"                      │
   │                                                                                            │
   │  → emits LlmVerdict[] (existing type), credibility-weighted, refuted dropped                │
   └────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼  (engine's EXISTING deterministic moat — now WIRED for whitebox)
   4. DEDUP     verdictToFinding fingerprint + dedup (deterministic)        [no model]
   5. PROVE     Joern reachability (deterministic) + optional Exploit Lab   [gated, fail-closed]
        │       verify gate → deterministic CVSS scorer → overallScore0to5
        ▼
   ReviewResult → finalizeReview → dashboard
```

**Why this split:** MDASH stages 4–5 (Dedup, Prove) are exactly Sthrip's existing deterministic layer (`verdictToFinding` fingerprint/dedup, `reachability/joern.ts`, `verifyFindings`, the Exploit Lab F2 hook, `score.ts`). They are now wired for whitebox, so the harness only needs to build stages **1–3** (the agentic, multi-model verdict generator). This keeps the moat in one place and honors Generator != Judge.

---

## 3. Components (new files — small, single-purpose)

### `server/src/review/harness/`
| File | Purpose |
|---|---|
| `types.ts` | Stage I/O types: `AttackSurfaceUnit`, `CandidateFinding`, `DebateResult`, `HarnessResult`, `HarnessOptions`. |
| `models.ts` | `HarnessModels` role→`LlmClient` map; `buildHarnessModels(config, makeClient)`; each client metered against a **shared per-scan budget**. |
| `prepare.ts` | Stage 1. Reuse `buildContextBundle` + `CompositeSastRunner` + `buildRoutingUnits`; add `buildThreatModel()` (git-history-weighted attack surface via the cheap recon model). |
| `threat-model.ts` | Git-history analysis (recent/hot files = higher risk) + entry-point/trust-boundary/sink extraction → prioritized `AttackSurfaceUnit[]`. |
| `auditor.ts` | Stage 2. `runAuditor(unit, tools, model, budget)` → wraps `runAgentLoop` with an auditor prompt + repo tools; parses strict-JSON `CandidateFinding[]` through the existing verdict-parse gate. |
| `scan.ts` | Stage 2 orchestration: parallel fan-out of auditors over units/lenses (bounded concurrency, per-auditor fault isolation, budget gate) — reuses the `research/orchestrator` Promise.all + try/catch pattern. |
| `debate.ts` | Stage 3. `debate(candidate, models, tools, budget)` → R1 cheap refuter, R2 independent counterpoint on survivors; computes credibility + verdict. |
| `validate.ts` | Stage 3 orchestration: parallel debates over candidates; drops refuted; annotates credibility. |
| `orchestrator.ts` | `runHarness(files, repoDir, models, deps, opts)` → sequences Prepare→Scan→Validate → `LlmVerdict[]` + `HarnessResult` metadata. The seam the engine calls. |

### `server/src/review/agent/tools/repo-tools.ts` (new)
Repo-scoped agent tools (whitebox has `repoDir`, not a PR), modeled on `pr-tools.ts`'s narrow-capability + path-safety + output-bounding discipline:
- `read_file(path)` — read a file under `repoDir` (path-traversal guarded, 60k cap).
- `list_files(dir?)` / `grep(pattern, glob?)` — navigate/search the checkout.
- `query_sast(path?)` — return SAST `RawFinding`s as hotspots.
- `query_reachability(file, line)` — Joern reachability query (optional; degrades to "unknown" if Joern absent).
`buildRepoAgentTools(capabilities)` returns the catalog.

### Engine / wiring changes
- `engine.ts`: add optional `deps.harness?: HarnessRunner`. When `mode:"deep"` and `deps.harness` present → produce verdicts via harness; else deep → old `runResearch`; else fast. Downstream dedup/reachability/verify/exploit/score unchanged.
- `whitebox-scan.ts`: accept `harness?`, `reachability?`, and build a per-review harness session (fresh budget + per-role metered clients). Keep existing exploit hook. Set behavior so the engine's `selfChallenge` is **not** double-run when the harness already debated.
- `server.ts`: build the harness deps gated by `TENSOL_HARNESS_ENABLED && TENSOL_RESEARCH_ENABLED`; wire `reachability` (Joern) independently for whitebox so the legacy deep `runResearch` path and harness path both pass through the same deterministic proof layer. `TENSOL_AGENT_WHITEBOX_ENABLED` is retained as legacy parse-only compatibility and warns at boot; `TENSOL_HARNESS_ENABLED` is the real whitebox deep-mode harness gate.

---

## 4. Multi-model ensemble (3-model, env-configurable)

| Role | Default model | Rationale (MDASH) |
|---|---|---|
| `recon` / `threatModel` / `triage` | `qwen/qwen3.7-max` (cheap) | high-volume, low-stakes synthesis |
| `auditor` | `openai/gpt-5.5` (SOTA) | heavy reasoner for discovery |
| `debater` (R1 refuter) | `qwen/qwen3.7-max` (cheap) | high-volume adversarial pass |
| `counterpoint` (R2) | **second independent SOTA** (validated against OpenRouter at deploy/test time; configurable) | independent counterpoint — model disagreement = credibility signal |

Config flags (all new, defaults shown; `TENSOL_` prefix to match existing):
- `TENSOL_HARNESS_ENABLED=false` — master gate (harness vs. old research for deep mode)
- `TENSOL_HARNESS_MODEL_AUDITOR=openai/gpt-5.5`
- `TENSOL_HARNESS_MODEL_DEBATER=qwen/qwen3.7-max`
- `TENSOL_HARNESS_MODEL_COUNTERPOINT=<2nd SOTA>` (if empty → falls back to auditor model + warns: not a true ensemble)
- `TENSOL_HARNESS_MODEL_RECON=qwen/qwen3.7-max`
- `TENSOL_HARNESS_BUDGET_USD=2.0` — per-scan USD ceiling (shared across all roles; reuses `createBudget` + `createMeteredClient` exact-usage metering)
- `TENSOL_HARNESS_MAX_AUDITORS=12`, `TENSOL_HARNESS_AUDITOR_MAX_ROUNDS=6`, `TENSOL_HARNESS_DEBATE_MAX_ROUNDS=3`

Cost control: the expensive counterpoint (R2) runs **only on candidates that survive R1**, and the whole scan is bounded by the shared budget (`assertWithin()` trips → stage returns gracefully with what it has).

---

## 5. Data model (additive migration `0015_harness_findings.sql`)

Add to `review_findings` (all nullable, no backfill):
- `credibility REAL NULL` — debate posterior (0..1)
- `debate_json TEXT NULL` — compact debate record (votes, which models, refute attempts)
- `models_json TEXT NULL` — which models played which role for this finding

Wire fields surface through `findingRowToWire` (snake_case) → optional dashboard badges (credibility, "survived N-model debate"). Dashboard changes are minimal/optional (not blocking).

---

## 6. Error handling & safety

- **Budget:** shared per-scan budget; `assertWithin()` failure in any stage degrades gracefully (return partial verdicts) rather than throwing the whole scan.
- **Auditor/debater faults:** per-agent try/catch isolation (reuse research orchestrator pattern); a single failed auditor never aborts the scan; total outage of a stage fails loud.
- **Tool safety:** `repo-tools` enforce path-traversal guards + output caps (copy `pr-tools` discipline). Tools have no shell/network of their own.
- **Prove safety:** Joern is out-of-process, degrades to "unknown" if absent. Exploit Lab stays behind `TENSOL_EXPLOIT_ENABLED` + sandbox gate (fail-closed); never invoked just because the harness is on.
- **Generator ≠ Judge:** auditors/debaters emit decomposed CVSS + confidence + credibility, **never** the 0–5 number; `score.ts` remains the sole scorer. Echoed-marker / reward-hacking guards from the existing reviewer parse gate are reused.

---

## 7. Testing

**Unit (TDD, stubbed `LlmClient` + fake tool capabilities):**
- `models.ts` — role map, budget sharing, counterpoint fallback+warn.
- `repo-tools.ts` — path traversal rejection, output bounding, SAST/Joern tool outputs.
- `auditor.ts` — strict-JSON parse gate, no-number enforcement, tool-loop termination.
- `debate.ts` — R1 reject path, R2-only-on-survivors, credibility math, multi-model disagreement → downgrade.
- `prepare.ts` / `threat-model.ts` — attack-surface prioritization from git history + SAST.
- `orchestrator.ts` — 5-stage sequencing, budget exhaustion graceful-degrade, fault isolation.
- engine integration — `deps.harness` branch chosen only for deep; fast/old-deep unaffected.

**Integration:** harness end-to-end with stub models → `LlmVerdict[]` → engine dedup/verify/score; reachability wired; exploit hook gated.

**Real-model E2E (`server/scripts/e2e-harness.ts`, ≤ ~$2):** run the full harness against `Ageree/sthrip-review-testbed` (known vulns + 1 decoy) with real gpt-5.5 + qwen + a validated counterpoint. Assert: recall (planted vulns found), decoy not flagged (FP control), multi-model disagreement actually fires, total spend ≤ budget, exact-usage metering recorded. (User standard: ~$0 spend = short-circuited = FAIL.)

**Independent-context review (after impl):** ≥3 independent subagents — Code Reviewer, Security Engineer, and a real-OpenRouter E2E verifier running the actual modules — then fix found issues (≤2 rounds, then ship with backlog).

**Floor:** full `bun test` suite stays green (current floor ~1894/0); `tsc --noEmit` 0 errors.

---

## 8. Rollout

1. Additive migration + types + config (no behavior change; flag default off).
2. `repo-tools` + `harness/` stages with unit tests (TDD).
3. Engine + handler + server wiring (harness behind `TENSOL_HARNESS_ENABLED`; reachability wired for whitebox).
4. tsc + full suite green.
5. Independent-context review → fixes.
6. Real-model E2E ≤ ~$2 → measure recall/FP/disagreement/cost.
7. Report. Commit only on user request (per workflow rules).

All new behavior is gated; with every flag at its default, whitebox behaves exactly as today.
