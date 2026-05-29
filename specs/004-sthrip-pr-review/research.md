# Research — Sthrip PR Review (Phase 0)

Consolidated from a 6-agent research swarm (29 May 2026): 3 competitor scouts (Hacktron, CodeRabbit, Greptile) + 3 OSS hunters (review frameworks, code-indexing, SAST/reachability). Full reports archived at `docs/research/2026-05-29-*` / job dossier. Every load-bearing OSS claim was re-verified against the GitHub API (stars, license, freshness) before being recorded here.

## Competitor architecture (what we are matching / beating)

All three leaders converge on: **GitHub App → clone repo → build code-graph + semantic context (not diff-only) → agentic multi-hop review → inline comments + edited-in-place summary**.

- **Hacktron** — repo + call-graph indexing, Gemini-2.5-Pro multi-agent swarm (LLM + AST + per-vuln detectors), hybrid static/dynamic; **the moat is the verification gate** ("PoC || GTFO": only `verification_status = approved` findings surface). Categorical 5-level severity; **no numeric confidence, no exposed reachability field, no documented merge-blocking check-run** → our opening. `.hacktron/rules.md` config-as-code. Auto-resolve on remediation. $40/dev/mo.
- **CodeRabbit** — agentic (not pure RAG), ephemeral sandbox, code-graph per review + persistent LanceDB semantic index, 80–90% of tokens on context. Orchestrates ~60 OSS linters (incl. ast-grep, **Opengrep alongside Semgrep to dodge the license shift**, Gitleaks, TruffleHog, Trivy, OSV-Scanner, Checkov). Org install + repo-picker (all/select). `@coderabbitai review/full review/resolve/pause`. No numeric score.
- **Greptile** — AST → recursive docstrings → embeddings graph; agentic search per PR; **0–5 confidence score** + per-comment P0/P1/P2; **self-challenge** (v3, +70% acceptance); learning (suppress style after 3 ignores, **never** security). Postgres+pgvector, Hatchet orchestration, LLM proxy. `@greptileai` trigger; **edits the summary comment in place** (sort by `updated_at`). Status check via branch protection. Reputation wedge: LLM-only → hallucinations, ~60% nit/FP.

**Synthesized posture for Sthrip**: keep our deterministic, SAST-grounded 0–5 scorer (structurally removes the hallucination class that hurts the LLM-only incumbents) + add the two things even Hacktron under-delivers as exposed product: a **numeric confidence + explicit reachability indicator per finding** and a **merge-blocking required check-run**.

---

## R1. GitNexus is dev-tooling, not a product dependency (spec correction)

- **Decision**: Treat FR-026 as a **policy guardrail**, not a removal task. `grep -rin gitnexus server/src` → **zero hits**: GitNexus is only the agent-time code-intelligence MCP/CLI configured in this repo's `CLAUDE.md`. It is **not** imported, spawned, or shipped by the product. The rule going forward: **never vendor GitNexus (PolyForm-Noncommercial-1.0.0) into `server/`**.
- **Rationale**: PolyForm-NC forbids commercial use; a paid SaaS cannot ship it. But since it was never in the runtime, there is nothing to rip out — only a boundary to enforce.
- **Alternatives considered**: (a) wholesale replace a shipped dependency — rejected, premise false; (b) buy GitNexus' commercial/Enterprise license — rejected, unnecessary and adds cost for capability we can get permissively.

## R2. Context engine: regex repomap → in-process tree-sitter symbol graph

- **Decision**: Upgrade `review/context/repomap.ts` (currently a tiny **regex** import/reference extractor) to a **tree-sitter** symbol graph using **`web-tree-sitter` (MIT, WASM)** in-process, with an **aider-style PageRank ranker (Apache-2.0, ported)** to rank the diff's neighbourhood, and **`scip-typescript` (Apache-2.0)** as an optional precision pass for TS/JS go-to-def/find-refs. Keep the regex extractor as a zero-dep fallback.
- **Rationale**: stays inside the single Bun package (Constitution III), all-permissive, and is the smallest step that gives real symbol/call/import edges (the "reachability of changed code" substrate). `colbymchenry/codegraph` (33,001★, **MIT**, TS-native) and `DeusData/codebase-memory-mcp` (2,791★, **MIT**, hybrid KG+semantic+dataflow, single binary) are **verified** and serve as reference/optional drop-in sidecars — but adopting either as a separate service is deferred to avoid premature complexity.
- **Alternatives considered**: codegraph/codebase-memory-mcp as a spawned sidecar (kept as a documented upgrade if in-process tree-sitter proves insufficient at monorepo scale); `cocoindex-code` (Apache, Rust) and `CodeGraphContext` (MIT, Neo4j/Kuzu) — rejected for now (extra runtime/DB); embeddings layer (`sqlite-vec` + `nomic-embed-code`/voyage-code-3) — **deferred** (graph + ripgrep covers ~80% for diff-scoped review).

## R3. Reachability / dataflow via Joern (the "exploitable not theoretical" moat)

- **Decision**: Add a **reachability adapter** that runs **Joern (Apache-2.0, verified 3.2k★)** as a `Bun.spawn`/VM sidecar to compute function-level taint/reachability (untrusted-source → dangerous-sink) for candidate findings; the result populates the existing `reachable` field + evidence. Run Joern on the **ephemeral GCP VM rail** (it is JVM-heavy; not in-process).
- **Rationale**: Joern's Code Property Graph is the only permissive OSS engine giving real taint/reachability — the same primitive Semgrep-Pro/Qwiet sell. It directly powers FR-019/FR-020 and the verification gate. Apache-2.0 → ships clean as a sidecar.
- **Alternatives considered**: Opengrep intra-file taint (LGPL engine, v1.21+ added it) — kept as a lighter first pass but it is intra-file only; CodeQL — **rejected** (engine proprietary; only free on OSI-licensed code → cannot scan customers' closed source for pay). For unsupported languages, fall back to a clearly-labelled lower-confidence verdict (edge case in spec).

## R4. Verification gate (Hacktron's "PoC || GTFO", productized)

- **Decision**: A finding is **surfaced only if** it passes `verify.ts`: (i) deterministic SAST corroboration (a SARIF hit at/near the location) **OR** (ii) reachability-proven (Joern taint path from untrusted input) **OR** (iii) an LLM-generated reproduction/exploit path that the self-challenge pass did not refute. Unverified candidates → `verificationStatus = "unverified"` and are **not posted** (kept in DB for audit/triage). This is gated independently of the LLM's own confidence.
- **Rationale**: this is the single biggest trust lever and the headline differentiator; it converts "AI scanner = noise" into the product promise (SC-003, SC-004).
- **Alternatives considered**: posting everything with a confidence badge (Greptile-style) — rejected, that is exactly the ~60%-noise reputation we are beating; requiring a *runnable* PoC for every class (full Hacktron parity) — deferred (dynamic execution is out of scope this feature; static reachability + refutation is the bar for v1).

## R5. SAST/secrets/deps stack + the licensing traps (hard constraint)

- **Decision**: Ship these as `Bun.spawn` sidecars emitting SARIF → normalized to `RawFinding`:
  - **Opengrep engine (LGPL-2.1, sidecar)** with **`AikidoSec/opengrep-rules` (MIT, verified)** and/or self-authored rules.
  - **Trivy (Apache-2.0)** — deps/IaC/secrets/SBOM. **OSV-Scanner v2 (Apache-2.0)** — dependency CVEs. **Gitleaks (MIT)** — secrets, or **Kingfisher (Apache-2.0, verified 1.1k★)** for live-validated secrets.
  - **Joern (Apache-2.0)** — reachability (R3). Optional **GuardDog (Apache-2.0)** — malicious packages.
- **Rationale / the two traps we must not step on**:
  1. **Semgrep Registry rules = SRL-1.0** → forbid competing-SaaS/hosted use. Never `--config p/…`.
  2. **Opengrep's *own* rules repo = LGPL-2.1 + Commons Clause** ("no Sell") → the engine is fine, **its bundled rules are not shippable**. Use AikidoSec MIT rules or our own. (This corrects the earlier "just use Opengrep" note.)
  - Excluded entirely from the shippable engine: **CodeQL** (proprietary engine), **Bearer** (Elastic License 2.0, no-hosted-service), **TruffleHog/Vulnhuntr** (AGPL — replace with Kingfisher / port the method into closed code).
- **Alternatives considered**: in-process linters (rejected — license linking + bloat; sidecar isolation satisfies LGPL/Apache obligations and matches the existing `runner.ts` pattern).

## R6. Confidence-gated self-challenge (cheap precision lever)

- **Decision**: Before emitting, the reviewer runs a **self-refutation pass** on each candidate ("try to prove this is NOT exploitable / is unreachable"); candidates the refutation cannot survive, or that fall below a confidence threshold, are dropped. The model emits a decomposed CVSS vector + reachability + confidence (existing `LlmVerdict`); **`score.ts` alone computes the 0–5** (anti reward-hacking — already enforced by the type system).
- **Rationale**: Greptile reported +70% acceptance from exactly this; near-free precision gain that complements R4.
- **Alternatives considered**: N-way self-consistency voting (more tokens; deferred); letting the model emit severity/score (rejected — violates the existing invariant in `types.ts`).

## R7. Learning loop (noise reduction over time)

- **Decision**: `learning.ts` reads `review_feedback` (signals `up/down/addressed/ignored`, already modeled) + first-vs-last-commit of merged PRs; after **N ignores** of a **style/nit** category on a repo, suppress that category for that repo (record in a derived `review_suppressions` table). **Never** suppress `security`/`correctness` categories regardless of dismissals. Honour the repo's `.sthrip/rules.md` (already on `review_repos.rulesMd`).
- **Rationale**: matches Greptile's proven loop; retention feature; low priority (P3) because the verification gate already controls noise from day one.
- **Alternatives considered**: embedding-similarity suppression (column `embeddingJson` exists) — deferred until the semantic layer lands.

## R8. Connect flow & installation model

- **Decision**: GitHub **App** installation (not a bare OAuth token). `GET /v1/github/connect` returns the App install URL; GitHub redirects to `GET /v1/github/callback?installation_id&setup_action=install|update`; persist a first-class **`installations`** row mapped to the current Sthrip user (one user = one org, Constitution V). Handle `installation` (created/deleted), `installation_repositories` (added/removed), `issue_comment` (`@sthrip review`) webhook events. **Authorization is by signed installation_id**, never by repo slug alone (closes the cross-tenant takeover class flagged in prior review).
- **Rationale**: App installs are how all three competitors do per-repo, least-privilege access; tokens are minted per-installation (code already exists in `github/client.ts`).
- **Alternatives considered**: OAuth user-token model (rejected — coarse scopes, no per-repo selection, no check-run identity).

## R9. Developer skills shape (the "subagent" ask)

- **Decision**: Mirror `greptileai/skills` (MIT, verified): rename `tensol-loop` → **`sthrip-loop`** (bounded ≤5-iteration trigger→fix→re-review until 5/5 & 0 unresolved; host agent does edits — fixer-agnostic) and add **`sthrip-check-pr`** (detect platform; fetch comments/checks/description; categorize actionable vs informational; resolve addressed threads). Both **read the latest summary comment by `updated_at`** (edit-in-place gotcha) and auto-detect GitHub/GitLab/Perforce.
- **Rationale**: directly fulfils the user's "сделать скилл как у greptile (субагентный подход)" and drives the loop-until-perfect UX. The integration surface is native git-host APIs + our `/v1/review` endpoint — trivially cloneable.
- **Alternatives considered**: forking `The-PR-Agent/pr-agent` (Apache-2.0, verified) as the *engine* — not needed (our engine exists); kept on file as a fallback engine provider. `claude-code-action`/`reviewdog`/`danger` noted as wrap/delivery options but our poster already covers delivery.

## Open items / explicitly deferred

- Org/team accounts + RBAC (kept per-user — Constitution V).
- Embeddings/semantic retrieval layer (graph + ripgrep first).
- Runnable dynamic PoC execution (static reachability + refutation is the v1 bar).
- GitLab/Perforce **backend** webhook ingestion (skills auto-detect them; server ingestion is GitHub-only here).
