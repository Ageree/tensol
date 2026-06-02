# Greptile — Context Engine & Review Analysis

*Competitive intelligence, compiled 29 May 2026. Greptile = AI code review (YC-backed) built on a "complete graph of your repository" + agentic multi-hop review producing a 0–5 confidence score. Docs live at `www.greptile.com/docs` (note: `docs.greptile.com` is NOT their docs host — it's `www.greptile.com/docs`, served as `.md` via `/docs/llms.txt`).*

---

## Codebase Indexing Engine

Greptile builds a **graph of the whole repo first, then runs an agentic search over it per PR**. The pipeline is AST → docstrings → embeddings, stored as a queryable graph.

**The graph (their own docs):**
- "Greptile builds a complete graph of your repository containing every code element." Three steps:
  1. **Repository Scanning** — "Parses every file to extract directories, files, functions, classes, variables."
  2. **Relationship Mapping** — "Connects all elements: function calls, imports, dependencies, variable usage."
  3. **Graph Storage** — "Stores the complete graph for instant querying during code reviews."
  — https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context.md
- Per-symbol the graph answers: **Function Dependencies** (what it calls/imports), **Function Usage** ("Usage sites discovered" — all call sites), and **Pattern Consistency** (compare against similar patterns elsewhere). Marketed as "Surfaces impacted callers and contracts" and "Detects cross-file inconsistencies." — https://www.greptile.com/docs/code-review/key-features.md

**The actual indexing mechanics (Hatchet case study — the most technical disclosure):**
- "Greptile parses the **AST** of the codebase, **recursively generates docstrings for each node in the tree, and then embeds the docstrings**." — i.e. AST nodes → LLM-written docstring → embedding (not raw-code embedding).
- Search is hybrid + agentic: "semantic similarity search, keyword search, and **'agentic search' where an agent reviews the relevance of results**."
- The hard scaling problem: "processing is often **stuck at 99% completion due to the large number of leaf nodes in the AST dependency chain**." They "broke up their workflow into **4 key steps which could be resumed automatically or manually on failure**."
- Scale proof: "process massive codebases like the **Linux kernel, Python, and VS Code**." Adopting Hatchet → "Failed workflow runs reduced by 50%" and "double their number of users in just 2 weeks."
  — https://hatchet.run/customers/greptile

**What's fed to the LLM per PR (the agentic loop, from v3):**
- "let the system run in a **loop, with access to some key tools such as codebase search and accessing learned rules**" and "continue **recursively searching the codebase to follow nested function calls**."
- A review = read diff → codebase search → follow nested call chains → check git history → trace impact → emit line-level comments. So the LLM gets the diff + agent-retrieved graph neighborhood (callers, callees, similar patterns, learned rules), NOT the whole repo.
  — https://www.greptile.com/blog/greptile-v3-agentic-code-review ; corroborated by independent writeups (https://www.greptile.com/docs/code-review/first-pr-review.md)

**Monorepo / incremental:** Indexing "typically 1-2 hours for very large repos"; new PRs auto-review only after index completes (https://www.greptile.com/docs/quickstart.md). Cross-repo context via `context.repos` config key lets one repo's review pull in related repos (https://www.greptile.com/docs/code-review/greptile-json-reference.md). **Explicit incremental-reindex strategy on push: not found** (the 4-step resumable Hatchet workflow implies re-runnable indexing, but the doc doesn't spell out diff-only delta indexing).

**Embedding/PageRank specifics:** PageRank-style dependent ranking — **not found** (no mention; their "ranking" is the agentic relevance-review step + embedding similarity). Embedding model name — **not found**. Embeddings are stored in Postgres `pgvector` (see Tech Hints).

---

## Confidence Score & FP Handling

**The 0–5 confidence score (their published rubric):**
- 5/5 = "Production ready"; 4/5 = "Minor polish needed"; 3/5 = "Implementation issues"; 2/5 = "Significant bugs"; 0–1/5 = "Critical problems."
- Computed "based on **severity and quantity of issues found, the complexity of changes**" (and, per marketing, "how well the code aligns with your codebase patterns").
- What it gates: it's a **triage signal, not a hard merge block** — "this PR is clean, merge it, or this one has problems, spend your time here." They claim a "3.6x difference in merge speed" between high- and low-confidence PRs.
  — https://www.greptile.com/docs/code-review/first-pr-review.md ; https://www.greptile.com/blog/greptile-v3-agentic-code-review

**Severity badges on inline comments (separate from the 0–5 score):**
- **P0 (Critical):** "Must fix before merging — security vulnerabilities, data loss, crashes"
- **P1 (High):** "Should fix — bugs, incorrect behavior, edge cases"
- **P2 (Medium):** "Consider fixing — code quality, maintainability, best practices"
- Comment categories: **Logic** (bugs), **Syntax** (compilation), **Style** (best practices) — these map to the `commentTypes` config `["logic","syntax","style","info"]`.
  — https://www.greptile.com/docs/code-review/first-pr-review.md

**Self-consistency / rationale pattern (the closest thing to "rationale before severity"):**
- v3 "can **challenge its own hypothesis more strongly**," giving an "increased **threshold for 'sureness'**" → higher precision. "lower confidence comments can be safely eliminated. The **acceptance rate for v3 is 70.5% higher than v2**." This is a confidence-gated emit: the agent self-verifies before posting, and low-confidence findings are dropped.
  — https://www.greptile.com/blog/greptile-v3-agentic-code-review

**Fighting nits / FPs — the learning system (their real FP lever):**
- "Greptile reads the **first and last commit of every PR** to see which comments were addressed." After repeated dismissal — "**After 3 ignores**" of a style category — it suppresses that comment type ("Stop semicolon comments, prioritize security"). Thumbs up/down reactions = instant feedback.
- **Never suppressed:** "Security vulnerabilities, Memory leaks, Infinite loops, Null pointer exceptions, Data validation missing from user inputs." **Suppressible:** "Style/formatting, Import organization, Missing documentation (non-critical), Naming convention deviations, Code organization preferences."
- Claimed outcome: "**80% reduction in ignored comments**" and "3x higher suggestion adoption rate," ramping "Week 1-2: high noise → Week 9+: highly personalized."
  — https://www.greptile.com/docs/how-greptile-works/nitpicks.md ; https://www.greptile.com/docs/how-greptile-works/memory-and-learning.md

**Config knobs for noise:** `strictness` 1–3 (1 = "Comments on everything (low threshold)", 3 = "Shows only the most critical issues"); `commentTypes` whitelist ("only the types you list will appear"); `ignorePatterns` (gitignore-style); `skipReview: "AUTOMATIC"` for manual-only. — https://www.greptile.com/docs/code-review/controlling-nitpickiness.md

**The FP reputation (independent / HN — the competitor opportunity):**
- Highest bug-catch rate in benchmarks (~82%, vs CodeRabbit 44%, Copilot 54%) BUT "**11 false positives where CodeRabbit flagged 2**." Independent analysis: "close to **60% of Greptile reviews land in the nitpick or false-positive bucket**." HN: "pure noise," "ran it for 3 PRs and gave up." A cited hallucination: claimed "Python 3.14 does not exist yet" — it does. v4 (Mar 2026) targeted FP reduction but "community sentiment hasn't visibly shifted."
- v4 measured gains: addressed comments/PR 0.92→1.60 (+74%), % comments addressed 30%→43% (+44%), positive replies/PR 0.31→0.52 (+68%).
  — https://www.greptile.com/blog/greptile-v4 ; https://aicoolies.com/reviews/greptile-review ; https://www.surmado.com/blog/best-greptile-alternatives-2026

---

## Onboarding & Repo Selection

Flow (their quickstart, GitHub path):
1. "Log in to your Greptile account or sign up via email, Google, Github, or GitLab."
2. "Go to **Code Providers** in the sidebar and click **Add Provider**, then select GitHub to link your account" → installs the GitHub App.
3. **Repo authorization:** "Select the type of repository access you want to grant Greptile" — all repos or a specific selection (standard GitHub App scoping).
4. **Repo selection / enable:** "Go to your team's **Repositories page**" → "Select the repos you want reviewed, then click **Enable Repos**." Enabling triggers indexing.
5. Wait for index ("typically 1-2 hours for very large repos"); "any new pull/merge request will initiate automated code reviews."
6. "Make a test PR to your indexed repo" → full review posted.
- GitLab path differs: PAT with `api` scope + webhook config (URL/secret/triggers supplied by Greptile) rather than an App.
  — https://www.greptile.com/docs/quickstart.md

**Re-review trigger:** comment **`@greptileai`** (note: `@greptileai`, not `@greptile`) on the PR; the review footer also has a re-trigger button. `skipReview: "AUTOMATIC"` makes reviews manual-only via that mention. — https://www.greptile.com/docs/code-review/first-pr-review.md

---

## Posting & Thread Model

**Lifecycle:** 👀 reaction on detection → builds context from the codebase graph → 👍 when feedback posted. "~3 minutes" typical. — https://www.greptile.com/docs/code-review/first-pr-review.md

**Summary comment contains:** plain-language Summary ("what the PR does, who it affects, and why"); the **0–5 Confidence Score**; a **Files Changed & Issues** table (file-by-file); auto-generated **Diagrams** (Sequence / Entity-Relation / Class / Flow depending on change type); a **footer** with review counter, last-reviewed-commit link, and re-trigger button.

**Inline comments:** P0/P1/P2 severity badge + category (Logic/Syntax/Style) + usually a **Suggested Fix** code block (apply directly or pull into IDE via MCP). A "**Fix with your Agent**" button hands "file paths, line numbers, and suggested code" to Claude Code/Cursor/etc.

**Check-run / merge gating:** posts as a status check controlled by the `statusCheck` config key; individual summary sections (issues table, confidence score, diagrams) toggle independently. The 0–5 score is advisory — to actually block merges you wire GitHub branch protection to the Greptile status check. Marketed as cloud SOC2 Type II / self-host / air-gapped. — https://www.greptile.com/docs/code-review/key-features.md ; greptile-json-reference.md

**Thread resolution:** Greptile **edits its summary comment in place** rather than always posting new ones (key for parsers — see Client Skills). Individual review threads are resolved via GitHub's `resolveReviewThread` GraphQL mutation.

---

## Client Skills (API surface implications)

`github.com/greptileai/skills` (MIT, ~193★) — two agent skills, auto-detect platform (GitHub/GitLab/Perforce), require `gh`/`glab`/`p4` CLI authed. Installed at `~/.claude/skills/<name>/SKILL.md`. This repo is the **clearest map of Greptile's real client-facing API surface** because it's the workflow Greptile itself ships.

**`greploop` — auto-fix loop until 5/5 (this is exactly the competitor pattern to clone):**
- Detect platform: `p4 info` first, else inspect git remote URL. PR id: `gh pr view` / `glab mr view --output json` (`.iid`) / `p4 changes -s pending`.
- Loop (**max 5 iterations**):
  1. Push, then trigger: `git push` + `gh pr comment <PR> --body "@greptile review"` (or `p4 shelve -f -c <CL>`).
  2. **Poll for completion** — GitHub: `gh api repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs` until status `completed`; GitLab: poll pipeline jobs by SHA until the `greptile` job finishes.
  3. **Parse the score** from multiple sources (PR/MR body, most-recently-updated comment, inline comments), matching patterns like `"3/5"`, `"5/5"`, `"Confidence: 3/5"`.
  4. **Exit when:** "Confidence score is **5/5** AND there are **zero unresolved comments**" — else continue.
- **Resolve threads** — GitHub GraphQL: `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "ID"}) }'`; GitLab REST: `glab api --method PUT "projects/:fullpath/merge_requests/<IID>/discussions/<ID>" --field resolved=true`.

**`check-pr` — one-shot audit of a PR's review state:**
- Fetch: `gh pr view <PR> --json title,body,state,reviews,comments,headRefName,statusCheckRollup`.
- **Critical parsing rule:** "Always inspect the **latest Greptile-authored general comment by `updated_at`**" — because the bot **edits comments in place** (a naive "latest comment" scrape misses the updated score).
- **List unresolved threads** via GraphQL — paginated `reviewThreads(first:100)` returning `{ id isResolved comments(first:1){ nodes{ body path } } }`, then batch-resolve via aliased mutations.
- **Poll status checks** every 30s until terminal (`statusCheckRollup`).
- Classifies issues as **actionable / informational / already-addressed**.

**Implications for us:** (1) the entire integration surface is **GitHub/GitLab native APIs** — no proprietary Greptile REST API needed; the score is just text in a PR comment/check, parsed by regex `\d/5`. (2) Trigger = a magic `@greptile review` comment. (3) Resolution = standard `resolveReviewThread` GraphQL. (4) The "edit-in-place comment" behavior is a parsing gotcha worth copying *or* avoiding (sort by `updated_at`). A competitor can ship an identical greploop/check-pr the day they expose a `\d/5` score + a status check.
  — https://github.com/greptileai/skills ; raw SKILL.md files in `greploop/` and `check-pr/`

---

## Tech Hints

From the self-host **System Architecture** doc (most concrete stack disclosure):
- **Orchestration:** containers on a single Linux host via **Docker Compose** (or Kubernetes); services `greptile-web` (3000), `greptile-api` (3001), `greptile-auth` (3002).
- **Indexing workers:** `greptile-indexer-chunker` ("Splits repositories into chunks for indexing") + `greptile-indexer-summarizer` ("Generates repository summaries").
- **Workflow engine:** **Hatchet** (`hatchet-api` 8080, `hatchet-engine` 7077) over **RabbitMQ** (`hatchet-rabbitmq` 5673). Confirmed by the Hatchet case study.
- **Datastore + vector DB:** **PostgreSQL with pgvector** (`greptile-postgres`) stores "Repository metadata and summaries, **Code embeddings (via pgvector)**, Review history and analytics, User accounts." So vector DB = pgvector, not Pinecone/Weaviate.
- **LLM routing:** `greptile-llmproxy` (port 4000) — "supporting multiple LLM backends including **OpenAI, Anthropic, and AWS Bedrock**" (model-agnostic proxy). v2 context referenced "GPT-4 to Claude 3.5 Sonnet"; **exact current model for v3/v4: not found** (proxy is configurable; cloud default model not disclosed).
- **K8s scaling guidance** (LLM-bound): `api` 20 replicas, `summarizer` 50, `reviews` 36.
- **Languages:** skills/VSCode-ext/chameleon are **TypeScript**; CLI is **Shell**; on-prem (`akupara`) is **HCL/Helm**.
  — https://www.greptile.com/docs/system-architecture.md ; https://hatchet.run/customers/greptile ; https://github.com/greptileai

---

## Pricing

(https://www.greptile.com/pricing ; https://www.greptile.com/blog/greptile-v4)
- **Developer / Free:** free, for OSS. "Free for OSS projects" with MIT/Apache/GPL licenses.
- **Pro:** **$30 /seat/month**, **50 code reviews per seat included**, **$1 per additional review** ("Less than 10% of active users will exceed the included usage"). Unlimited repositories, unlimited users, custom rules, unlimited external app connections. No self-host/SSO.
- **Enterprise:** **Custom**. Adds "Option to self-host in your own infrastructure," "Security and compliance," "SSO/SAML," "GitHub Enterprise support," dedicated Slack support, custom DPA/invoicing.
- **Startups:** "50% off for early-stage startups" (Pre-Series A, <$2M revenue). 14-day free trial, no card.
- **Pricing controversy:** v4 (Mar 2026) switched from flat $30 to **$30 + $1/review-over-50** — flagged by press as "Greptile Now Charges Per Review. Nobody Else Does." (https://www.agent-wars.com/news/2026-05-01-greptile-per-review-pricing). A wedge for us: flat/unlimited pricing.

---

## Lessons For Us

1. **The graph is AST → docstring → embedding, NOT raw-code embedding.** Greptile's moat = recursively LLM-summarizing each AST node then embedding the *summary*, retrieved by hybrid (semantic + keyword + agentic-relevance) search. Cheaper alt: tree-sitter symbol graph + on-demand summaries for the diff's neighborhood only — we don't need to docstring the whole Linux kernel up front.
2. **Indexing scale is the real bottleneck, not review quality.** Their own pain ("stuck at 99% … leaf nodes in the AST dependency chain") forced a resumable 4-step Hatchet workflow. Budget for a durable, resumable job engine (Hatchet/Temporal/our own) from day one; treat full-repo index as a fault-tolerant DAG.
3. **Two-axis severity model:** a per-PR **0–5 confidence triage score** (severity × quantity × complexity) on top of per-comment **P0/P1/P2 + Logic/Syntax/Style**. Copy this — it's what makes greploop's "stop at 5/5" possible and gives teams a single merge-readiness number.
4. **FP is the #1 attack surface.** Greptile trades precision for recall (82% catch but ~11 FP/run, "60% nit/FP", HN "pure noise," a real hallucination). Their only FP defense is *post-hoc* learning ("after 3 ignores"). **Win by adding a static-analysis ground-truth layer (Opengrep/Trivy/Gitleaks SARIF) so findings are verified before the LLM ever opines** — kills the "Python 3.14 doesn't exist" class of hallucination structurally, which their LLM-only design cannot.
5. **Confidence-gated emit + self-challenge** ("increased threshold for sureness," "lower-confidence comments safely eliminated") is the cheap precision lever — have the agent re-verify each finding against the graph and drop sub-threshold ones before posting. This alone gave them +70% acceptance v2→v3.
6. **Learning loop = read first vs last commit + reactions.** Suppress style after N ignores, NEVER suppress security/memory/null/validation. Easy to replicate and high-trust.
7. **Integration surface is trivially cloneable** — it's just GitHub/GitLab native APIs: `@greptile review` trigger, a `\d/5` score in an editable PR comment, a status check, and `resolveReviewThread` GraphQL. Ship our own greploop/check-pr skills on day one; the gotcha to honor is "sort comments by `updated_at`" (bots edit in place). Our `sthrip-loop` skill already mirrors this exact pattern.
8. **Stack is pragmatic and ungated:** Postgres+pgvector (no exotic vector DB), an LLM proxy (model-agnostic, OpenAI/Anthropic/Bedrock), Docker-Compose self-host. Low-cost to match; differentiate on the verification layer + flat pricing, not infra.
9. **Pricing wedge:** their Mar-2026 move to $1/review-over-50 drew negative press. Flat unlimited (or generous included) pricing is a marketing lever; enterprise self-host/SSO is where the real money is (matches their tiering).

### Open items / not found
- Exact current production LLM for v3/v4 reviews (proxy is configurable; default undisclosed).
- Embedding model name; whether any PageRank-style dependent ranking exists (their "ranking" = agentic relevance + embedding similarity only).
- Explicit incremental/delta re-indexing on push (resumable 4-step workflow implied; diff-only delta indexing not documented).
