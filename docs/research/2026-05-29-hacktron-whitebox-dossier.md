# Whitebox Security Product Dossier — Hacktron Competitor Build Foundation

> Strategic + technical research dossier (2026-05-29) seeding the spec for an autonomous
> **whitebox** security product (Hacktron competitor) layered on our existing blackbox-pentest
> SaaS (Bun/Hono/SQLite/Drizzle, GCP ephemeral VMs, signed audit chain, React, Decepticon).
> Produced by a 20-agent research workflow (13 research dims + 6 verifications + synthesis,
> ~1.35M tokens). Hacktron claims tagged `[confirmed]` / `[inferred]` / `[speculative]`.

## 1. Executive Summary

**Hacktron** (hacktron.ai) — SF AI offensive-security startup, founded 2025, $2.9M pre-seed,
~$240K rev in 9mo `[confirmed]`. Founders are elite competitive hackers (Zayne "zeyu1337"
Zhang/CEO, Mohan "s1r1us" Pedhapati/CTO, Harsh "rootxharsh" Jaiswal/CRO, Fabian
"LiveOverflow" Faessler/Head of Agent Engineering) `[confirmed]`. Real track record:
CVE-2026-1731 (CVSS 9.9 pre-auth RCE in BeyondTrust → CISA KEV), RCEs in VSCode Copilot Chat,
Google Antigravity, OpenAM, Ivanti EPMM `[confirmed]`. Operating principle: **"PoC || GTFO"** —
only report what it can demonstrably exploit `[confirmed]`.

**Two products:**
- **PR Review** ("Hacktron Review") — GitHub App ($40/dev/mo) reviewing every PR against a
  **whole-repo call graph (not just diff)**, posting inline findings with PoC + AI-fix prompt,
  learning from triage via `.hacktron/rules.md` + downvotes `[confirmed]`.
- **Whitebox Pentest** — source-code-aware autonomous pentest, credit-priced, owner-gated:
  clones repo, maps architecture, runs a swarm of LLM/AST/purpose-built agents, autonomously
  triages by exploitability/reachability/impact, generates PoCs, ends with **mandatory
  human-in-the-loop validation** → dual-audience (compliance + remediation) report `[confirmed]`.

**Threat to us.** We are blackbox-only. The 2025-2026 cohort (Hacktron, XBOW, ZeroPath, Corgea,
DryRun, Terra, Ethiack) converges on: **source access + reachability/taint + LLM agents** beats
blackbox on coverage (logic/authz/business-logic) and beats human pentest on cost (~1/3 price).
The sector moat is **validation**, not the LLM call.

**Opportunity.** We already own the expensive parts: job queue, ephemeral GCP VM provisioning
(`CloudProvider`), signed audit chain, findings model, callback plumbing, and an autonomous agent
(Decepticon). Two new sub-products map onto this stack. The differentiator to build: a
**deterministic pre-LLM reachability/taint layer + a generate-then-verify validation loop** that
drives FP → 0. Hacktron's "cheap-model-many-times beats one frontier run, ~$12/run" thesis is
directly portable to our qwen3.7-max / Decepticon-eco history.

## 2. Hacktron PR Review — mechanics + inferred architecture

Confirmed: GitHub App; trigger on PR open against configured branch + re-review on commits;
whole-repo call-graph indexing ("exploitability not syntax"); inline comments each with a PoC +
AI-fix prompt; vuln classes (business logic, SQLi, XSS, SSRF, XXE, prompt injection, memory
safety, authz, IaC, supply-chain, secrets); per-repo learning via `.hacktron/rules.md` + triage;
auto-closes a finding when a later commit patches it; uses multiple AI models per PR; builds a
threat model. No public FP/latency benchmarks.

Inferred: webhooks `pull_request` (opened/synchronize); perms Contents:read + PRs:write +
Checks:write; full clone → tree-sitter/SCIP symbol index → call graph → reachability from
untrusted entry points; detect→verify(PoC) pass as the primary FP filter; finding store keyed by
repo/PR with fingerprints for auto-close; shared engine with the Whitebox product.

## 3. Hacktron Whitebox Pentest — mechanics + inferred architecture

Confirmed: explicitly **whitebox** (source access), "in hours not weeks"; 3-stage
**Connect → Run → Report**; hybrid static + dynamic; autonomous triage by
exploitability/reachability/impact; auto-generated patches as PRs; **swarm on Gemini 2.5 Pro**
(mix of pure-LLM + AST-based + purpose-built agents); CLI "packs" = curated agent lists;
"Society of Mind" design (Understanding Agent builds compressed control-flow skeletons; adversarial
Reasoning Agent runs what-if hypotheses; vuln = proof tainted-input reaches sink); Known
Propositions (~60-70%, variant/pattern) vs Novel Propositions (deep semantic). Confirmed 6-step
static pipeline: parse+call-graph → context gather → data-flow enrichment → structured LLM prompt
→ post-process+dedup → minimal targeted FP review. **Sandbox-executor feedback loop**
(`localhost:8009/execute` → {stdout,stderr,waf_logs}; "a bypass is ONLY valid if the flag is read").
Gumroad demo: 1C/4H/5L/2I, >100M tokens, ~1/3 cost of $20-30K human pentest. **Variant analysis**
(seed a known bug pattern, hunt structurally-similar paths) is highest-yield (how BeyondTrust CVE
was found).

Stack (job posts): Product = Nuxt/Vue + NestJS + Go CLI; Agents = **Temporal + LangGraph +
tree-sitter + Python**. Models: Gemini workhorse; Claude Opus for hard human-in-loop exploit dev.

Key uncertainty `[weak]`: whether "dynamic analysis" = real build-and-run DAST or just
path simulation. Public material does NOT confirm a deployed-instance harness in the whitebox
pipeline. **Our edge: we already spawn real VMs → true hybrid (static CPG + live Decepticon vs a
deployed instance) is a genuine differentiator Hacktron may not have.**

## 4. Pricing & positioning

PR Review Pro: **$40/dev/mo, 50 PRs/dev, $1/extra PR**; peak-seat billing; 14-day trial (200
PRs/seat cap); free OSS bot; Enterprise custom (SSO/RBAC/audit). Pentests: **credit-based, org
shared pool, deducted at launch, Owner-only**, cost-estimation step + API, no public $/credit.
Internal economics: **~$12/optimized run**; per-model $2.8 (GPT-5.4-nano) → $79 (Opus 4.6) on
oauth2-proxy bench. SOC 2 Type 1 (Jan 2026). **Model to copy: seat-priced continuous PR product,
credit/usage-priced point-in-time whitebox.**

## 5. Competitor matrix (condensed)

| Vendor | What | WB/BB | FP-reduction | Scoring | Pricing |
|---|---|---|---|---|---|
| Hacktron | PR Review + autonomous WB pentest | WB | PoC||GTFO + call-graph reachability + multi-model + triage learning | per-finding PoC | $40/dev PR; credits pentest |
| Greptile | AI PR review | WB | codebase graph (AST docstrings + pgvector) + agent swarm + **team-partitioned embedding feedback filter** (block comments similar to ≥3 downvoted) | **0-5 merge-readiness** + P0/P1/P2 | seat/repo SaaS + self-host |
| CodeRabbit | PR review + 40-50 tools | WB | ephemeral sandbox + tools-in-jail + **agentic verification agent** grounds/dedupes; "Learnings" vec store | per-finding | ~$24/dev + on-prem |
| Corgea | AI whitebox SAST + autofix | WB | AST+LLM adaptive context; ~3x fewer FP; flags ~30% incoming SAST as FP | severity | enterprise |
| ZeroPath | AI whitebox SAST | WB | tree-sitter AST + call graph + **multi-agent validation w/ CVSS4.0 attack paths** | CVSS 4.0 | enterprise |
| DryRun | Contextual Security Analysis | WB | data-flow + arch + change-history; **88% of 26 seeded** | exploitability | enterprise |
| XBOW | Autonomous **pentester** | BB | **validate by real exploit execution** (headless confirms XSS); programmatic validators → ~0 FP | PoC-gated | enterprise |
| Snyk DeepCode/AgentFix | SAST + AI autofix | WB | **symbolic taint reachability** (non-LLM) + CodeReduce slicing; agentic loop re-scans every fix (~80%) | reachability+severity | paid |
| Semgrep Assistant | SAST + LLM triage | WB | deterministic dataflow + LLM judge fed dataflow trace; "Memories"; 96% agreement | TP/FP+conf | paid |
| Copilot Autofix | CodeQL + LLM fix | WB | LLM at remediation only; **re-runs CodeQL** (must remove alert, add none, pass tests) | CodeQL severity | bundled GHAS |
| Endor Labs | code-context-graph | WB | **deterministic function-level reachability** (40+ langs) → 90-95% noise cut | dataflow evidence | enterprise |
| Aikido | multi-scanner + AI triage | WB | **reachability BEFORE LLM** + reasoning triage → ~95% FP cut | severity 0-100 | per-dev + free |

Pattern: PR-review players lead with **graph + feedback-learning** + a **0-5/P-badge** score; SAST
players lead with **reachability/taint + generate-then-verify**; pentest players lead with
**execution-based validation**. **We fuse both.**

## 6. Technical SOTA — AI whitebox vuln discovery

Core: *"Creative AI discovers, deterministic logic decides."* The proven layered stack to build:
1. **Structure (deterministic):** tree-sitter → CPG (Joern: AST+CFG+PDG); taint/dataflow +
   reachability = the single biggest FP reducer (80-95% noise cut, all non-LLM).
2. **Context-extraction:** never dump whole files — **backward-slice from the sink** over the CPG;
   resolve cross-file deps (51% of correct verdicts need non-target files).
3. **Reasoning/triage (LLM):** slice + dataflow trace + rule meta + confidence + prior triage;
   expert-role prompt + per-CWE CoT few-shot + **self-consistency (sample 5, vote, "unknown" on
   ties)**. LLM4FPM → F1>99% on Juliet (~$0.38/warning). Tune for false-NEGATIVE minimization
   (aggressive FP filters suppress ~22% real bugs).
4. **Discovery (Naptime/Big Sleep loop):** Code Browser + **Python sandbox** + Debugger w/ ASan +
   Reporter; reasoning space, runtime feedback, **Perfect Verification** (controller decides, not
   LLM), parallel sampling. **Variant analysis** = highest yield.
5. **Verification/exploitability (deterministic — kills hallucination):** compile w/ ASan/UBSan;
   controller independently confirms success condition (crash/sanitizer/PoC). Web: non-destructive
   deterministic validators (headless confirms XSS). Pair PoV-gen with fuzzing + concolic.
6. **Patching:** multi-agent (RCA→patch→retrieve→reflect). Pitfall: **37-46% of CI-passing patches
   are semantically wrong** — require PoV-non-reproduction + regression + 2nd-model review.

Orchestration (XBOW/AIxCC): thousands of short-lived narrow agents + persistent coordinator;
backbone model quality > framework. AIxCC final (Aug 2025): 86% injected bugs + 18 real 0-days at
~$152/task. Big Sleep: first AI-found exploitable 0-day (SQLite).

## 7. Technical SOTA — AI PR security review (build as separable stages)

- **S0 Trigger/scope:** on PR open/synchronize, fetch diff + head SHA (anchor comments); skip
  generated/vendored/lockfiles.
- **S1 Context (two layers):** (a) **Aider repomap** — tree-sitter def/ref tags → directed graph →
  **personalized PageRank biased toward diffed files** → pack to token budget; (b) **call-graph
  impact** — flag d=1 callers NOT in the diff; attach source-to-sink taint path per candidate.
- **S2 Candidate gen:** cheap deterministic pass (Opengrep/Trivy/Gitleaks) OR LLM. Candidates, not
  verdicts.
- **S3 Prompt (3 hard rules):** **rationale BEFORE severity**; **REDACT PR metadata** (title/desc/
  commits — "bug-free" framing collapses TP detection 40-93pp); focused per-candidate exploitability
  question + **structured output `{file,line,cwe,rationale,reachable,cvss components,confidence}`** —
  **never ask for the final numeric severity.**
- **S4 Deterministic scoring:** compute CVSS from the model's decomposed vector components.
- **S5 Self-consistency/multi-judge (selective):** 3-5 samples or 2-3 models for high-sev/borderline;
  generator ≠ judge.
- **S6 Noise suppression:** confidence+reachable threshold w/ per-finding badge; **team-partitioned
  embedding feedback filter** (block new comment with cosine sim to ≥3 downvoted/ignored).
- **S7 Stable posting/lifecycle:** fingerprint = hash(cwe/rule + path + normalized snippet/AST),
  NOT line number; keep fingerprint→thread_id map; post line-based review comments anchored to head
  SHA; on re-run update via `in_reply_to`, resolve disappeared via `resolveReviewThread` GraphQL;
  **batch all comments into one review** (rate limits).

## 8. OSS building blocks — license + SaaS-safety

| Component | License | SaaS-safe | Use |
|---|---|---|---|
| tree-sitter | MIT | ✅ | parsing/AST foundation |
| ast-grep | MIT | ✅ | structural search; author own rules |
| Joern | Apache-2.0 | ✅ | **CPG + taint engine** (whitebox core) |
| Trivy | Apache-2.0 | ✅ | SCA/CVE, IaC, secrets, SBOM |
| Gitleaks **CLI** | MIT | ✅ | secrets (CLI not the Action) |
| SCIP | Apache-2.0 | ✅ | persist symbol graphs |
| aider (repomap) | Apache-2.0 | ✅ | repomap technique |
| OpenHands core | MIT (excl enterprise/) | ✅ | agentic remediation harness |
| **Opengrep** | LGPL-2.1 | ✅ (out-of-process) | **pattern SAST + taint** (Semgrep replacement) |
| PR-Agent (Qodo) | Apache-2.0 now | ⚠️ pin version | AI PR review (went Apache→AGPL→Apache) |
| Semgrep CE engine | LGPL-2.1 | ⚠️ engine OK, **rules NOT** | registry rules are proprietary |
| gitleaks-action ≥v2 | Commercial | ❌ | use CLI |
| TruffleHog v3+ | AGPL-3.0 | ❌ | avoid embedding |
| CodeQL | proprietary | ❌ for private-code SaaS | **do not build on it** |

Discipline: normalize everything to **SARIF**; run LGPL/AGPL tools **out-of-process**; re-verify
LICENSE of exact version + sub-components.

## 9. GitHub App integration cheat-sheet

Auth: App JWT (RS256, `/app*` only, mint tokens) → cached 60-min **installation token** (reuse
across calls, never per-request). Webhooks: verify `X-Hub-Signature-256` (HMAC-SHA256 of **raw
body**, timing-safe) BEFORE parse; dedup on `X-GitHub-Delivery`; return 2xx fast → queue. Subscribe
`pull_request` (opened/synchronize/reopened/ready_for_review), `issue_comment.created` (@mention;
guard bot loops, `issue.pull_request` present only on PR comments), `check_run`. Posting: batch via
`POST /pulls/{n}/reviews` with `event` + `comments[]={path,line,side,start_line}` (one review = one
notification). `position` deprecated → use `line`. Status: Checks API `POST/PATCH /check-runs`
(annotations capped 50/req). Resolve threads: GraphQL `resolveReviewThread(input:{threadId})`. Diff:
`GET /pulls/{n}/files`. Rate limits: primary 5000/hr; **secondary binding** (≤100 concurrent,
content-create ≤80/min, ≤500/hr) → batch + throttle + honor retry-after. Perms: PRs r/w, Contents
read (write for resolve), Checks write, Metadata read.

## 10. RECOMMENDED architecture for OUR feature

**Principle: the moat is the deterministic reachability/taint + generate-then-verify layer, not the
LLM call.**

### Reuse vs build
- **Reuse:** job queue; GCP ephemeral VM (`CloudProvider`/`gcp.ts`); signed audit chain (new event
  types); findings model + `storeFindings` (extend); Decepticon (as discovery/PoC-validation agent);
  status state machine + callback webhooks; React frontend (extend).
- **Build:** GitHub App (auth/webhooks/posting/resolveReviewThread — fetch-based, no octokit dep
  needed); tree-sitter repomap + call-graph context (pluggable `SymbolIndexer`); deterministic CVSS
  scorer + 0-5; team-partitioned embedding feedback filter; Opengrep/Trivy/Gitleaks-CLI generators
  (out-of-process, SARIF-normalized); sandbox executor (PoC validation on the VM); Joern CPG/taint
  (the deterministic core — integrate, follow-up for full depth).

### Data model deltas (Drizzle/SQLite) — migration 0012
```
review_repos:       id, user_id, scm, installation_id, owner, name, default_branch,
                    covered_branches(JSON), rules_md, status, created_at, updated_at
pr_reviews:         id, repo_id, pr_number, head_sha, github_review_id, status,
                    score_0_5, summary_md, started_at, completed_at, error
review_findings:    id, pr_review_id, fingerprint, file_path, start_line, end_line, side,
                    severity, cwe(JSON), cvss_vector, cvss_score, confidence, reachable,
                    title, rationale_md, poc_md, fix_prompt_md, lifecycle_state, created_at
review_threads:     id, pr_review_id, fingerprint, github_thread_id, github_comment_id,
                    is_resolved, created_at, updated_at
review_feedback:    id, repo_id, fingerprint, signal(up|down|addressed|ignored),
                    comment_text, embedding(JSON|blob), created_at
(whitebox reuses scans/findings/reports; add scan kind 'whitebox' + repo ref)
```

### New job kinds
`index_repo` (clone, parse, build symbol/call graph, persist; incremental on push) •
`pr_review` (assemble context → candidates → judge → score → batch-post review + check-run → map
threads) • `resolve_threads` (on synchronize, resolve disappeared fingerprints) • `whitebox_scan`
(spawn VM → clone → CPG/taint → Decepticon variant-analysis → sandbox PoC validation → triage →
audit → draft report → human gate → final report + optional remediation PR) • `learn_feedback`.

### LLM call design
Generator ≠ Judge (separate models). Context = backward-slice (minimal, not whole files) + taint
path + rule meta + `.rules.md` + per-team feedback memory. Prompt: rationale-before-severity, redact
PR metadata, focused per-candidate exploitability, structured JSON with decomposed CVSS vector +
reachable + confidence (never the final number). Self-consistency 3-5x for high-sev. PoC validation
via Decepticon + sandbox (empirical success = primary FP filter).

### Sub-products
(a) **PR Review GitHub App** — seat-priced; webhook → index+pr_review → batched inline review +
check-run N/5 + AI-fix prompt + PoC where validatable + feedback-learning. Low compute, high freq.
(b) **Whitebox Pentest** — credit-priced, owner-gated, cost-estimation step; Connect → whitebox_scan
on GCP VM → CPG/taint + Decepticon variant-analysis + sandbox PoC → triage → human gate → signed
dual-audience report + optional remediation PR. High compute, point-in-time.

**Ship order: PR Review first** (lower compute, recurring, reuses most), Whitebox as upsell.

## 11. Open questions / risks / weak claims

Weak Hacktron claims: whitebox "dynamic" = real DAST? (unconfirmed — likely simulation; our VM rail
is an edge); multi-SCM is marketing (GitHub-only docs); Gumroad tally corrected to 1C/4H/5L/2I;
funding figures disagree; Temporal+LangGraph wiring + `.rules.md` mechanics + shared-engine are
inference; no public FP/latency benchmarks.

Build risks: (1) **source ingestion = new trust surface** — hostile PRs running arbitrary code in
our sandbox is the threat model (cf. CodeRabbit "PR→RCE→~1M repos" Kudelski; "PwnedRabbit" Endor);
ephemeral VM + egress lockdown + scoped tokens. (2) **FP rate is existential** — Joern reachability
on the critical path. (3) CodeQL license-blocked. (4) Semgrep rules license trap. (5) auto-patch
correctness (37-46% CI-passing wrong). (6) GitHub secondary rate limits. (7) human-in-loop = cost
constraint. (8) validate cheap-model-many-times on our backbone.

Product questions: self-host demand? pricing (mirror Hacktron seat+credits)? ship PR Review first.
