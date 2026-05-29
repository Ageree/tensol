# CodeRabbit — Architecture & OSS-Stack Analysis

*Competitive-intelligence brief, 29 May 2026. Built for a team shipping a competing AI PR-review GitHub App. Every claim is quoted + cited; where the public record is silent I say "not found" rather than guess.*

---

## Review Pipeline (webhook → context → review → posting)

CodeRabbit explicitly bills itself as **agentic, not a linear RAG pipeline**. The flow per PR:

1. **Trigger.** GitHub App webhook fires on PR open / new commits / chat command. Reviews land "within 1 to 5 minutes" of the PR event ([aicodereview.cc](https://aicodereview.cc/blog/how-to-use-coderabbit/)).
2. **Ephemeral sandbox.** CodeRabbit "spins up an isolated, secure, short-lived environment to do the work" and "pulls only what it needs, constructs the context, runs the checks, and tears everything down after." ([coderabbit.ai blog – massive codebases](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases))
3. **Clone + analyze diff.** "CodeRabbit clones the repo, analyzes the diff, and constructs a code graph that traces how the change connects to the rest of the codebase cross-file and cross-repo." ([WebSearch synthesis of coderabbit.ai context-engineering blogs](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews))
4. **Context enrichment** (the bulk of the work — see next section).
5. **Agentic review + verification.** "an autonomous research agent that actively explores linked repositories in real time" and runs "verification agents to check that every suggestion makes sense within the context of both the PR and the greater codebase." The agent **reflects and adapts** — "tries alternative searches, follows references, reads files to verify" when first attempts miss. ([agentic vs RAG blog](https://www.coderabbit.ai/blog/agentic-code-review-vs-rag-multi-repo-analysis))
6. **Post.** Walkthrough comment + inline comments + committable suggestions written back via the GitHub API (the App holds read-write on Code, Issues, PRs, commit statuses).

**What is actually fed to the LLM.** Not "the whole repo." CodeRabbit's stated philosophy is a **1:1 code-to-context ratio**: *"a 1:1 ratio of code-to-context in our LLM prompts—for every line of code under review, an equal weight of surrounding context is provided"* ([context-engineering blog](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews)). They further claim *"80–90% of token usage goes into context enrichment, not the final review"* ([WebSearch synthesis, massive-codebases blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases)).

---

## Context-Building Strategy

CodeRabbit uses a **hybrid: live agentic exploration + a persistent semantic index**, NOT pure full-repo indexing and NOT pure diff-only.

- **Code graph / AST dependency graph (re-built every review).** "CodeRabbit builds a graph representation of code dependencies" analyzing "definitions of code symbols (e.g. Types)" to find "downstream conflicts that may cause breaking changes"; the graph is "re-generated each time to ensure no new dependencies are missed." For massive codebases they describe it as a *lightweight* graph: "a lightweight map of definitions and references and scans commit history for files that frequently change together." ([context-engineering blog](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews); [massive-codebases blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases))
- **Semantic index / embeddings (persistent, in LanceDB).** "a semantic index (embeddings) of functions, classes/modules, tests, and prior PRs/changes" searched "by purpose, not just keywords." Backed by LanceDB: "tens of thousands of tables (PRs, issues, code dependencies, tribal learnings) indexing millions of daily code interactions." ([massive-codebases blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases); [LanceDB case study](https://www.lancedb.com/blog/case-study-coderabbit))
- **Agentic over RAG for cross-repo.** They explicitly argue against static-index RAG: instead of a nearest-neighbor lookup, the agent "clones them on demand into isolated sandboxed environments," runs `grep` for imports/references, "reads call sites, follows type definitions," and "reads code, counts arguments, checks type compatibility" to flag e.g. a call site that "Will break after the signature change." ([agentic vs RAG blog](https://www.coderabbit.ai/blog/agentic-code-review-vs-rag-multi-repo-analysis))
- **Verification scripts.** The agent generates "shell/Python checks (think grep, ast-grep) to confirm an assumption or extract proof from the codebase." ([massive-codebases blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases))
- **Surrounding engineering knowledge.** Linked issues (Jira, Linear, GitHub/GitLab Issues — "to understand the 'intent' behind code changes"), past PRs ("PR titles, descriptions, and affected commit ranges"), architecture standards, custom review instructions, coding conventions, team learnings, plus **web queries** for "technical information from publicly available release notes or technical documentation." ([context-engineering blog](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews))

> **Summary picture:** diff → live code-graph + commit-co-change scan → semantic retrieval from LanceDB → agentic exploration of dependents/linked repos in a sandbox → linter/SAST findings folded in → assembled into a ~1:1 code:context prompt for task-specific LLMs.

---

## OSS Tools Orchestrated

This is the most concrete competitive signal. CodeRabbit markets "40+ Linters/SAST tools with zero-touch configuration" ([context-engineering blog](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews)); the public tool catalog at [docs.coderabbit.ai/tools/list](https://docs.coderabbit.ai/tools/list) enumerates ~60. All entries below are confirmed from that catalog page (single source for the table unless noted). Licenses are from each tool's own project (standard OSS knowledge; CodeRabbit does not publish per-tool licenses, so verify before relying on any for your own bundling).

| Tool | Purpose | License | Source |
|------|---------|---------|--------|
| **ast-grep** | Structural code pattern search / lint (multi-lang); also used in agent verification scripts | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) + [massive-codebases blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases) |
| **OpenGrep** | Semgrep fork — code-pattern SAST | LGPL-2.1 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Semgrep** | Code quality + security SAST | LGPL-2.1 (CLI) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Gitleaks** | Secret detection (catalog lists it as **"Betterleaks"**, CodeRabbit's wrapper/variant of Gitleaks) | MIT (Gitleaks) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **TruffleHog** | Secret / credential scanning | AGPL-3.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Microsoft Presidio Analyzer** | PII detection | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **OSV-Scanner** | Dependency / package-version vuln scanning | Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Checkov** | IaC security (Terraform/CFN/K8s) | Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Trivy** | IaC / container / dep security | Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Brakeman** | Ruby/Rails SAST | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **ESLint** | JS/TS lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Biome** | JS/TS/JSON lint+format | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Oxlint** | JS/TS lint (Rust-based) | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Ruff** | Python lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Pylint** | Python lint | GPL-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Flake8** | Python lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **golangci-lint** | Go meta-linter | GPL-3.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Clippy** | Rust lint | MIT/Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **RuboCop** | Ruby lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **SwiftLint** | Swift lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **PHPStan / PHPMD / PHPCS** | PHP static analysis / lint | MIT / BSD-3 / BSD-3 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **PMD** | Java/Apex static analysis | BSD-style | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **detekt** | Kotlin static analysis | Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Clang-Tidy** | C/C++ lint | Apache-2.0 (LLVM) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Cppcheck** | C/C++ static analysis | GPL-3.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Luacheck** | Lua lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **ShellCheck** | Shell-script lint | GPL-3.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Blinter** | Batch-file lint | (verify) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Fortitude** | Fortran lint | (verify) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Regal** | Rego/OPA lint | Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **PSScriptAnalyzer** | PowerShell lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **smarty-lint** | Smarty template lint | (verify) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **SQLFluff** | SQL lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Prisma Lint** | Prisma schema lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Stylelint** | CSS/SCSS lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **HTMLHint** | HTML lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **ember-template-lint** | Ember template lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **YAMLlint** | YAML lint | GPL-3.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Dotenv Linter** | .env lint | MIT/Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Buf** | Protobuf lint/breaking-change | Apache-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **checkmake** | Makefile lint | (verify) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Shopify CLI** | Shopify theme lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **TFLint** | Terraform lint | MPL-2.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **Hadolint** | Dockerfile lint | GPL-3.0 | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **actionlint** | GitHub Actions workflow lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **CircleCI config validation** | CI config check | n/a (CLI) | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **markdownlint** | Markdown lint | MIT | [tools/list](https://docs.coderabbit.ai/tools/list) |
| **LanguageTool** | Prose / grammar check | LGPL-2.1 | [tools/list](https://docs.coderabbit.ai/tools/list) |

Notes: "Betterleaks" appears to be CodeRabbit's in-house wrapper around Gitleaks (the catalog's secret-scanner slot; treat as Gitleaks-derived). Semgrep + OpenGrep are both listed — they hedge the Semgrep-license shift by also shipping the OpenGrep fork. Findings from all of these are "fold[ed] ... into our easy-to-read and understand reviews" rather than dumped raw ([massive-codebases blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases)).

---

## Onboarding & Repo Selection

Standard GitHub App OAuth + installation flow ([docs.coderabbit.ai/platforms/github-com](https://docs.coderabbit.ai/platforms/github-com)):

1. **OAuth login.** "Login with GitHub" → GitHub consent screen requesting "read-only access to: Organizations and teams associated with your GitHub account, Email addresses..." → "Authorize coderabbitai."
2. **Org/account scope.** "Choose the organization where you want to install CodeRabbit." Supports multiple orgs or "For personal repositories, select your account name." → **org-level install** (GitHub App), not per-repo apps.
3. **Repo picker (the key UX).** Two choices, native to GitHub's App install screen:
   - **All repositories** — "Grants access to all current and future repositories owned by this organization, including public repositories."
   - **Only select repositories** — "Limits access to specific repositories you choose from the list."
   - "You can change this setting later if needed."
4. **Permissions granted.** Read-only: Actions, checks, discussions, members, metadata. Read-write: **Code, commit statuses, issues, pull requests.**
5. **Post-install.** "Install & Authorize" → then "Trigger a review" on an existing PR or "Skip to App" (dashboard).

**Config** lives in a `.coderabbit.yaml` in-repo or via the web dashboard ([dev.to walkthrough](https://dev.to/crosspostr/easily-perform-ai-powered-code-reviews-in-minutes-coderabbit-github-28d3)).

**Trigger / control commands** (PR comments, [docs.coderabbit.ai/guides/commands](https://docs.coderabbit.ai/guides/commands)):
- `@coderabbitai review` — incremental review (delta since last review)
- `@coderabbitai full review` — re-reviews the entire PR fresh, ignoring prior comments
- `@coderabbitai summary` — regenerate the PR summary
- `@coderabbitai resolve` — mark all its comments resolved
- `@coderabbitai pause` / `resume` — toggle auto-reviews on a PR
- `@coderabbitai ignore` — (in PR description) disable auto-review entirely
- `@coderabbitai generate sequence diagram`
- `@coderabbitai configuration` — dump current config
- `@coderabbitai help`

---

## Incremental Review & Learnings

**Incremental review.** Reviews re-run "When new commits are pushed to an existing pull request" ([DeepWiki code-review-system](https://deepwiki.com/coderabbitai/coderabbit-docs/4-code-review-system)). The `@coderabbitai review` command is documented as an **"incremental review (what changed since last review)"** vs `full review` which "disregards any comments that CodeRabbit has already made" ([docs/commands](https://docs.coderabbit.ai/guides/commands)). The exact delta-diffing mechanism for auto-triggered incremental runs is **not documented in detail (not found)**.

**Learnings / memory** ([docs.coderabbit.ai/integrations/knowledge-base](https://docs.coderabbit.ai/integrations/knowledge-base)):
- Definition: "Adaptive AI memory. CodeRabbit learns your team's review preferences from natural-language chat and applies them automatically to future reviews."
- Bootstraps from chat: "Starts learning from your first `@coderabbitai` chat interaction."
- Stored on CodeRabbit infra (org-scoped knowledge base); in self-hosted it's an object store (S3/GCS) — `OBJECT_STORE_URI` points to "a storage location for the learnings database." In LanceDB terms these are the "tribal learnings" tables, re-embedded in an "always-on learning loop" where "developer chats and PR outcomes are re-embedded ... without manual reindexing" ([LanceDB case study](https://www.lancedb.com/blog/case-study-coderabbit)).
- Opt-out: `knowledge_base.opt_out: true` "immediately and irrevocably removes all stored knowledge base data, including learnings."
- Privacy: "CodeRabbit never uses customer code for model training, whether data retention is enabled or disabled."

**Code guidelines (distinct from learnings).** Auto-detected: "CodeRabbit reads coding standards from `.cursorrules`, `CLAUDE.md`, `.github/copilot-instructions.md`, and other AI agent configuration files — no manual import required." This is a notable, cheap onboarding win — it free-rides on config files teams already have.

**Chat.** Agentic chat (Pro+) lets users reply to comments / ask questions; replies feed the learning loop.

---

## Scoring & Output

- **Numeric score:** **Not found / no.** The official docs and DeepWiki describe no numeric quality score. (This is a differentiator opportunity vs. your 0–5 scorer — CodeRabbit deliberately outputs prose + severity, not a single number.)
- **Walkthrough comment:** first comment on the PR — "An overview of the entire pull request, including changes, intent, and sequence diagrams"; organized by file and purpose ([DeepWiki](https://deepwiki.com/coderabbitai/coderabbit-docs/4-code-review-system)).
- **Summary:** "Overall assessment of the changes, including positive aspects and areas for improvement."
- **Diagrams:** auto-generated when warranted — "When the structure of a layer warrants it, such as a new API contract, a state transition, or a cross-service call sequence." Renders "whether that is a sequence diagram, a state machine, or an entity-relationship diagram" (Mermaid). Toggleable per-org ([introducing Atlas / Review interface blog](https://www.coderabbit.ai/blog/introducing-atlas-the-first-ai-native-code-review-interface)).
- **Inline comments:** per-line, each with issue description + "an explanation of why it matters" + often a one-click **committable suggestion** ([aicodereview.cc](https://aicodereview.cc/blog/how-to-use-coderabbit/), [DeepWiki](https://deepwiki.com/coderabbitai/coderabbit-docs/4-code-review-system)).
- **Severity:** third-party write-ups report severity tiers (critical / high / medium / low), but this is **not crisply confirmed in first-party docs** — treat as likely-but-unconfirmed. DeepWiki explicitly notes "doesn't mention numeric scores or explicit severity classifications." (mixed evidence)

---

## Self-Hosted Architecture

Available **only to Enterprise** customers (third-party sources cite a 500+ seat floor; first-party pricing lists "self-hosting option" under Enterprise without a public seat number). Architecture revealed by the install docs ([docs.coderabbit.ai/self-hosted/azure-devops](https://docs.coderabbit.ai/self-hosted/azure-devops), [DeepWiki self-hosted guide](https://deepwiki.com/coderabbitai/coderabbit-docs/3.1-self-hosted-installation-guide)):

- **Single Docker image:** `coderabbit-agent:latest`, run via `docker run --env-file .env --publish 127.0.0.1:8080:8080 .../coderabbit-agent:latest`. Deployable on a server, serverless, or Kubernetes. Exposes `/health`.
- **Stateless, event-driven:** receives Git-platform webhooks (PR/comment/update), calls external LLM APIs, posts back. State (learnings) externalized to an object store (`OBJECT_STORE_URI` = `s3://...` or `gs://...`).
- **System requirements:** "Ability to run Docker containers" + outbound network to LLM providers and Git APIs + "Minimal storage for caching and temporary files." **Specific CPU/RAM/disk: not found.**
- **Air-gapped:** the agent itself assumes outbound LLM connectivity, so true air-gap needs a self-hosted model endpoint. (LanceDB is the air-gap enabler on the *retrieval* side — "a single lightweight binary deploys in secure, air-gapped environments in minutes" — but the LLM still needs an endpoint.) ([LanceDB case study](https://www.lancedb.com/blog/case-study-coderabbit))

**Architectural takeaway:** the product is essentially a stateless review-orchestration agent + an embedded vector store (LanceDB, file-based, deployable as one binary) + pluggable LLM backends. The whole heavy "context engine" collapses into a Docker image + object store precisely because LanceDB is embedded/file-based rather than a separate clustered service.

---

## Embeddings & LLMs

**Vector DB — confirmed LanceDB.** They migrated *off* a prior vector DB whose "pricing model became unsustainable" and which gave "no viable path for true on-premises deployment." LanceDB now backs the "context engine": "tens of thousands of tables ... indexing millions of daily code interactions," "sub-second latency for semantic search across millions of code interactions," "Retrieves relevant context for 50K+ daily PRs with P99 latency under 1 second," "usage scales 100x" with stable cost ([LanceDB case study](https://www.lancedb.com/blog/case-study-coderabbit)). **Embedding model name: not publicly disclosed** (self-hosted Azure config references an embedding deployment named `text-embedding-3-large`, which strongly implies OpenAI's `text-embedding-3-large` — see below).

**LLM providers** (from self-hosted env config, [docs.coderabbit.ai/self-hosted/azure-devops](https://docs.coderabbit.ai/self-hosted/azure-devops), [DeepWiki](https://deepwiki.com/coderabbitai/coderabbit-docs/3.1-self-hosted-installation-guide)):
- **OpenAI** — `LLM_PROVIDER=openai`, `OPENAI_API_KEYS`
- **Anthropic** — `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEYS`
- **Azure OpenAI** — `LLM_PROVIDER=azure-openai`; required model deployments include `text-embedding-3-large`, `gpt-4.1-mini`, `o4-mini`, `o3`, and optionally `gpt-5.4` (per the azure-devops page; the DeepWiki capture lists `gpt-4.1-mini`, `o4-mini`, `o3`).
- **AWS Bedrock** — `LLM_PROVIDER=bedrock-anthropic`; requires access to `claude-3-haiku`, `claude-3-5-haiku`, `claude-sonnet-4`, `claude-opus-4`.
- **NVIDIA model routing** mentioned as an alternative provider.

> Inference for us: CodeRabbit is **model-agnostic via a provider abstraction** and uses a *tiered model strategy* — small/cheap models (gpt-4.1-mini, claude-3-5-haiku) for the high-volume context-enrichment passes, reasoning models (o3, claude-opus-4/sonnet-4) for the final review. The presence of `text-embedding-3-large` plus the multi-tier Claude requirement is the strongest public evidence of how they split work. (The named models look like a [BerriAI/litellm](https://github.com/BerriAI/litellm)-style multi-provider gateway, though CodeRabbit does not confirm litellm.)

---

## Pricing

From [coderabbit.ai/pricing](https://www.coderabbit.ai/pricing) (billed annually):

| Tier | Price | Highlights |
|------|-------|-----------|
| **Free** | $0 | 14-day Pro-Plus trial, no card. Unlimited public + private repos, PR summarization, IDE/CLI reviews. **Pro features are free, forever, on all public repos.** |
| **Pro** | **$24 / user / mo** | Linters + SAST, Jira/Linear, agentic chat, analytics, customizable reports, docstring generation, 5 MCP connections, 1 linked-repo analysis, 5 reviews/hr |
| **Pro Plus** | **$48 / user / mo** | All Pro + custom pre-merge checks, advanced finishing touches (unit-test gen, simplify, merge-conflict resolution), 15 MCP, 10 linked-repos, 10 reviews/hr |
| **Enterprise** | Custom | All Pro Plus + RBAC/SSO, audit logging, API access, **self-hosting**, multi-org, SLA, dedicated CSM, EU SaaS region |
| **Slack Agent** | **$0.50 / agent-minute** | Incident investigation, planning, code-gen via Slack |

**CLI:** free with a CodeRabbit account, **3 reviews/hr** on free tier ([coderabbit.ai/cli](https://www.coderabbit.ai/cli)). **OSS:** full Pro engine free on all public GitHub/GitLab repos, no activation.

---

## Lessons For Us

1. **Context engineering, not the LLM, is the moat.** Their headline claim is 80–90% of tokens on context + a 1:1 code:context ratio. A diff-only competitor will be visibly worse on cross-file bugs. Budget most engineering on the retrieval/graph layer.
2. **Agentic > static RAG for cross-repo breaking changes.** Their sharpest demo is "these 3 call sites will break after this signature change, with file:line." Replicate with a re-built-per-review dependency graph + an agent that greps/reads call sites and counts args — this is exactly what your GitNexus impact-graph already does, so lean into it as a differentiator.
3. **OSS linters are commodity glue, fold-in not bolt-on.** ~60 OSS tools, run in a sandbox, findings *summarized into prose* not dumped. Our pentest stack (Opengrep/Semgrep, Gitleaks, Trivy, ast-grep) overlaps heavily — note CodeRabbit ships **OpenGrep** alongside Semgrep to dodge the LGPL/commercial-Semgrep risk; do the same.
4. **Embedded LanceDB is the on-prem unlock.** A file-based, single-binary vector store is why their entire context engine ships as one Docker image + an S3/GCS bucket. For our GCP-ephemeral-VM model, an embedded store avoids running a vector DB service per scan.
5. **Tiered model routing.** small model (gpt-4.1-mini / haiku) for enrichment, reasoning model (o3 / opus / sonnet) for the verdict. Matches our litellm + qwen approach; keep the abstraction.
6. **Frictionless onboarding via existing config files.** Auto-ingesting `CLAUDE.md` / `.cursorrules` / `copilot-instructions.md` as guidelines is a cheap, high-trust onboarding win — copy it.
7. **No numeric score is a gap we already fill.** CodeRabbit ships severity + prose, no single number. Our 0–5 scorer + "loop until 5/5" is a genuinely different, more actionable UX — lead with it.
8. **OSS-free is the growth flywheel.** Free forever on public repos got them Appsmith/Neon/Plane as logos. Match it to seed adoption.
9. **Command grammar is a low-cost expectation.** Users expect `@bot review` / `full review` / `resolve` / `pause`. Cheap to implement, table-stakes for parity.

---

### Source index
- docs.coderabbit.ai: [tools/list](https://docs.coderabbit.ai/tools/list), [platforms/github-com](https://docs.coderabbit.ai/platforms/github-com), [guides/commands](https://docs.coderabbit.ai/guides/commands), [integrations/knowledge-base](https://docs.coderabbit.ai/integrations/knowledge-base), [self-hosted/azure-devops](https://docs.coderabbit.ai/self-hosted/azure-devops)
- coderabbit.ai blog: [massive codebases](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases), [context engineering](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews), [agentic vs RAG](https://www.coderabbit.ai/blog/agentic-code-review-vs-rag-multi-repo-analysis), [Atlas review interface](https://www.coderabbit.ai/blog/introducing-atlas-the-first-ai-native-code-review-interface), [pricing](https://www.coderabbit.ai/pricing), [CLI](https://www.coderabbit.ai/cli)
- [LanceDB case study](https://www.lancedb.com/blog/case-study-coderabbit)
- DeepWiki: [self-hosted install](https://deepwiki.com/coderabbitai/coderabbit-docs/3.1-self-hosted-installation-guide), [code review system](https://deepwiki.com/coderabbitai/coderabbit-docs/4-code-review-system)
- GitHub: [coderabbitai/ai-pr-reviewer](https://github.com/coderabbitai/ai-pr-reviewer/blob/main/README.md) (legacy OSS action, gpt-3.5/gpt-4, now maintenance-mode), [awesome-coderabbit](https://github.com/coderabbitai/awesome-coderabbit)
- Third-party: [aicodereview.cc](https://aicodereview.cc/blog/how-to-use-coderabbit/), [dev.to](https://dev.to/crosspostr/easily-perform-ai-powered-code-reviews-in-minutes-coderabbit-github-28d3)
