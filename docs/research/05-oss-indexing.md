# OSS Hunt — Code Indexing & Context Engines (2026)

**Date:** 29 May 2026
**Goal:** Find the newest + best open-source "context engine" layer for Greptile-style review (parse repo → symbols/refs/calls/imports → graph + semantic search → rank context for a diff → incremental on big monorepos), that **Sthrip** (a paid, closed-source SaaS) can legally embed and resell.
**Sthrip today:** tree-sitter repomap + GitNexus. **GitNexus is PolyForm-Noncommercial 1.0.0 → NOT usable commercially (CONFIRMED below). It MUST be replaced.**

## Commercial-safety legend
- ✅ **SAFE** — MIT / Apache-2.0 / BSD / ISC / LGPL → embeddable in a closed-source competing SaaS.
- ⚠️ **CONDITIONAL** — LGPL dynamic-link caveat, dual CE/EE, or "model-weights license ≠ code license".
- ❌ **UNSAFE** — GPL/AGPL/BSL/SSPL/Elastic/PolyForm-Noncommercial, or proprietary/source-unavailable. Cannot be resold in a closed SaaS.

---

## TL;DR — what to do for Sthrip

1. **Rip out GitNexus** (PolyForm-Noncommercial = legally cannot ship in a paid SaaS).
2. **Adopt `DeusData/codebase-memory-mcp` (MIT)** as the drop-in replacement context engine — it is a near-complete Greptile clone in one MIT static binary: 155-language tree-sitter parse → persistent KG (calls/imports/routes/dataflow) + **bundled nomic-embed-code embeddings + BM25 hybrid + 11-signal ranking**, incremental file-watcher, MCP + CLI. This is the single biggest upgrade available.
3. If you prefer to keep your own engine in-process (TS/Node), the **clean-license building blocks** are: `tree-sitter`/`web-tree-sitter` (MIT) + `sqlite-vec` (Apache/MIT) **or** `LanceDB` OSS (Apache-2.0) for vectors + `scip-typescript`/`scip-python` (Apache-2.0) for precise xref + aider-style PageRank ranking (Apache-2.0, port the algorithm). Embedding model: **voyage-code-3** (best, API/paid) or **nomic-embed-code** (Apache-2.0, self-hostable, what codebase-memory bundles).
4. **Do NOT use:** GitNexus (PolyForm-NC), CodeQL (commercial restriction), Sourcegraph core (proprietary since 2024), Morph (proprietary SaaS), GitHub stack-graphs at the production tier (see note — actively works but niche).

---

# NEW in 2026 (freshest first)

### 1. codebase-memory-mcp (DeusData) — ★ TOP NEW PICK
- **URL:** https://github.com/DeusData/codebase-memory-mcp
- **Stars / freshness:** ~2.8k; latest **v0.6.1, 4 May 2026** (very active). Backed by arXiv preprint *"Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP"* (arXiv:2603.27277).
- **License:** **MIT** → ✅ **SAFE** (commercially embeddable, including in a competing closed-source SaaS).
- **Written in:** C (87%) + C++ — ships as a **single static binary, zero runtime deps** (vendored tree-sitter grammars compiled in).
- **What/how it indexes:** Persistent knowledge graph (nodes = functions/classes/HTTP routes; edges = calls/imports/HTTP links/dataflow) **AND** semantic search via **bundled `nomic-embed-code` embeddings (768d int8)** + **BM25 full-text** + Cypher-like structural queries. Ranking uses an **11-signal combined score** (TF-IDF, RRI, API/type/decorator signatures, AST profiles, dataflow, Halstead-lite, MinHash, module proximity, graph diffusion). This is exactly the "rank relevant context for a diff" layer.
- **Incremental:** Yes — background watcher re-indexes changed files. Indexes the Linux kernel (28M LOC / 75k files) in ~3 min; "average repo in milliseconds".
- **Languages:** 155 (LSP-style hybrid type resolution for Go/C/C++/TS/JS/JSX/TSX; more coming).
- **TS/Node-friendly:** Consumed as an **MCP server (14 tools) + CLI** — language-agnostic to the host. Sthrip (Node) shells out / speaks MCP; no FFI needed.
- **Sthrip upgrade:** This is a **direct, MIT-clean replacement for GitNexus** that ADDS hybrid semantic search + dataflow + routes on top of your tree-sitter repomap. Biggest single win in this report. Claim: ~120× fewer tokens vs file-by-file (3,400 vs 412,000 tokens for 5 structural queries).

### 2. CodeGraph (colbymchenry) — best TS/Node-native fit
- **URL:** https://github.com/colbymchenry/codegraph
- **Stars / freshness:** ~33k (huge momentum); latest **v0.9.7, 28 May 2026** (yesterday) — re-validated on Opus 4.8.
- **License:** **MIT** → ✅ **SAFE**.
- **Written in:** **TypeScript / Node.js** (bundled runtime). Storage = **SQLite + FTS5** in `.codegraph/codegraph.db`.
- **What/how:** tree-sitter AST → graph of symbols (functions/classes/methods) + edges (calls/imports/extends/implements), refs resolved post-extraction, framework-pattern recognition. Structural graph + FTS5 keyword (no built-in vector embeddings — add your own).
- **Incremental:** Yes — native OS file-watch (FSEvents/inotify/RDCW), debounced auto-sync + manual `codegraph sync`.
- **Languages:** 20+ (TS, JS, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, ObjC, Swift, Kotlin, Scala, Dart, Svelte, Vue, Liquid, Pascal, Lua, Luau).
- **TS/Node-friendly:** Best-in-class — it IS a Node project; you can import internals or run the CLI/MCP in-process.
- **Sthrip upgrade:** Since Sthrip is TS/Node, this is the **lowest-integration-friction** GitNexus replacement — same language, embeddable, MIT. Pair with `sqlite-vec` + voyage-code-3/nomic-embed-code for the semantic half (CodeGraph itself is structural+FTS only).

### 3. cocoindex-code (CocoIndex) — incremental Rust engine, AST + embeddings
- **URL:** https://github.com/cocoindex-io/cocoindex-code  (engine: https://github.com/cocoindex-io/cocoindex)
- **Stars / freshness:** ~1.8k; latest **v0.2.33, 8 May 2026** (active).
- **License:** **Apache-2.0** → ✅ **SAFE**.
- **Written in:** Rust core ("ultra-performant data transformation engine") + Python frontend. Stores in `.cocoindex_code/` (embedded, no DB setup).
- **What/how:** tree-sitter AST chunking + **vector embeddings for semantic similarity** (hybrid). Tagline: "saves 70% tokens" for coding agents.
- **Incremental:** Yes — "only re-indexes changed files" (the whole CocoIndex framework is built around incremental long-horizon updates).
- **Languages:** 28+ (Python, JS, TS, Rust, Go, Java, C/C++, C#, SQL, …).
- **TS/Node-friendly:** Consumed via CLI (`ccc`) / MCP / agent-skill — language-agnostic to host. Python/Rust internals, so deeper embedding means FFI or subprocess.
- **Sthrip upgrade:** Strong if you want a **batteries-included incremental embedding pipeline** without writing the chunk→embed→store→reindex loop yourself. Apache-2.0 clean.

### 4. CodeGraphContext — multi-backend graph (Neo4j/Kuzu) for agents
- **URL:** https://github.com/CodeGraphContext/CodeGraphContext
- **Stars / freshness:** ~3.5k; latest **v0.4.7, 7 May 2026**.
- **License:** **MIT** → ✅ **SAFE**.
- **Written in:** Python (65%) + TS/JS web components.
- **What/how:** tree-sitter AST → KG of functions/classes/methods/params/inheritance/calls/imports. **Pluggable graph DB backends:** KuzuDB (default, embedded), FalkorDB Lite, Neo4j, LadybugDB, NornicDB. Structural graph (no built-in embeddings).
- **Incremental:** Yes — `codegraphcontext watch` live file-watch.
- **Languages:** 20 (Python, JS, TS, Java, C/C++, C#, Go, Rust, Ruby, PHP, Swift, Kotlin, Dart, Perl, Lua, Scala, Haskell, Elixir, TSX).
- **TS/Node-friendly:** MCP server + CLI; Python core. Multi-backend is its differentiator (use Neo4j for big monorepos, Kuzu embedded for local).
- **Sthrip upgrade:** Pick this if you want a **real graph DB** (Neo4j/Kuzu Cypher) under the hood instead of SQLite, for richer impact-analysis queries at monorepo scale.

### 5. TokenSave (aovestdipaperino) — MIT Rust, comprehensive but tiny
- **URL:** https://github.com/aovestdipaperino/tokensave
- **Stars / freshness:** ~139 (small/young); released **26 Feb 2026**.
- **License:** **MIT** → ✅ **SAFE** ("MIT-licensed Rust, auditable end to end").
- **Written in:** Rust. 40+ MCP tools, 9 agent integrations, 100% local.
- **What/how:** Pre-indexed **semantic knowledge graphs**: symbol relationships + call graphs, trace callers/callees/impact radius. 30+ languages.
- **Incremental:** Local pre-index; watch behavior less documented than the leaders.
- **TS/Node-friendly:** MCP server → host-agnostic.
- **Sthrip upgrade:** Worth tracking — MIT Rust with the right feature surface, but **too immature (139★)** to bet a paid product on today vs. #1/#2. Monitor.

> Also seen (2026, smaller): `STiFLeR7/memex` (tree-sitter + Gemini Flash → Neo4j via Graphiti, bitemporal KG — **uses a cloud LLM to build the graph**, check costs/license), `codeprysm/codeprysm` (tree-sitter + semantic search MCP), `kapillamba4/code-memory` (local vector MCP), `tirth8205/code-review-graph`. None yet at the maturity of #1–#4.

---

# Embeddings layer for code (newest 2026)

| Model | URL | License | Commercial-safe? | Notes |
|---|---|---|---|---|
| **voyage-code-3** | https://blog.voyageai.com/2024/12/04/voyage-code-3/ | Proprietary **API** (paid) | ⚠️ API ToS, not self-host | **Best code retrieval** quality (1024d, beats OpenAI v3-large +~16%, cheaper storage). Continue.dev's recommended default. Cost/data-egress matters for a SaaS. |
| **nomic-embed-code** (7B) | https://huggingface.co/nomic-ai/nomic-embed-code | **Apache-2.0** weights | ✅ SAFE, self-hostable | Fully open (weights+data+eval). **This is what codebase-memory-mcp bundles** (768d int8 quant). Best open self-host option. |
| **jina-code / Jina v5** | https://jina.ai | Mixed (open-weight tier + API) | ⚠️ verify per-model | Open-weight tier now rivals commercial APIs; check the specific model's license. |
| **Gemini Embedding 2** | Google | Proprietary API | ⚠️ API ToS | Tops MTEB-Code (~84.0) in 2026 but cloud-only. |
| **Qwen3-Embedding** | HF | Apache-2.0 (typical) | ✅ likely SAFE | Strong open alternative; verify the exact card. |

**Vector stores (all clean):**
- **sqlite-vec** — https://github.com/asg017/sqlite-vec — **Apache-2.0 + MIT dual** → ✅ SAFE. v0.1.9 (31 Mar 2026). Embeds in your existing SQLite, zero infra. **Best fit for a Node SaaS** that already uses SQLite.
- **LanceDB OSS** — https://github.com/lancedb/lancedb — **Apache-2.0** → ✅ SAFE. Embedded, scales to petabytes; 2026 added DuckDB SQL retrieval. (LanceDB Enterprise is the paid tier; OSS lib is Apache.) This is what **Continue.dev** uses for codebase indexing.
- **Qdrant** — https://github.com/qdrant/qdrant — **Apache-2.0** → ✅ SAFE. Server-grade; what Bloop used.

---

# ESTABLISHED building blocks (verified licenses)

### Parsing / structural
| Tool | URL | Stars/fresh | License | Safe? | Role |
|---|---|---|---|---|---|
| **tree-sitter / web-tree-sitter** | https://github.com/tree-sitter/tree-sitter | huge, active | **MIT** | ✅ | The foundation. `web-tree-sitter` (WASM) runs in Node. Grammars are MIT/Apache per-lang. Sthrip already uses this. |
| **ast-grep** | https://github.com/ast-grep/ast-grep | ~14k; **v0.42.3, 19 May 2026** | **MIT** (CLI, lib, py bindings) | ✅ | Structural search/lint/rewrite over tree-sitter ASTs, Rust. Has MCP server + agent-skill. Great for rule-based finding & codemods, not a graph/ranker by itself. |
| **Comby** | https://github.com/comby-tools/comby | mature | **Apache-2.0 / MIT** | ✅ | Lightweight structural search/rewrite (not AST-typed). Niche vs ast-grep. |

### Code intelligence / xref (SCIP family — the Sourcegraph-derived, still-open pieces)
| Tool | URL | License | Safe? | Role |
|---|---|---|---|---|
| **SCIP protocol** | https://github.com/sourcegraph/scip | **Apache-2.0** | ✅ | Standard index format (LSIF successor). Emitted by a growing indexer ecosystem. |
| **scip-typescript** | https://github.com/sourcegraph/scip-typescript | **Apache-2.0** | ✅ | **Precise** TS/JS xref via the TS typechecker — far more accurate than tree-sitter heuristics for "find all refs / go-to-def". **Directly upgrades Sthrip's TS repomap accuracy.** |
| **scip-python / scip-java / scip-ruby / scip-clang / scip-dotnet / scip-dart / scip-php** | (sourcegraph org) | **Apache-2.0** | ✅ | Per-language precise indexers; rust-analyzer also emits SCIP. |
| ⚠️ **Sourcegraph core** | (private repo) | **PROPRIETARY since Aug 2024** | ❌ | Core code-search server was relicensed (2023) then made private (Aug 2024). **Do not use.** Only SCIP/Zoekt/Cody stayed open. |

### Search engines
| Tool | URL | License | Safe? | Role |
|---|---|---|---|---|
| **Zoekt** | https://github.com/sourcegraph/zoekt | **Apache-2.0** (Sourcegraph now maintainer; published 28 May 2026) | ✅ | Fastest OSS trigram code search (Go), originally Google. Great as the **regex/keyword tier** of a hybrid retriever for big monorepos. |
| **Bloop** | https://github.com/BloopAI/bloop | **Apache-2.0** | ✅ | Rust semantic+regex+nav (Tantivy + Qdrant + Tauri). Active but desktop-app shaped; mine it for ideas/components rather than embed wholesale. |
| **Onyx (ex-Danswer)** | https://github.com/onyx-dot-app/onyx | **MIT (CE)** / EE proprietary | ⚠️ | Enterprise RAG search; CE is MIT but it's a doc-search platform, not a code-graph engine. Overkill for Sthrip's need. |

### Code Property Graph / dataflow (security-grade)
| Tool | URL | License | Safe? | Role |
|---|---|---|---|---|
| **Joern** | https://github.com/joernio/joern | **Apache-2.0** (verified in LICENSE: "Copyright 2020-2023 The Joern Project … Apache License, Version 2.0") | ✅ | CPG + dataflow for C/C++/Java/JS/Python/Kotlin/Binary. Heavyweight (JVM/Scala) but the gold standard for **taint/dataflow** if Sthrip wants deeper security review than calls/imports. |
| ❌ **CodeQL** | https://github.com/github/codeql | **Restricted** | ❌ | Queries are MIT/Apache, but the **CodeQL engine may only analyze OSI-licensed/open code** unless you buy GitHub Advanced Security. **Cannot be used to scan customers' closed-source code in a paid SaaS.** Avoid. |

### Repo-mapping / context-packing (ranking ideas + glue)
| Tool | URL | License | Safe? | Role |
|---|---|---|---|---|
| **aider repomap** | https://aider.chat/2023/10/22/repomap.html | **Apache-2.0** (aider) | ✅ | The canonical **tree-sitter + NetworkX PageRank** ranker — picks the most "central" symbols for a given chat/diff context. **Port this algorithm** to rank Sthrip's context for a diff. (`pdavis68/RepoMapper` is a standalone MIT clone of it.) |
| **Continue.dev indexing** | https://github.com/continuedev/continue | **Apache-2.0** | ✅ | Reference architecture: tree-sitter AST + embeddings (transformers.js local, or voyage-code-3) in **LanceDB** + SQLite metadata + repo-map provider; incremental coordination layer. Best **blueprint** to copy for a Node hybrid retriever. |
| **Repomix** | https://github.com/yamadashy/repomix | **MIT** (~22k★) | ✅ | Packs repo → one AI file; `--compress` uses tree-sitter to cut ~70% tokens; MCP server for incremental drill-down. Good for the "assemble final context blob" step. |
| **code2prompt** | https://github.com/mufeedvh/code2prompt | **MIT** | ✅ | Rust CLI, repo→prompt with templating + token counting. Glue, not an engine. |
| **gitingest** | https://github.com/cyclotruc/gitingest | MIT (typical) | ✅ | Repo→prompt-text; glue tier. |

### Name resolution at scale (note)
- **github/stack-graphs** + **tree-sitter-stack-graphs** — https://github.com/github/stack-graphs — **NOT archived**, actively released (tree-sitter-stack-graphs 0.10 line, 2026 commits). License is MIT/Apache (GitHub OSS). ✅ SAFE but **niche/low-level**: it's incremental name-resolution primitives (what powers GitHub precise code nav), not a turnkey engine. Only worth it if you need GitHub-grade cross-file resolution and are willing to write ruleset glue.

---

# DISQUALIFIED for Sthrip (commercial-unsafe or unavailable)
- ❌ **GitNexus** — PolyForm-Noncommercial 1.0.0 (verified from LICENSE: "Any noncommercial purpose is a permitted purpose"). Commercial use requires paid Enterprise license via akonlabs.com. **Must be removed from Sthrip.**
- ❌ **CodeQL** — engine license forbids closed-source-for-pay analysis without GHAS.
- ❌ **Sourcegraph core** — proprietary/private since Aug 2024.
- ❌ **Morph (morphllm)** — proprietary paid API/SaaS (Fast Apply, WarpGrep, Compaction); EULA, per-token pricing. Not embeddable OSS. (WarpGrep is interesting as a *no-index* agentic search pattern to imitate, but you can't ship their code.)
- ⚠️ **Sturdy** — code-collaboration product, largely defunct/acquired; not a context engine. Skip.

---

# RANKED TOP 5 (for Sthrip's GitNexus replacement)

## NEW (2026) — adopt from here
1. **codebase-memory-mcp (MIT)** — most complete OSS Greptile clone: 155-lang tree-sitter KG + nomic-embed-code semantic + BM25 + 11-signal ranking + dataflow/routes, incremental, single static binary, MCP/CLI. **Direct GitNexus replacement, commercially clean.** → https://github.com/DeusData/codebase-memory-mcp
2. **CodeGraph — colbymchenry (MIT)** — TypeScript/Node-native (matches Sthrip), 33k★, SQLite+FTS5, tree-sitter graph + incremental watch. **Lowest integration friction**; add `sqlite-vec` + an embedding model for the semantic half. → https://github.com/colbymchenry/codegraph
3. **cocoindex-code (Apache-2.0)** — Rust incremental AST+embedding pipeline, batteries-included re-index loop. → https://github.com/cocoindex-io/cocoindex-code
4. **CodeGraphContext (MIT)** — same idea with real graph-DB backends (Neo4j/Kuzu) for monorepo-scale Cypher impact queries. → https://github.com/CodeGraphContext/CodeGraphContext
5. **TokenSave (MIT, Rust)** — promising MIT engine, but only ~139★ — monitor, don't bet yet. → https://github.com/aovestdipaperino/tokensave

## ESTABLISHED — build/upgrade with these clean primitives
1. **tree-sitter / web-tree-sitter (MIT)** — keep as the parse foundation. → https://github.com/tree-sitter/tree-sitter
2. **scip-typescript + SCIP family (Apache-2.0)** — swap heuristic refs for **precise** TS/JS go-to-def/find-refs; biggest accuracy win on your existing repomap. → https://github.com/sourcegraph/scip-typescript
3. **aider repomap PageRank (Apache-2.0)** — port the symbol-graph PageRank ranker to "rank context for a diff." → https://aider.chat/2023/10/22/repomap.html  /  https://github.com/pdavis68/RepoMapper (MIT clone)
4. **sqlite-vec (Apache/MIT)** + **nomic-embed-code (Apache-2.0)** — the clean self-hostable semantic-search half, drop-in to SQLite. → https://github.com/asg017/sqlite-vec
5. **Zoekt (Apache-2.0)** — fast trigram tier for big-monorepo keyword/regex retrieval in a hybrid retriever. → https://github.com/sourcegraph/zoekt

---

# How Sthrip's existing tree-sitter repomap gets upgraded (concrete)
- **Fastest path:** replace GitNexus with **codebase-memory-mcp** (MIT) → instantly gain hybrid semantic+structural retrieval, dataflow, HTTP routes, cross-service links, incremental watch — all commercially clean, no Node FFI (MCP/CLI).
- **Stay in-process (Node-native):** adopt **colbymchenry/codegraph** (TS, MIT) for the graph + FTS, then bolt on **sqlite-vec + nomic-embed-code (or voyage-code-3 via API)** for semantics, and **port aider's PageRank** ranker to score which symbols/files to feed the reviewer for a given diff.
- **Accuracy boost on TS refs:** add **scip-typescript** (Apache-2.0) to replace tree-sitter's heuristic reference resolution with typechecker-precise xref — directly improves "what calls this / blast radius" quality that GitNexus was providing.
- **Security depth (optional):** add **Joern** (Apache-2.0) for real taint/dataflow if Sthrip wants to exceed calls/imports-level review.

## Sources
- https://github.com/DeusData/codebase-memory-mcp · arXiv:2603.27277
- https://github.com/colbymchenry/codegraph
- https://github.com/cocoindex-io/cocoindex-code · https://github.com/cocoindex-io/cocoindex
- https://github.com/CodeGraphContext/CodeGraphContext
- https://github.com/aovestdipaperino/tokensave
- https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE (PolyForm-NC, verified)
- https://github.com/sourcegraph/scip · https://github.com/sourcegraph/scip-typescript
- https://github.com/sourcegraph/zoekt · https://sourcegraph.com/blog/sourcegraph-accepting-zoekt-maintainership
- https://github.com/BloopAI/bloop · https://github.com/onyx-dot-app/onyx
- https://github.com/joernio/joern/blob/master/LICENSE (Apache-2.0, verified) · https://github.com/github/codeql (restricted)
- https://aider.chat/2023/10/22/repomap.html · https://github.com/pdavis68/RepoMapper · https://deepwiki.com/continuedev/continue/3.4-codebase-indexing
- https://github.com/yamadashy/repomix · https://github.com/mufeedvh/code2prompt
- https://github.com/ast-grep/ast-grep · https://github.com/github/stack-graphs
- https://github.com/asg017/sqlite-vec · https://github.com/lancedb/lancedb · https://github.com/qdrant/qdrant
- https://huggingface.co/nomic-ai/nomic-embed-code · https://blog.voyageai.com/2024/12/04/voyage-code-3/
- https://devclass.com/2024/08/21/sourcegraph-makes-core-repository-private-... (Sourcegraph went proprietary)
