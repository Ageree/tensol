# Hacktron — PR Review Competitive Analysis

*Competitive-intelligence brief, compiled 29 May 2026. Every non-obvious claim is cited to a source URL. Where a fact could not be confirmed it is marked "not found" rather than guessed.*

Hacktron (hacktron.ai) is a pre-seed AI security startup ($2.9M raised May 2026, led by Crane Venture Partners) founded by competitive hackers Zayne Zhang, Mohan Pedhapati, and Harsh Jaiswal, with Fabian Faessler (~1M YouTube subs) on the team. It ships **two products that share one engine**: an AI **PR Review** (continuous code review on every pull request) and **Whitebox** pentests. Their north star is "PoC || GTFO" — every finding ships with a working proof-of-concept, positioning against noisy SAST/AI scanners on the axis of *false-positive reduction via verified exploitability*. ([globenewswire.com](https://www.globenewswire.com/news-release/2026/05/13/3294234/0/en/Hacktron-Raises-2-9M-Pre-Seed-to-Bring-AI-Powered-Security-Testing-to-Every-Code-Change.html), [hacktron.ai](https://www.hacktron.ai/))

---

## Feature Surface

What the PR-review product actually does, per the product page (https://www.hacktron.ai/pr-review):

- **"Hacktron Review is an AI security reviewer for pull requests. It reads changes with codebase context, finds exploitable vulnerabilities, and gives engineers fixes inside GitHub."** (product page tagline)
- **Reviews every PR** before merge — "finds exploitable issues before merge."
- **Codebase context:** "Indexes repositories and call graphs instead of only reading the diff."
- **Auto-resolution of stale alerts:** "Detects remediation commits and resolves stale alerts automatically." (Mirrored in docs: when a fix lands, the finding state moves to `resolved`.)
- **Inline comments:** "Findings are posted on the vulnerable lines in GitHub."
- **Adaptive learning / FP reduction:** learns from triage comments and developer feedback to reduce false positives.
- **Custom rules file:** `.hacktron/rules.md` "to describe auth patterns, trusted sources, ignored paths" (per-repo, in-repo config).
- **Each finding includes a proof-of-concept exploit and an AI-generated fix prompt** ("quicklinks to fixing them with AI" — [docs code-reviews](https://docs.hacktron.ai/platform/code-reviews)).
- **Integrations:** Slack (visibility) and Linear (issue tracking). ([pr-review page](https://www.hacktron.ai/pr-review))

**Vulnerability coverage** (pr-review page): business-logic flaws; SQLi, XSS, SSRF, XXE; **prompt injection**; memory-safety bugs; auth and access control; **infrastructure-as-code exposures**; supply-chain risk; secrets and credentials. Notably broad — it explicitly claims business-logic and prompt-injection coverage, not just the OWASP-pattern set.

---

## What Makes It "Deep" (vs. a shallow linter)

Hacktron's differentiation is explicitly *exploitability reasoning over call graphs*, not syntax matching:

- **Call-graph + repo indexing, not diff-only:** "uses repository context and call graphs to reason about exploitability, not only syntax patterns" and "Indexes repositories and call graphs instead of only reading the diff." ([pr-review](https://www.hacktron.ai/pr-review)) This is **cross-file / whole-repo context**, the key thing that separates it from a diff-scoped linter.
- **Exploitability + reachability triage:** the engine triages findings "prioritizing issues based on exploitability, reachability, and security impact." ([introducing-hacktron blog](https://www.hacktron.ai/blog/introducing-hacktron))
- **Hybrid static + dynamic analysis:** "a hybrid of static and dynamic analysis — reasoning through frontend and backend flows, mapping attack surfaces, and identifying critical data flows and control points." ([introducing-hacktron blog](https://www.hacktron.ai/blog/introducing-hacktron)) → real dataflow / source-sink tracing, not regex.
- **PoC generation as the verification gate:** founders' principle is **"PoC || GTFO"** ([hacktron.ai homepage](https://www.hacktron.ai/)); the platform "generat[es] working proof-of-concept exploits for discovered issues" so findings are verified rather than speculative. Only **verified** findings surface (see Scoring section).
- **Full technical context per finding:** "source traces, affected files, and remediation strategies." ([introducing-hacktron blog](https://www.hacktron.ai/blog/introducing-hacktron))
- Proven against real high-value targets: disclosed criticals in BeyondTrust Remote Support, Next.js/Vercel, Cloudflare, GitHub, GitLab, OAuth2 Proxy; an **RCE in Google's Antigravity AI code editor ($10k bounty)**; Discord Desktop RCE. ([globenewswire](https://www.globenewswire.com/news-release/2026/05/13/3294234/0/en/Hacktron-Raises-2-9M-Pre-Seed-to-Bring-AI-Powered-Security-Testing-to-Every-Code-Change.html), [antigravity blog](https://www.hacktron.ai/blog/hacking-google-antigravity), [discord-rce blog](https://www.hacktron.ai/blog/discord-rce/))

---

## Trigger + Delivery

- **Trigger:** GitHub App. "If a repository is enabled and a PR is made, Hacktron checks if the PR's target branch is configured. If it is, Hacktron reviews the PR." ([docs code-reviews](https://docs.hacktron.ai/platform/code-reviews)) → trigger = PR opened against a *configured target branch* in an *enabled* repo. Branch filtering is per-repo.
- **Delivery:** **Inline PR comments on the vulnerable lines** ("Findings are posted on the vulnerable lines in GitHub"), each with a PoC and an AI fix quicklink. Also pushed to **Slack** (visibility) and **Linear** (tracking). ([pr-review](https://www.hacktron.ai/pr-review), [docs code-reviews](https://docs.hacktron.ai/platform/code-reviews))
- **Coverage / capacity behavior:** "When a developer lacks coverage capacity, the system leaves a PR comment explaining the situation rather than silently skipping the review." ([docs code-reviews](https://docs.hacktron.ai/platform/code-reviews)) — i.e. seat/quota exhaustion is surfaced transparently, not hidden.
- **Check-run vs. inline comment:** primary delivery is inline comments. A formal GitHub **check-run / status gate** is **not found** explicitly documented (no "blocks merge" claim beyond "before merge"). SARIF export exists for GitHub code-scanning ingestion (see below), which *could* feed the Security tab, but auto check-run wiring is not stated.

---

## Onboarding & Repo Selection

Flow (from [docs quickstart](https://docs.hacktron.ai/platform/quickstart) + [docs code-reviews](https://docs.hacktron.ai/platform/code-reviews) + [pr-review](https://www.hacktron.ai/pr-review)):

1. **Install the GitHub App** and "choose the repos Hacktron should review."
2. **Connect GitHub via the Integrations page.**
3. **Repositories page:** select which repos get coverage, and **specify which branches per repository** should be covered.
4. **Developers are auto-discovered** from repo activity — "no manual invitations needed." During the trial, "Dev seats auto-assign as PR activity comes in." ([docs billing-access](https://docs.hacktron.ai/platform/billing-access))
5. Hacktron then posts inline findings; **triage comments tune detection signals** over time.

**Per-repo config:** `.hacktron/rules.md` committed in-repo — "describe auth patterns, trusted sources, ignored paths." ([pr-review](https://www.hacktron.ai/pr-review)) This is a notable design choice: config-as-code lives in the customer's repo, version-controlled with the code.

Onboarding split for new orgs: **"By myself"** (individual CLI/VS Code) vs **"With my team"** (shared org setup). ([docs quickstart](https://docs.hacktron.ai/platform/quickstart)) Note: the CLI / IDE "Workbench" is now **deprecated** — "Hacktron Workbench has been deprecated. The CLI and IDE extensions are no longer available." ([docs index](https://docs.hacktron.ai/)) (Their public `skills` repo still references CLI/VSCode, so docs and repo are inconsistent.)

---

## Scoring & Findings Model

From the REST API finding schema ([list-findings](https://docs.hacktron.ai/api-reference/findings/list-findings), [update-finding](https://docs.hacktron.ai/api-reference/findings/update-finding)):

- **Severity enum (5 levels):** `critical`, `high`, `medium`, `low`, `info`. (No CVSS numeric score exposed; categorical severity only.)
- **State / triage enum:** `open`, `true_positive`, `false_positive`, `accepted_risk`, `resolved`. Triage is a first-class lifecycle.
- **Verification gate:** **"Only findings that have passed automated verification (`verification_status = approved`) are returned"** ([list-findings](https://docs.hacktron.ai/api-reference/findings/list-findings)). This is the productized form of "PoC || GTFO" — unverified candidates never reach the user. (The `verification_status` field itself is filtered server-side and not in the response body.)
- **Finding fields:** `id`, `scan_id`, `found_at`, `updated_at`, `title`, `category` (e.g. "injection", "auth", "xss"), `tags[]`, `affected_file`, `affected_code`, **`proof_of_concept`** ("Reproduction steps or payload"), `description`, `impact`, `root_cause`, `remediation`.
- **Triage mutation:** `PATCH /v1/findings/{id}` lets you change `state` and/or `severity` with optional `reason` / `state_reason` / `severity_reason` (max 2000 chars each). Human override of severity is supported.
- **No explicit numeric confidence score / no reachability flag in the API schema.** Exploitability/reachability are used internally for *triage prioritization* ([blog](https://www.hacktron.ai/blog/introducing-hacktron)) but are **not surfaced as discrete API fields** — confirmed absent in the findings schema. ("Not found" as explicit fields.)
- **Export:** `GET /v1/scans/{id}/findings/export` → **JSON, CSV, or SARIF 2.1.0** (not paginated; "Returns every approved finding"). SARIF is pitched for "GitHub code scanning, Azure DevOps, and most IDE security plugins." ([export-scan-findings](https://docs.hacktron.ai/api-reference/scans/export-scan-findings))

**FP handling = two mechanisms:** (1) the hard automated-verification gate before surfacing; (2) adaptive learning from triage comments + the `false_positive` state + `.hacktron/rules.md` allowlists.

---

## Product Architecture (PR Review ↔ Pentest relationship)

The two products are **the same engine at two cadences**, sharing one scan/finding data model:

- **PR Review (Dev seats):** "ongoing pull request coverage on connected repositories" — continuous, per-PR, per-developer-seat. ([docs pentests](https://docs.hacktron.ai/platform/pentests))
- **Whitebox Pentest (org credits):** "broader assessment with shared credits and owner-controlled start permissions"; cadence is on-demand / monthly / quarterly. Statuses: Draft, Running, Completed, Failed, Cancelled. **Only org owners can start one** (shared-credit guardrail). ([docs pentests](https://docs.hacktron.ai/platform/pentests))
- **Shared scan API:** both run through the same `POST /v1/scans` engine. A scan takes `repos[]` (whitebox source — `source: connected|public|upload`, with `branch`) **and** optional **`target_urls[]`** (live URLs → adds dynamic/blackbox), plus `auth_instructions` (≤2000 chars) and `custom_context` (scope/emphasis/exclusions, ≤2000 chars). ([create-scan](https://docs.hacktron.ai/api-reference/scans/create-scan)) → The PR review is essentially a continuously-triggered, diff-scoped, source-only invocation of the same pipeline that pentests run with full scope + live targets.
- **Cost model:** every scan requires a prior **cost estimation** (`cost_estimation_id`) that "resolves the repositories you plan to scan, detects applications within them, and returns a predicted credit cost." ([create-cost-estimation](https://docs.hacktron.ai/api-reference/cost-estimations/create-cost-estimation)) Exact credit formula (per-LOC / per-app) is **not found**.
- **Methodology (shared):** "a swarm of specialized agents using Gemini 2.5 Pro. Some were purely LLM-based, some AST-based, and others purpose-built for niche vulnerability classes," with "source code review agents...each laser-focused on a different weakness." ([introducing-hacktron blog](https://www.hacktron.ai/blog/introducing-hacktron))

---

## Pricing & Positioning

**Pricing** (from [hacktron.ai homepage](https://www.hacktron.ai/) + [docs billing-access](https://docs.hacktron.ai/platform/billing-access)):

| Tier | Price | Coverage |
|---|---|---|
| Free (OSS) | $0 | Open-source projects |
| Pro | **$40 / developer / month** | **50 PRs/dev/mo, unlimited scans per PR; $1 per additional PR** |
| Enterprise | Custom | — |
| Trial | 14 days | Dev seats auto-assign on PR activity, capped at **200 PRs/seat** |

- **Billing unit = Dev seat** ("A Dev seat covers pull request reviews"), billed on **peak seats used in the cycle** — removing a seat mid-cycle still bills the peak. ([docs billing-access](https://docs.hacktron.ai/platform/billing-access))
- **Pentests = shared org credits**, deducted when a pentest starts; top-up prompts on insufficient balance. ([docs pentests](https://docs.hacktron.ai/platform/pentests))
- **RBAC:** Unassigned / Viewer / Member / Admin / Owner. Roles (capabilities) are decoupled from seats (paid product access). Only Owner buys credits & starts pentests. ([docs billing-access](https://docs.hacktron.ai/platform/billing-access))

**Positioning / messaging:**
- Homepage hero: **"Your AI teammate for security."** "Hacktron collaborates in your workflow, identifies real vulnerabilities, and empowers developers like a senior security engineer."
- Anti-noise stance: **"Stop chasing alerts. Start fixing what's real."** / "finds exploitable vulnerabilities and helps your team fix what matters." ([hacktron.ai](https://www.hacktron.ai/))
- Credibility play: **"Built by elite hackers... we operate by one principle: PoC || GTFO."** DEF CON CTF wins, Black Hat/DEF CON talks. ([hacktron.ai](https://www.hacktron.ai/), [globenewswire](https://www.globenewswire.com/news-release/2026/05/13/3294234/0/en/Hacktron-Raises-2-9M-Pre-Seed-to-Bring-AI-Powered-Security-Testing-to-Every-Code-Change.html))
- **Customer logos:** Perplexity, Supabase, Yoto, Gumroad. ([hacktron.ai](https://www.hacktron.ai/))
- **Traction:** ~$240k revenue in first 9 months (as of May 2026). ([globenewswire](https://www.globenewswire.com/news-release/2026/05/13/3294234/0/en/Hacktron-Raises-2-9M-Pre-Seed-to-Bring-AI-Powered-Security-Testing-to-Every-Code-Change.html))

---

## Tech Hints

- **Model:** **Gemini 2.5 Pro** is the named LLM ("a swarm of specialized agents using Gemini 2.5 Pro"). ([introducing-hacktron blog](https://www.hacktron.ai/blog/introducing-hacktron)) No mention of Claude/GPT.
- **Architecture:** multi-agent "swarm" — mix of pure-LLM agents, **AST-based** agents, and purpose-built detectors per vuln class; per-weakness "source code review agents." Hybrid static+dynamic. ([introducing-hacktron blog](https://www.hacktron.ai/blog/introducing-hacktron))
- **Skills/extension system (public repo, `HacktronAI/skills`):** agents are extended via an **"Agent Skills" spec** — each skill = `SKILL.md` + `scripts/` + `references/` + `assets/`. Examples: **patch-diff-analyzer** (reverse-engineers compiled JAR/DLL binaries to diff patched vs. vulnerable versions), **waf-bypass-hunter** (parser-differential WAF bypass against Coraza/busboy/Next.js), **ctf-solver**. Repo languages: Shell 52%, Python 23%, Go 22%, Dockerfile 3%. Ships isolated Docker test envs (e.g. `vercel-waf-env` = Coraza WAF + vulnerable Next.js 16). ([github.com/HacktronAI/skills](https://github.com/HacktronAI/skills))
- **API surface:** REST API with API-key auth, scans/findings/cost-estimations, pagination+filtering+sorting, rate limits, SARIF/CSV/JSON export. ([docs llms.txt index](https://docs.hacktron.ai/llms.txt))
- **Verification pipeline:** automated `verification_status = approved` gate before any finding is exposed. ([list-findings](https://docs.hacktron.ai/api-reference/findings/list-findings))
- **Data-handling / SOC2 / retention / training-on-customer-data:** **not found** — the docs "Security" page is only a vuln-disclosure contact (hello@hacktron.ai); no compliance/retention page located.

---

## Lessons For Us

**What to copy:**
1. **Verification gate as the core product promise.** The single highest-leverage idea: never surface a finding that hasn't passed automated verification (`verification_status = approved` + a `proof_of_concept`). It converts "AI scanner = noise" objection into the headline feature. Our 0–5 scorer should refuse to emit a finding without a reproduction artifact, mirroring "PoC || GTFO."
2. **Repo+call-graph indexing, not diff-only.** Index the whole repo and reason over call graphs / dataflow so a PR finding can claim *reachability*, not just pattern presence. This is exactly the cross-file context that makes review "deep." (We already have GitNexus call-graph infra — lean into it as the differentiator.)
3. **`.hacktron/rules.md` config-as-code.** Per-repo, version-controlled config for auth patterns / trusted sources / ignored paths. Cheap to build, big trust win, and it doubles as the FP-suppression mechanism. Adopt an equivalent in-repo rules file.
4. **Adaptive FP reduction from triage comments** + a first-class triage state machine (`open → true_positive/false_positive/accepted_risk → resolved`) with **auto-resolve on remediation commit detection**. Stale-alert auto-resolution is a quiet but real UX advantage.
5. **One engine, two cadences (continuous PR + on-demand pentest)** sharing a single scan/finding schema and a `target_urls[]` toggle for blackbox/dynamic. Mirrors our PR-Review + Whitebox split — validates building both on one pipeline rather than two stacks.
6. **Transparent capacity behavior** — when out of quota, *comment saying so* instead of silently skipping. Trust-preserving.
7. **Seat-based pricing anchored low ($40/dev, 50 PRs incl., $1 overage) + free for OSS.** Simple, predictable, land-and-expand; free OSS tier is a credibility/marketing funnel (and a source of the public bug-bounty wins they market with).
8. **Credibility-led GTM:** publish real disclosures (Antigravity RCE, Discord RCE, Next.js, Cloudflare). Public bug-bounty trophies are their cheapest, most effective marketing. We should pursue/publish equivalent finds.

**What to avoid / where they're weak (our opening):**
1. **No numeric confidence and no exposed reachability field in their API** — only categorical severity. We can differentiate by surfacing a numeric confidence + an explicit reachability/exploitability indicator per finding (better for enterprise risk triage and SARIF fidelity).
2. **No documented check-run / merge-gate** — delivery is inline comments only. Offering a real GitHub **required status check** that can *block* merge on critical+verified findings is a concrete feature gap to exploit.
3. **Single-model dependency (Gemini 2.5 Pro).** Model-agnostic routing (and the option to run on the customer's own keys / Claude) is both a resilience and a sales advantage, especially for security-sensitive buyers.
4. **No published compliance/data-handling page** (SOC2, retention, no-train guarantees not found). Enterprise security buyers demand this — leading with a clear data-handling + no-training-on-customer-code commitment is a fast trust win.
5. **Product/docs inconsistency** — CLI/IDE "Workbench" is deprecated yet the public skills repo and onboarding still reference CLI/VSCode. Signals a young, churning surface; we can present a cleaner, single-surface story.
6. **Peak-seat billing** ("billed for the peak seats used in that cycle" even after removal) is a customer-unfriendly gotcha worth undercutting with true usage-based or no-penalty seat removal.

---

## Sources

- https://www.hacktron.ai/ — homepage (hero, products, pricing, logos, PoC||GTFO)
- https://www.hacktron.ai/pr-review — PR Review product page (features, coverage, install flow, rules file)
- https://docs.hacktron.ai/platform/code-reviews — triggers, GitHub setup, inline comments, capacity behavior
- https://docs.hacktron.ai/platform/quickstart — onboarding flow, platform sections
- https://docs.hacktron.ai/platform/pentests — pentest product, credits, statuses, owner-only start
- https://docs.hacktron.ai/platform/billing-access — seats, roles (RBAC), trial limits, peak-seat billing
- https://docs.hacktron.ai/llms.txt — full docs index
- https://docs.hacktron.ai/api-reference/findings/list-findings — finding schema, severity/state enums, verification gate
- https://docs.hacktron.ai/api-reference/findings/update-finding — triage mutation (state/severity)
- https://docs.hacktron.ai/api-reference/scans/create-scan — scan engine (repos + target_urls + auth/context)
- https://docs.hacktron.ai/api-reference/scans/export-scan-findings — JSON/CSV/SARIF 2.1.0 export
- https://docs.hacktron.ai/api-reference/cost-estimations/create-cost-estimation — credit cost estimation
- https://www.hacktron.ai/blog/introducing-hacktron — methodology, Gemini 2.5 Pro agent swarm, hybrid static/dynamic, triage
- https://www.hacktron.ai/blog/hacking-google-antigravity — Antigravity RCE ($10k bounty)
- https://www.hacktron.ai/blog/discord-rce/ — Discord Desktop RCE
- https://github.com/HacktronAI/skills — agent skills spec, patch-diff-analyzer / waf-bypass-hunter / ctf-solver, tech stack
- https://www.globenewswire.com/news-release/2026/05/13/3294234/0/en/Hacktron-Raises-2-9M-Pre-Seed-to-Bring-AI-Powered-Security-Testing-to-Every-Code-Change.html — funding, founders, traction, disclosures
