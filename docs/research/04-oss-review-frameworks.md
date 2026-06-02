# OSS Hunt — Agentic Code-Review Frameworks (2026)

**Date:** 29 May 2026
**Mission:** Find the newest + best open-source AI code-review / agentic-review harnesses that **Sthrip** (a commercial, closed-source paid managed SaaS) could fork, wrap, or learn from to deliver Greptile / CodeRabbit / Hacktron-grade automated PR review.
**Hard constraint:** Commercial-license safety. Sthrip resells code review as paid SaaS, so copyleft (GPL/AGPL) and source-available/non-compete (BSL, SSPL, Elastic v2, PolyForm-Noncommercial) cores are disqualified from embedding. Clean = MIT / Apache-2.0 / BSD / ISC / LGPL-as-sidecar.

> **Verification note:** All licenses below were read from the actual repo (`gh api repos/<r>/license` and the LICENSE file content), not from memory. Star counts and `pushed` dates are live GitHub API values as of 29 May 2026.

---

## TL;DR

- **The single biggest 2026 event:** Qodo **donated PR-Agent to a community org (`The-PR-Agent/pr-agent`) and restored the clean Apache-2.0 license** (the old `Codium-ai` / `qodo-ai` URLs now redirect there). This is the most fork-friendly, mature, review-specific engine available — ~11.4k★, pushed 2026-05-26, release v0.35.0 (2026-05-14).
- **Freshest serious entrant:** **`alibaba/open-code-review`** — Apache-2.0, created May 2026, "battle-tested at Alibaba scale," a hybrid **deterministic-pipeline + LLM-agent** harness in Go with a repo-level-context design. This is the architectural blueprint Sthrip wants.
- **CodeRabbit / Greptile / cubic / Graphite-Diamond are NOT forkable** — they are closed-source SaaS competitors. CodeRabbit only funds OSS maintainers ($1M pledge) and ships a free-tier CLI; no reusable engine.
- **Kodus is the trap:** it markets itself as "open source AI code review" but is **AGPL-3.0 + a commercial Enterprise License on `ee/` code** — disqualified for embedding in a competing SaaS.
- **Agent harnesses** (LangGraph, CrewAI, Aider, Codex CLI, Continue) are clean (MIT/Apache) and safe to build the review loop on, but they are general-purpose, not review-specific.

---

## Candidate Table

| Name | GitHub URL | ★ | Last push / release | License (verified) | Commercial-safe? | What it does | How Sthrip uses it | Maturity |
|---|---|---|---|---|---|---|---|---|
| **PR-Agent** (community / ex-Qodo) | github.com/The-PR-Agent/pr-agent | 11,403 | push 2026-05-26 · v0.35.0 (2026-05-14) | **Apache-2.0** (restored on donation) | **YES** | The original OSS PR reviewer: `/describe` `/review` `/improve` `/ask`; GitHub/GitLab/Bitbucket/Azure; any LLM | **Fork or wrap.** Most proven review-specific engine; adopt its tool taxonomy + prompt structure as Sthrip's core | Very high |
| **alibaba/open-code-review** | github.com/alibaba/open-code-review | 393 | push 2026-05-29 · v1.1.7 (2026-05-28) | **Apache-2.0** | **YES** | Hybrid: deterministic pipelines + LLM agent, line-level comments, built-in fine-tuned ruleset (NPE, thread-safety, XSS, SQLi); 3-phase plan→loop→memory-compress; Go CLI | **Learn-from + port.** Best architecture reference for hybrid AST/rule + LLM at scale | Medium (new, but Alibaba-backed) |
| **anthropics/claude-code-action** | github.com/anthropics/claude-code-action | 7,789 | push 2026-05-29 · tag `v1` (floating) | **MIT** | **YES** | General Claude Code GitHub Action; `@claude` mention/assignment, code review + implementation, Bedrock/Vertex/Foundry auth, structured outputs | **Wrap.** Drop-in review runner; Sthrip controls prompt + gating. Cleanest path to a Claude-powered MVP | High |
| **anthropics/claude-code-security-review** | github.com/anthropics/claude-code-security-review | 4,872 | push 2026-02-11 | **MIT** | **YES** | AI security-review Action: analyzes diffs for vulns | **Wrap / learn-from.** Bolt-on security lane next to general review (Hacktron-style) | High |
| **Nikita-Filonov/ai-review** | github.com/Nikita-Filonov/ai-review | 452 | push 2026-05-18 | **Apache-2.0** | **YES** | Multi-forge (GitHub/GitLab/Bitbucket cloud+server/Azure/Gitea) reviewer; OpenAI/Claude/Gemini/Ollama/Bedrock/OpenRouter; **ReAct agent mode** (shell-explore repo before reviewing) | **Fork or learn-from.** Strong multi-forge adapter layer + agentic explore loop; broadest platform coverage | Medium |
| **gauthierdmn/nominal-code** | github.com/gauthierdmn/nominal-code | 48 | created 2026-02-25 · push 2026-05-25 | **Apache-2.0** | **YES** | Inline PR reviews GitHub+GitLab, any LLM, scales solo→org-wide K8s | **Learn-from / fork.** Clean recent reference for the K8s-scale deployment shape | Low-Med (new) |
| **goldynlabs/prr-kit** | github.com/goldynlabs/prr-kit | 21 | created 2026-02-19 · push 2026-03-04 | **MIT** | **YES** | "PR Review Framework" — structured agent workflows for consistent review | **Learn-from.** Workflow/prompt patterns; low traction, treat as inspiration | Low |
| **baz-scm/awesome-reviewers** | github.com/baz-scm/awesome-reviewers | 134 | push 2026-05-11 | **Apache-2.0** | **YES** (prompts, not code) | Ready-to-use **system prompts** for agentic code review | **Learn-from.** Mine for review-prompt library; pairs with any engine above | N/A (prompt corpus) |
| **presubmit/ai-reviewer** | github.com/presubmit/ai-reviewer | 182 | push 2026-02-12 | **MIT** | **YES** | Context-aware PR reviewer: summary, line comments, title gen | **Fork / learn-from.** Compact MIT reference impl | Medium |
| **reviewdog/reviewdog** | github.com/reviewdog/reviewdog | 9,329 | push 2026-05-29 | **MIT** | **YES** | Posts arbitrary linter/tool output as PR review comments (the "comment plumbing" layer) | **Wrap (plumbing).** Reuse as the diff→inline-comment delivery layer under an LLM brain | Very high |
| **sourcery-ai/sourcery** | github.com/sourcery-ai/sourcery | 1,818 | push 2026-05-26 | **MIT** | **YES** | Instant AI code reviews; CLI + GitHub | **Learn-from.** MIT but core product is the hosted service; OSS repo is thinner | Medium |
| **danger / danger-js** | github.com/danger/danger-js | 5,474 | push 2026-04-13 | **MIT** | **YES** | Codifies PR-process rules (non-LLM convention enforcement) | **Wrap (plumbing).** Deterministic policy gate alongside the LLM reviewer | Very high |
| **All-Hands-AI/OpenHands** | github.com/All-Hands-AI/OpenHands | 75,305 | push 2026-05-29 | **MIT core** + `enterprise/` = PolyForm Free-Trial | **YES (core only)** | Full autonomous dev agent; can run review loops | **Learn-from / sidecar.** Use MIT core agent loop; avoid `enterprise/`. Heavy for pure review | Very high |
| **Aider-AI/aider** | github.com/Aider-AI/aider | 45,504 | push 2026-05-22 | **Apache-2.0** | **YES** | Terminal AI pair-programmer; repo-map context | **Learn-from.** Its repo-map / tree-sitter context approach is gold for review context-building | Very high |
| **openai/codex** (Codex CLI) | github.com/openai/codex | 86,898 | push 2026-05-29 | **Apache-2.0** | **YES** | Lightweight terminal coding agent; sandboxed exec | **Wrap.** Usable as the agent runtime behind a review loop | Very high |
| **continuedev/continue** | github.com/continuedev/continue | 33,453 | push 2026-05-29 | **Apache-2.0** | **YES** | Source-controlled AI "checks" enforceable in CI; OSS Continue CLI | **Wrap / learn-from.** CI-enforceable review-check model is close to Sthrip's gating need | Very high |
| **langchain-ai/langgraph** | github.com/langchain-ai/langgraph | 33,325 | push 2026-05-29 · v1.2 (May 2026) | **MIT** | **YES** | Graph agent runtime; v1.2 adds per-node timeouts, error recovery, graceful shutdown | **Build-on.** Orchestrate multi-stage review (plan→fetch→analyze→comment) reliably | Very high |
| **crewAIInc/crewAI** | github.com/crewAIInc/crewAI | 52,440 | push 2026-05-29 | **MIT** | **YES** | Role-playing multi-agent orchestration | **Build-on.** Multi-reviewer-persona ensembles (security/style/architecture agents) | Very high |
| **mastra-ai/mastra** | github.com/mastra-ai/mastra | 24,521 | push 2026-05-29 | **MIT core** + `ee/` enterprise | **YES (core only)** | TypeScript agent framework: RAG, observability, MCP, workflow builder | **Build-on (TS shops).** If Sthrip is TS/Bun, this is the harness; avoid `ee/` | High |
| — DISQUALIFIED below this line — | | | | | | | | |
| **kodus / kodus-ai** | github.com/kodustech/kodus-ai | 1,139 | push 2026-05-29 | **AGPL-3.0** + Enterprise License (`ee/`, `.ee.`) | **NO** (copyleft + non-compete) | AST + LLM review engine, multi-forge, BYO-LLM | Learn-from architecture **only**; cannot embed | High |
| **qltysh/qlty** | github.com/qltysh/qlty | 3,068 | push 2026-05-26 | **BSL 1.1** (Business Source License) | **NO** (source-available, non-compete) | Universal lint/format/security/maintainability CLI | Learn-from only; BSL bars competing-SaaS use | High |
| **qodo-ai/qodo-cover** | github.com/qodo-ai/qodo-cover | 5,407 | push 2026-04-05 | **AGPL-3.0** | **NO** (copyleft) | AI test-gen / coverage (adjacent, not review) | Learn-from only | Medium |
| **CodeRabbit** (CLI/OSS) | github.com/coderabbitai | — | — | No reusable engine OSS'd | **N/A** | Closed SaaS; free-tier CLI (3 reviews/hr); $1M OSS-maintainer pledge | Competitor — study product, nothing to fork | — |
| **Greptile / cubic / Graphite-Diamond** | greptile.com / cubic.dev / graphite.dev | — | — | Closed-source | **N/A** | Full-codebase-graph commercial reviewers | Competitors — benchmark targets, not OSS | — |
| **Sweep** | github.com/sweepai/sweep | 7,710 | push 2025-09-18 (**stale**) | NOASSERTION | unclear / stale | Pivoted to JetBrains coding assistant; no longer a PR-review play | Skip | declining |
| **Reviewpad** | (repo 404 / gone) | — | — | — | **N/A** | Defunct | Skip | dead |

---

## Ranked Top 5

### NEW in 2026 (the freshest, license-clean, review-specific)

**1. PR-Agent (community `The-PR-Agent/pr-agent`) — Apache-2.0 — FORK THIS**
The defining 2026 event for this category. Qodo **donated** the project to a community-owned org and **restored Apache-2.0** (verified in repo README + LICENSE; old `Codium-ai`/`qodo-ai` URLs 301 to here). 11.4k★, actively pushed (2026-05-26), release v0.35.0 (2026-05-14). It is the only mature, review-*specific* engine with a fully permissive license — `describe/review/improve/ask` tools, multi-forge, any-LLM. Sthrip can fork the engine outright and put its moat in scope/compliance/distribution rather than re-deriving the review loop. *Caveat: while "new" is the license/governance change, the codebase itself is mature — flag it to stakeholders as established-engine + 2026-fresh-license.*

**2. alibaba/open-code-review — Apache-2.0 — LEARN-FROM / PORT**
The freshest genuinely-new project (created May 2026), Apache-2.0, Go. It is exactly the architecture Greptile/CodeRabbit win on: **hybrid deterministic pipelines + LLM agent**, repo-level context, a fine-tuned built-in ruleset (NPE/thread-safety/XSS/SQLi), and a plan→main-loop→memory-compression flow. Lower stars (393) but Alibaba-authored and "battle-tested at scale." Best blueprint for Sthrip's signal-quality (low-noise) differentiator. Port the hybrid-pipeline idea even if Sthrip's stack is not Go.

**3. anthropics/claude-code-action — MIT — WRAP (fastest MVP)**
MIT, 7.8k★, pushed daily (2026-05-29). The cleanest way to stand up a Claude-powered reviewer fast: structured outputs, path/branch gating, Bedrock/Vertex for data residency. Pair with **claude-code-security-review** (MIT) for a security lane. Lower ceiling than a forked engine, but lowest time-to-first-review.

### ESTABLISHED (clean licenses, build the harness on these)

**4. Aider (Apache-2.0) + reviewdog (MIT) — LEARN-FROM + WRAP-AS-PLUMBING**
Aider's **repo-map / tree-sitter context-building** is the single most reusable established technique for giving a reviewer whole-repo context cheaply. reviewdog is the battle-tested **diff→inline-comment delivery layer** (9.3k★, MIT, pushed today) — reuse it so Sthrip never hand-rolls comment plumbing. Combine: LangGraph/CrewAI brain → Aider-style context → reviewdog output.

**5. LangGraph (MIT) / CrewAI (MIT) — BUILD-ON (orchestration)**
General-purpose but rock-solid agent runtimes for the review *loop*. LangGraph v1.2 (May 2026) added per-node timeouts, error recovery, graceful shutdown — directly useful for reliable multi-stage review (plan → fetch diff → analyze → security → synthesize → comment). CrewAI for multi-persona ensemble reviewers (security/style/architecture agents). These provide reliability/observability around whichever review engine Sthrip forks.

---

## License Cheat-Sheet (verified, not from memory)

**CLEAN — embeddable in a competing commercial SaaS:**
PR-Agent (Apache-2.0), alibaba/open-code-review (Apache-2.0), claude-code-action (MIT), claude-code-security-review (MIT), Nikita-Filonov/ai-review (Apache-2.0), nominal-code (Apache-2.0), prr-kit (MIT), presubmit/ai-reviewer (MIT), reviewdog (MIT), sourcery OSS repo (MIT), danger/danger-js (MIT), Aider (Apache-2.0), openai/codex (Apache-2.0), Continue (Apache-2.0), LangGraph (MIT), CrewAI (MIT), baz-scm/awesome-reviewers (Apache-2.0, prompts).

**SIDECAR-ONLY — clean core, separately-licensed enterprise dir (use core, exclude the dir):**
OpenHands (MIT core; `enterprise/` = PolyForm Free-Trial), Mastra (MIT core; `ee/` enterprise).

**DISQUALIFIED — copyleft or source-available/non-compete (do NOT embed):**
Kodus (**AGPL-3.0** + commercial Enterprise License on `ee/`/`.ee.` files), qlty CLI (**BSL 1.1**), qodo-cover (**AGPL-3.0**), CodeRabbit/Greptile/cubic/Graphite-Diamond (**closed-source SaaS** — competitors, nothing to fork).

> **Watch-outs for AGPL specifically:** AGPL's network-use clause is fatal for SaaS — offering a Kodus-derived service over a network triggers source-disclosure of your whole linked work. BSL (qlty) explicitly forbids "competing offering" use until its change-date. Both are learn-from-only.

---

## Recommended posture for Sthrip

1. **Engine:** Fork **PR-Agent** (Apache-2.0) as the review core, OR — if you want the highest signal-quality ceiling — port the **alibaba/open-code-review** hybrid deterministic+LLM architecture. PR-Agent = faster, alibaba = better long-term moat.
2. **Context:** Adopt **Aider-style repo-map** context-building for whole-repo awareness (the Greptile differentiator).
3. **Orchestration:** Wrap the loop in **LangGraph** (Python) or **Mastra** core (TS/Bun) for retries/timeouts/observability.
4. **Delivery:** Use **reviewdog** for inline-comment plumbing; **danger** for deterministic policy gates.
5. **Prompts:** Seed the reviewer with **baz-scm/awesome-reviewers** system prompts.
6. **Security lane:** Bolt on **claude-code-security-review** (MIT) for the Hacktron-style vuln pass.
7. **Avoid:** Kodus, qlty, qodo-cover — and never confuse "open source" marketing (Kodus) with an embeddable license.

---

## Sources

- PR-Agent (community): https://github.com/The-PR-Agent/pr-agent
- Qodo donation context: https://futurumgroup.com/insights/qodo-hands-pr-agent-to-the-community-will-open-governance-accelerate-ai-code-review/ ; https://github.com/qodo-ai/pr-agent/releases
- alibaba/open-code-review: https://github.com/alibaba/open-code-review
- claude-code-action: https://github.com/anthropics/claude-code-action
- claude-code-security-review: https://github.com/anthropics/claude-code-security-review
- Nikita-Filonov/ai-review: https://github.com/Nikita-Filonov/ai-review
- gauthierdmn/nominal-code: https://github.com/gauthierdmn/nominal-code
- goldynlabs/prr-kit: https://github.com/goldynlabs/prr-kit
- baz-scm/awesome-reviewers: https://github.com/baz-scm/awesome-reviewers
- presubmit/ai-reviewer: https://github.com/presubmit/ai-reviewer
- reviewdog: https://github.com/reviewdog/reviewdog
- sourcery: https://github.com/sourcery-ai/sourcery
- danger-js: https://github.com/danger/danger-js
- OpenHands: https://github.com/All-Hands-AI/OpenHands
- Aider: https://github.com/Aider-AI/aider
- Codex CLI: https://github.com/openai/codex
- Continue: https://github.com/continuedev/continue
- LangGraph: https://github.com/langchain-ai/langgraph
- CrewAI: https://github.com/crewAIInc/crewAI
- Mastra: https://github.com/mastra-ai/mastra
- Kodus (AGPL + EE): https://github.com/kodustech/kodus-ai ; https://github.com/kodustech/kodus-ai/blob/main/license_ee.md ; https://kodus.io/self-hosted-ai-code-review/
- qlty (BSL): https://github.com/qltysh/qlty
- qodo-cover (AGPL): https://github.com/qodo-ai/qodo-cover
- CodeRabbit OSS pledge / CLI: https://www.coderabbit.ai/blog/coderabbit-commits-1-million-to-open-source ; https://www.coderabbit.ai/blog/coderabbit-cli-free-ai-code-reviews-in-your-cli
- Greptile / Graphite-Diamond / cubic (closed SaaS, competitors): https://www.greptile.com/content-library/best-ai-code-review-tools
- awesome-ai-agents-2026 (list): https://github.com/caramaschiHG/awesome-ai-agents-2026
