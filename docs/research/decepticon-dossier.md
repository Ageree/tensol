# Decepticon Research Dossier

> **Purpose:** Enable Tensol architects to make integration decisions in 15 minutes.
> **Date:** 2026-05-09. **Author:** generator-decepticon (workstream A).

---

## TL;DR

- **What Decepticon is:** An open-source autonomous red-team agent (Apache-2.0) built on LangGraph Platform. It orchestrates 16 specialist AI sub-agents across the full attack kill chain — reconnaissance through post-exploitation and reporting — running every tool inside an isolated Kali Linux Docker sandbox with a Sliver C2 server and Neo4j attack graph.

- **Adopt-as-is vs fork:** Adopting as-is (Docker pull only) is the correct first move. Decepticon ships as pre-built images (`ghcr.io/purpleailab/decepticon-langgraph`, `-sandbox`, `-litellm`, `-web`). Tensol already has a working `RealDecepticonAdapter` that speaks directly to Decepticon's LangGraph endpoint at `localhost:2024`. The only missing layer for VPS-spawn flow is the *outer* lifecycle (create Hetzner droplet → cloud-init pulls image → droplet calls back). No fork needed until Tensol needs to modify agent behaviour.

- **Single biggest risk:** Decepticon depends on a live Docker socket inside its `langgraph` container (`/var/run/docker.sock`) to reach the `decepticon-sandbox` container. On a Hetzner cloud-init VPS, that socket is present by default — but if Hetzner ever changes image permissions or the user uses a rootless Docker runtime, the agent loses its tool-execution path silently. Mitigation: pin a tested image tag, validate `/var/run/docker.sock` in cloud-init health-check before starting.

---

## Repo Overview

| Field | Value |
|---|---|
| URL | https://github.com/PurpleAILAB/Decepticon |
| License | Apache-2.0 |
| Latest tag | `v1.0.24` |
| Last commit | `c95a534` — 2026-05-09T10:42Z — "Refactor middleware tools and harden OPPLAN persistence (#184)" |
| Stars | 3,575 |
| Forks | 696 |
| Watchers | 3,575 |
| Open issues | 4 |
| Homepage | https://decepticon.red |
| Primary language | Python (1.36 MB), TypeScript (470 KB web UI), Go (98 KB launcher) |

**Maintainer cadence:** The repo received 1 commit within the last 30 days measured from today (2026-05-09), but the last push was *today* (10:42 UTC) and the project has been under continuous active development. PR #184 shows structural refactoring, not just bugfixes — the team is still investing in the codebase. The `dependabot.yml` and `codeql.yml` CI files indicate serious engineering hygiene for an open-source security tool.

**Install:** `curl -fsSL https://decepticon.red/install | bash` → `decepticon onboard` (interactive — selects LLM provider, API key, model profile) → `decepticon` (starts all containers + web UI at localhost:3000). The Go launcher (`clients/launcher/main.go`) orchestrates `docker compose up --wait`, polling the LangGraph healthcheck at `http://localhost:2024/ok`.

**Issue health:** 4 open issues is exceptionally clean for a project of this scope. Indicates active triage and either prompt resolution or deliberate backlog management.

---

## Architecture

### Service topology (from `docker-compose.yaml`)

Decepticon runs as six Docker Compose services across two isolated networks:

| Service | Container | Port | Network | Memory |
|---|---|---|---|---|
| `litellm` | `decepticon-litellm` | 4000 | `decepticon-net` | unset (gateway) |
| `postgres` | `decepticon-postgres` | 5432 | `decepticon-net` | — |
| `neo4j` | `decepticon-neo4j` | 7474/7687 | **both** nets | 128m heap + 128m page |
| `sandbox` | `decepticon-sandbox` | — | `sandbox-net` only | **4 GB / 2 CPU** |
| `langgraph` | `decepticon-langgraph` | 2024 | `decepticon-net` | — |
| `web` | `decepticon-web` | 3000/3003 | `decepticon-net` | — |
| `cli` | `decepticon-cli` | — | `decepticon-net` | profile=cli |
| `c2-sliver` | `decepticon-c2-sliver` | — | `sandbox-net` | **2 GB / 1 CPU** |

**Critical isolation invariant:** `decepticon-sandbox` is on `sandbox-net` only. The LangGraph agent reaches it exclusively via the Docker socket (`/var/run/docker.sock:ro`) — never via the network. This means network-level exfiltration from the sandbox is impossible by design; the agent controls the sandbox through `docker exec`, not HTTP.

### The 16 agents (from `langgraph.json` + `decepticon/llm/models.py`)

| Agent | LiteLLM tier (eco profile) | Role |
|---|---|---|
| `decepticon` | HIGH | Master orchestrator — routes sub-tasks, maintains engagement state, enforces RoE |
| `soundwave` | LOW | Planning interview — elicits RoE, ConOps, OPPLAN from operator before any action |
| `recon` | LOW | External reconnaissance — passive OSINT, subdomain enumeration, asset discovery |
| `scanner` | LOW | Active network scanning — nmap, nuclei, ffuf; feeds Neo4j attack graph |
| `exploit` | HIGH | Primary exploitation — selects and crafts payloads, calls bash/metasploit |
| `exploiter` | HIGH | Secondary exploit loop — iterates on failed exploits, adjusts payloads |
| `detector` | MID | Vulnerability detection — runs heuristic source-sink analysis via `scanner_tools.py` |
| `verifier` | MID | Confirms exploitability — validates that a found vuln is a true positive |
| `patcher` | HIGH | Generates patches for confirmed findings (Defensive Vaccine loop) |
| `postexploit` | MID | Post-exploitation — lateral movement, privilege escalation, data exfiltration |
| `ad_operator` | MID | Active Directory attacks — BloodHound, Kerberos, DCSync, ADCS |
| `cloud_hunter` | MID | Cloud-specific attacks — AWS metadata, Kubernetes escape, Terraform state |
| `reverser` | MID | Binary reversing — ROP chains, packer analysis, string extraction |
| `contract_auditor` | HIGH | Smart contract auditing — Slither, Foundry, pattern matching |
| `analyst` | HIGH | Generates final report — MITRE ATT&CK mapping, executive summary |
| `vulnresearch` | HIGH | Deep vulnerability research — CVE PoC indexing, bounty analysis, chain building |

### CLI tools invoked by agents (from `decepticon/tools/`)

The bash tool (`decepticon/tools/bash/bash.py`) is a thin wrapper around `DockerSandbox.execute_tmux()`. All tool invocations run inside the `decepticon-sandbox` Kali container. Tool categories extracted from `decepticon/tools/`:

- **Web:** HTTP manipulation (`http.py`), GraphQL probing (`graphql.py`), JWT attacks (`jwt.py`), OAuth flows (`oauth.py`), session analysis (`session.py`)
- **Active Directory:** BloodHound (`bloodhound.py`), DCSync (`dcsync.py`), Kerberos (`kerberos.py`), ADCS (`adcs.py`)
- **Cloud:** AWS metadata (`aws.py`), Kubernetes escape (`k8s.py`), cloud metadata endpoints (`metadata.py`), Terraform state (`terraform.py`)
- **Reversing:** ROP chains (`rop.py`), packer detection (`packer.py`), symbol extraction (`symbols.py`), binary analysis (`binary.py`)
- **Smart contracts:** Slither (`slither.py`), Foundry (`foundry.py`), vulnerability patterns (`patterns.py`)
- **Scanning:** nmap, nuclei, ffuf, subfinder, metasploit — referenced in `scanner_tools.py` and `bash/bash.py`
- **Reporting:** HackerOne (`hackerone.py`), Bugcrowd (`bugcrowd.py`), executive summary (`executive.py`), timeline (`timeline.py`)
- **References:** CVE PoC index (`cve_poc_index.py`), HackerOne H1 corpus (`h1_corpus.py`), kill chain YAML (`killchain.yaml`), payloads (`payloads.py`)

### Runtime model

- **Language:** Python 3.13 (per `langgraph.json` `python_version`)
- **Agent framework:** LangGraph Platform (self-hosted, not LangSmith Cloud)
- **LLM routing:** LiteLLM proxy at `:4000` — supports 30+ providers including Anthropic, OpenAI, DeepSeek, Gemini, xAI, Mistral, Ollama, Groq, Together, Fireworks, Cohere, Moonshot, Z.ai, DashScope, GitHub Models, Bedrock, Vertex, Azure
- **Tool execution:** Docker socket exec into `decepticon-sandbox` (Kali Linux)
- **C2:** Sliver (`c2-sliver` profile on `sandbox-net`) — pre-installed `sliver-client` in sandbox
- **No GPU required:** All inference is remote via LiteLLM proxy

### State model

- **LangGraph checkpoints:** Postgres (`decepticon-postgres`, `litellm` DB) — stores LangGraph thread state, run metadata, agent message history
- **Attack graph:** Neo4j 5.24 (`decepticon-neo4j`, `:7687`) — Cypher queries for attack chains; `decepticon-langgraph` writes nodes, `decepticon-sandbox` reads via `bolt://neo4j:7687`. The scanner agent writes `CODE_LOCATION` / `CANDIDATE` nodes; the analyst agent queries the full graph for report generation.
- **Engagement workspace:** `~/.decepticon/workspace/<slug>/` — bind-mounted into sandbox at `/workspace`; `.scratch/` sub-directory for large tool outputs (auto-pruned at 60-minute TTL)

---

## Integration Surface — Three Concrete Options

### Option A: CLI invocation (spawn `decepticon` subprocess)

The decepticon CLI starts the full Docker Compose stack. From a VPS cloud-init script, we can invoke it after cloud-init installs Docker and pulls the images.

```bash
# cloud-init runcmd excerpt
- docker compose -f /opt/decepticon/docker-compose.yaml up -d --wait
- |
  curl -s -X POST http://localhost:2024/threads \
    -H "Content-Type: application/json" \
    -d '{"metadata":{"cyberstrike_assessment_id":"'"$SCAN_ID"'"}}'
  # → returns {"thread_id": "..."}
```

Bun pseudocode from `services/scan-runner/src/cloud-init.ts` (planned Sprint 2):

```typescript
// buildCloudInit generates a cloud-init YAML that, on the VPS:
// 1. Installs docker.io + curl + jq
// 2. Runs: docker compose pull && docker compose up -d --wait
// 3. POSTs OPPLAN to localhost:2024/threads, then streams from /runs
// 4. On completion: POSTs logs to callbackUrl
// 5. shutdown -h now
```

**Relevant spec reference:** `packages/decepticon-adapter/src/real.ts:225-285` already implements the LangGraph SDK call that this cloud-init script would invoke locally on the VPS.

### Option B: LangGraph SDK over HTTP (what `RealDecepticonAdapter` currently does)

This is the path already implemented in Sprint 12 at `packages/decepticon-adapter/src/real.ts`. The `@langchain/langgraph-sdk` `Client` talks to `DECEPTICON_API_URL` (default `http://localhost:2024`). For VPS-spawn flow, that URL becomes `http://<vps-ipv4>:2024`.

```typescript
// From packages/decepticon-adapter/src/real.ts:225-285 (Sprint 12, commit b908b87)
const thread = await this.client.threads.create({
  metadata: {
    cyberstrike_assessment_id: input.opplan.assessmentId,
    cyberstrike_tenant_id: input.tenantId,
  },
});

const stream = this.client.runs.stream(thread.thread_id, 'decepticon', {
  input: {
    messages: [{
      type: 'human',
      content: `OPPLAN\n\n${JSON.stringify(input.opplan, null, 2)}`,
    }],
  },
  streamMode: ['values', 'custom'],
  signal: abortController.signal,
});

for await (const chunk of stream) {
  if (chunk.event === 'custom') { /* dispatch to status/candidate queues */ }
}
```

For the VPS flow, `RealDecepticonAdapter` simply needs a different `apiUrl` — `http://<hetzner-vps-ipv4>:2024` instead of `localhost:2024`. The `HetznerClient.getServer(id)` call in Sprint 2's `scan-runner.ts` will populate that IPv4.

### Option C: Docker container exec

```bash
docker run --rm \
  -e LITELLM_MASTER_KEY=sk-decepticon-master \
  -e DECEPTICON_LLM__PROXY_URL=http://host.docker.internal:4000 \
  --user-agent "Tensol-Scan/${SCAN_ID}" \
  ghcr.io/purpleailab/decepticon-langgraph:v1.0.24 \
  python -m decepticon.cli run --target "${TARGET_URL}"
```

This bypasses the full docker-compose stack and runs only the `langgraph` image. It requires a separately running LiteLLM proxy — which in a cloud-init scenario means either bundling both, or pointing at a remote LiteLLM URL.

### Pros / Cons Table

| Dimension | A (CLI / compose) | B (LangGraph SDK over HTTP) | C (Docker single-image exec) |
|---|---|---|---|
| **Cold-start latency** | 60-180s (docker pull + compose up + healthchecks) | 0 (assumes stack already running) | 30-90s (single image pull) |
| **Observability** | Low (subprocess stdout) | High (streaming SSE chunks, custom events per agent) | Low (stdout only) |
| **Error surface** | Large (compose-level failures, port binding, healthcheck timeout) | Narrow (HTTP 4xx/5xx, stream error events) | Medium (docker exit code + stderr) |
| **Fail-fast vs streaming** | Slow fail (compose starts all services) | Streaming + immediate error events | Fast fail on non-zero exit |
| **Ease of mocking in CI** | Hard (needs docker-compose in CI) | Easy (inject `clientFactory` mock — already done in `real.test.ts`) | Medium (needs docker in CI) |
| **Recommended for MVP** | No | **Yes** | No |

**Recommendation:** Option B for Sprint 2 and production MVP. The `RealDecepticonAdapter` already implements it correctly. The VPS-spawn layer only needs to supply the correct `apiUrl` after the droplet's LangGraph healthcheck passes.

---

## Resource Needs

Per scan, based on `docker-compose.yaml` resource declarations and mempalace Sprint 12 install diary (wing=`cyberstrike-hybrid`, source: `user-feedback-stack-too-heavy-lighten-next-time.md`, 2026-04-29):

| Resource | Value | Source |
|---|---|---|
| **RAM (full stack)** | 6-12 GB | mempalace: "~8-12GB RAM when full demo running" |
| **RAM (minimal: no web, no CLI)** | 4-6 GB | compose: neo4j 640m + sandbox 4g + langgraph ~1g + litellm ~500m + postgres ~400m |
| **CPU** | 2-4 cores typical, 6-10 at peak | mempalace diary; sandbox `cpus: 2.0` hard limit |
| **Disk (images)** | 15-20 GB | mempalace: "~15-20GB disk for images" |
| **Disk (workspace per engagement)** | 50-500 MB | scratch files auto-pruned at 60min TTL |
| **Network egress per scan** | 100MB-2GB | nmap, nuclei, metasploit payloads — highly target-dependent |
| **Scan duration** | 10-90 min | Dependent on target complexity and LLM latency |

**Per-container limits (from `docker-compose.yaml`):**
- `sandbox`: `mem_limit: 4g`, `cpus: 2.0`, `pids_limit: 1024`
- `c2-sliver`: `mem_limit: 2g`, `cpus: 1.0`, `pids_limit: 512`
- `neo4j`: `NEO4J_server_memory_heap_max__size: 384m`, `NEO4J_server_memory_pagecache_size: 128m`

**Hetzner instance sizing:** CPX21 (3 vCPU, 4 GB RAM) is marginal — the sandbox alone needs 4 GB. **CPX31 (4 vCPU, 8 GB RAM, €13.40/month = ~$0.019/hr) is the realistic minimum for production scans.** CPX21 can work for short/light scans if C2 Sliver profile is disabled.

---

## Cost Estimation

### LLM tokens per scan

Decepticon's eco profile (default) routes by agent tier. For a typical web application scan (recon → scanner → detector → exploit → verify → analyst), the active agents are:

| Agent | Tier | Model (Anthropic path) | Approx tokens/agent |
|---|---|---|---|
| `decepticon` | HIGH | claude-opus-4-7 | 50k-200k |
| `soundwave` | LOW | claude-haiku-4-5 | 5k-20k |
| `recon` | LOW | claude-haiku-4-5 | 10k-40k |
| `scanner` | LOW | claude-haiku-4-5 | 20k-80k |
| `detector` | MID | claude-sonnet-4-6 | 30k-100k |
| `exploit` | HIGH | claude-opus-4-7 | 50k-200k |
| `verifier` | MID | claude-sonnet-4-6 | 20k-60k |
| `analyst` | HIGH | claude-opus-4-7 | 40k-150k |

**Estimate (Anthropic eco, mid-complexity web scan):**
- Haiku (LOW agents): ~200k tokens × $0.25/M input + $1.25/M output ≈ $0.20
- Sonnet (MID agents): ~200k tokens × $3/M input + $15/M output ≈ $1.80
- Opus (HIGH agents): ~500k tokens × $15/M input + $75/M output ≈ ~$30

**Total LLM cost (Anthropic eco): ~$30-40 per scan.** This is consistent with the user's stated acceptance in project memory (`project_cyberstrike_hybrid.md`: "premium pricing absorbs $30 LLM cost per scan comfortably").

**With DeepSeek hack (per mempalace `decepticon-deepseek-hack-mapping-runbook.md`):** All agents mapped to `deepseek/deepseek-v4-pro` — $0.27/M input + $1.10/M output. At 900k total tokens: ~$0.50/scan. ~60x cost reduction, acceptable for PoC demos.

### Infrastructure cost

Hetzner CPX31 (production minimum):
- Hourly rate: ~$0.019/hr
- 45-minute scan (median): 0.75 hr × $0.019 = **~$0.014**
- Snapshot storage (pre-baked Docker image): 20 GB × $0.0119/GB/month ≈ $0.001/scan at daily frequency

**Total infra cost per scan: ~$0.01-0.02.** This is negligible relative to LLM cost. The $30-40 LLM cost is the dominant variable.

---

## License & Legal — Apache-2.0 Obligations

Decepticon is licensed under [Apache License 2.0](https://github.com/PurpleAILAB/Decepticon/blob/main/LICENSE). Key obligations for Tensol's SaaS use:

### What Apache-2.0 requires for SaaS integration

1. **NOTICE file:** If Decepticon ships a `NOTICE` file (the repo does not currently include one at the root — checked in `/tmp/decepticon-clone-1778324100/`), Tensol must reproduce it in derivative works that redistribute Decepticon's source. Since Tensol uses Docker images (binary form), this applies to any Docker image Tensol *builds from* Decepticon source. If using the pre-built `ghcr.io/purpleailab/decepticon-*` images without modification, the build pipeline is PurpleAILAB's responsibility.

2. **License reproduction:** Any distribution of Decepticon binaries (e.g., if Tensol bundles the Decepticon Docker image in a distribution) must include the Apache-2.0 license text.

3. **Modifications disclosure:** If Tensol modifies Decepticon source files, the modifications must be stated in changed files. The Sprint 12 DeepSeek hack (patching `decepticon/llm/models.py` inside the running container) is technically a modification — it does not need to be disclosed to end users in a SaaS context, but it would need attribution if Tensol distributes a modified image.

4. **No implied endorsement:** Tensol must NOT use the PurpleAILAB name or "Decepticon" trademark to endorse or promote Tensol's service without permission. Tensol cannot say "Powered by Decepticon by PurpleAILAB" in a way that implies PurpleAILAB endorses Tensol. "Uses Decepticon (Apache-2.0)" in a legal/credits page is acceptable.

5. **Patent grant:** Apache-2.0 includes a patent grant from contributors. This means PurpleAILAB contributors have granted Tensol a license to any patents embodied in the code for Tensol's use.

### If Tensol hard-forks Decepticon

- Tensol owns the fork and its additions are Tensol's IP
- Tensol must still preserve PurpleAILAB's copyright header in the original files
- Tensol must maintain (or create) a NOTICE file crediting PurpleAILAB
- Tensol is free to add its own proprietary layers on top
- Tensol cannot relicense the forked Apache-2.0 code under a proprietary license (but can dual-license additions)
- Upstream PRs from PurpleAILAB cannot be merged without Apache-2.0 CLA (or equivalent)

### SaaS-specific consideration

Apache-2.0 has no SaaS/network-use clause. Tensol can run Decepticon as a hosted service without triggering source disclosure obligations (unlike AGPL-licensed software). This is one of the reasons Apache-2.0 was chosen by PurpleAILAB — it explicitly enables commercial SaaS wrapping.

---

## Existing Tensol Integration Audit

### File inventory (`packages/decepticon-adapter/src/`)

**`types.ts`** — Public types for the adapter interface. Defines `opplanSchema` (Zod), `SESSION_STATUSES`, `CANDIDATE_TYPES`, `SEVERITIES`, `SessionHandle`, `Artifact`, `StartSessionInput`, and the `DecepticonAdapter` interface. The `DecepticonAdapter` interface at lines 134-142:

```typescript
export interface DecepticonAdapter {
  start(input: StartSessionInput): Promise<SessionHandle>;
  streamStatus(sessionId: string): AsyncIterable<StatusEvent>;
  streamCandidates(sessionId: string): AsyncIterable<CandidateFinding>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  exportArtifacts(sessionId: string): Promise<readonly Artifact[]>;
}
```

**`fake.ts`** — `FakeDecepticonAdapter`. Deterministic fixture-driven in-process stand-in. Reads `<scenario>.json` from `tests/fixtures/decepticon/`. Accepts test seams: `randomUUID`, `clockIso`, `sleep`, `scenarioForAssessment`. Used in Sprint 8-12 unit tests; exercises the full coordinator + downstream pipeline without the real engine. Status: production-quality, will remain as CI fallback even after VPS-spawn is live.

**`real.ts`** — `RealDecepticonAdapter`. Shipped Sprint 12 (commit `b908b87`). Wired to `@langchain/langgraph-sdk` `Client` at `DECEPTICON_API_URL` (default `http://localhost:2024`). Creates one LangGraph thread per assessment, streams `custom` events, maps 16 agent names to `SessionStatus` via `phaseForAgent`, parses `subagent_tool_result{tool:report_finding}` events into `CandidateFinding`. Implements full `stop()` via `AbortController` + SDK `runs.cancel()`. Contains `AsyncQueue<T>` helper for backpressure-safe streaming.

**`select.ts`** — Adapter selector keyed off `DECEPTICON_ADAPTER` env var. `'fake'` (default) → `FakeDecepticonAdapter`; `'real'` → `RealDecepticonAdapter`. Unknown values throw immediately (fail-fast).

**`fixture-loader.ts`** — `FsFixtureLoader`. Reads `<scenario>.json`, validates with Zod `fixtureSchema`. Supports `simulateCrashAt` (crash injection for error-path testing) and `timeScale` (time dilation for fast tests).

### What Sprint 12 shipped and what the VPS-spawn layer adds

Sprint 12 commit `b908b87` shipped `RealDecepticonAdapter` wired to LangGraph SDK at `localhost:2024`; what's missing for VPS-spawn flow is the *outer* layer (server lifecycle — create droplet, wait for LangGraph to be healthy, reconfigure adapter URL, destroy droplet on completion), not the *inner* layer (LangGraph client). The adapter's `apiUrl` dependency injection (via `RealDecepticonAdapterDeps.apiUrl`) means the VPS IPv4 can be injected at construction time without modifying the adapter at all.

The Sprint 2 `services/scan-runner/` package implements exactly this outer layer.

---

## Open Questions for Human Decision

The following five decisions must be made before productionising the VPS-spawn flow. Each has a recommendation from the generator.

1. **Embedding strategy** — How should Tensol carry the Decepticon dependency?
   - Option A: Fork-and-vendor (`external/decepticon/` in repo, gitignored)
   - Option B: Git submodule
   - Option C: `npx`/npm mirror (impractical for Python)
   - **Option D: Docker pull only** ← recommended
   - *Rationale:* The only thing our VPS needs at runtime is the pre-built image. Vendoring Python source creates upstream-merge churn and bloats the repo. The Sprint 12 adapter already abstracts everything behind a clean `DecepticonClient` interface. Docker pull only keeps our repo free of Python.

2. **Version pin policy** — How to manage image version updates?
   - Option A: Always `latest` (risky — silent breaking changes)
   - Option B: Pin to a specific tag (e.g. `v1.0.24`) and bump manually
   - **Option B recommended** ← with a twist: CVE-flagged dependencies auto-merge via Renovate; feature/API changes gated by a smoke test against the real adapter
   - *Rationale:* Decepticon's LangGraph streaming API (`subagent_*` custom events) is not versioned. A `latest` pull could break `real.ts`'s event dispatch silently. Pin + smoke test is the safe default.

3. **Where scan-state lives** — Decepticon has its own Postgres (LangGraph threads + litellm spend); Tensol has `decepticon_sessions` table.
   - Option A: Only Decepticon's Postgres (ephemeral, dies with VPS)
   - Option B: Only our `decepticon_sessions` table (requires polling Decepticon's API)
   - **Option C: Both, ours authoritative** ← recommended
   - *Rationale:* Decepticon's Postgres is ephemeral — it dies when the VPS is destroyed. Before destroy, the scan-runner must copy `langgraph_thread_id`, OPPLAN snapshot, and final transcript to our `decepticon_sessions` table. Our table becomes the durable record; Decepticon's Postgres is the operational scratchpad.

4. **LLM provider** — Which provider(s) to use for Decepticon's agents?
   - Option A: DeepSeek-only (~$0.50/scan, well-documented `models.py` patch)
   - Option B: Anthropic Opus + DeepSeek tier mix (eco profile — ~$30-40/scan)
   - **Option C (CHOSEN 2026-05-12): GPT-5.5 as primary** — single provider via OpenAI API. ~$300–800/scan at 50k actions. Drops the DeepSeek hack entirely.
   - Option D: OpenRouter unified (flexibility, one API key) — deferred.
   - *Rationale (Option C):* XBOW's Mythos-like evaluation (Q1 2026) put GPT-5.5 in XBOW-zone for autonomous pentest reasoning — DeepSeek doesn't reach that bar even with aggressive prompting. Tensol's $1.5k–$3.5k pricing tiers absorb the cost: Premium ($3.5k) sees ~80% gross margin even at $500 LLM + $50 VPS per scan. RU-compliance angle (OpenAI processes data in US) is **explicitly deprioritised** until the first compliance-sensitive customer — at that point we'd add a regional model option (YandexGPT / hybrid) rather than fall back to DeepSeek.
   - *Operational change (2026-05-12 — OpenRouter chosen as gateway):*
     ```yaml
     OPENROUTER_API_KEY=sk-or-v1-...
     DECEPTICON_LLM_PROVIDER=openrouter
     DECEPTICON_MODEL=openai/gpt-5.5
     DECEPTICON_REASONING_EFFORT=xhigh
     ```
     Routing through OpenRouter (not OpenAI direct) because: (a) wider startup rate limits, (b) one key works for future model A/B (Claude, Gemini), (c) prepaid balance = predictable spend ceiling. Markup ~5% over OpenAI direct rates accepted as cost of flexibility. `reasoning_effort=xhigh` applied globally per user directive — ~4-10× more reasoning tokens vs medium. Plus tier margin compresses to 0-45%, Premium 14-41% — accepted. Zero Tensol code changes — provider + effort both opaque to `RealDecepticonAdapter`. OpenAI Startups credits programme remains a future fallback ($1k-25k) but requires re-routing to OpenAI direct at that point.
   - *Future revisit:* hybrid (DS for recon/reporting + GPT-5.5 for exploit reasoning) becomes attractive once we see real per-scan token distributions. Recorded as EE-4 candidate.

5. **Cold-start UX** — How to handle the 30-60s VPS boot time?
   - Option A: Accept the wait visibly (progress spinner: "Provisioning scan environment...")
   - Option B: Warm-pool of 1-2 pre-spawned droplets (reduces cold start to ~5s)
   - Option C: Hybrid (warm-pool on Pro+ plans, cold-start on Free)
   - **Option A recommended for MVP** ← warm-pool is Phase 1.5 polish
   - *Rationale:* Warm-pool adds operational complexity (cron to keep droplets healthy, cost even when no scans run). The 30-60s wait is a one-time UX friction that users understand as "infrastructure is being provisioned." Explicitly communicating this (progress bar with phase labels) makes it acceptable.

---

## Risks

1. **License-change risk.** Decepticon is Apache-2.0 today. PurpleAILAB could re-license future versions (e.g., to a commercial source-available license like BSL or SSPL). Mitigation: pin to a specific tag; evaluate each version bump for license changes; consider forking at the current Apache-2.0 commit as a fallback if re-licensing happens.

2. **Upstream archival / abandonment risk.** The project has 3,575 stars and was actively committed today (2026-05-09). However, open-source security tooling projects can be abandoned without notice (e.g., if PurpleAILAB pivots to a commercial model). Mitigation: maintain a local Docker registry mirror of pinned images; the adapter interface is thin enough to swap the backend.

3. **Breaking changes in LangGraph streaming schema.** Decepticon's `subagent_*` custom event format (`subagent_start`, `subagent_tool_result{tool:report_finding}`, etc.) is not part of a versioned API contract. An upstream change to this schema would silently break `RealDecepticonAdapter.handleCustomEvent()` and `tryParseFinding()`. Mitigation: pin image tag; add a `real.test.ts` smoke test that validates the event shape against a recorded fixture before each version bump.

4. **PurpleAILAB project abandonment.** Low probability given today's activity, but non-zero. Tensol's moat is the validator + scope + compliance + SaaS layer, not Decepticon itself (per `project_tensol_runtime_architecture.md`). If Decepticon is abandoned, Tensol can integrate a different agent backend (XBOW API, custom LangGraph graph) behind the same `DecepticonAdapter` interface.

5. **Sliver C2 export control.** Sliver is a post-exploitation C2 framework co-developed by Bishop Fox and used in real red team engagements. Some jurisdictions may classify tools for unauthorized computer access as dual-use export-controlled technology. The `c2-sliver` profile is opt-in (COMPOSE_PROFILES in `.env`). Tensol should not enable C2 without explicit authorization-of-target proof (already mandatory at MVP per `project_tensol_egress_isolation_decision_2026-05-09.md`). Specific concern: RU/CIS clients may face additional import licensing requirements for cryptographic tools.

6. **Default API key names in env.example.** The Go launcher's `clients/launcher/internal/config/env.example` ships with `LITELLM_MASTER_KEY=sk-decepticon-master` and `LITELLM_SALT_KEY=sk-decepticon-salt-change-me` as hardcoded defaults. These propagate into `docker-compose.yaml` as environment defaults. If a VPS operator does not rotate these before deployment, the LiteLLM proxy is accessible with a known key from any container on `decepticon-net`. Mitigation: cloud-init MUST inject rotated `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` via env before starting compose.

7. **Kali sandbox cost per scan.** The sandbox container (`mem_limit: 4g`) is the largest resource consumer. At CPX31 pricing (~$0.019/hr), the infra cost per scan is $0.01-0.02 — acceptable today. At scale (1000 concurrent scans), this becomes $10-20/scan-hour in infra. Mitigation: implement warm-pool + sandbox reuse for high-volume clients (Phase 2 optimisation).

---

## Citations

- Decepticon repo metadata (stars, forks, last push, license) — `gh api repos/PurpleAILAB/Decepticon` (fetched 2026-05-09)
- Decepticon latest tag `v1.0.24` and last commit `c95a534` — https://github.com/PurpleAILAB/Decepticon/commits/main
- Decepticon `docker-compose.yaml` (sandbox mem_limit, neo4j memory, service topology) — https://github.com/PurpleAILAB/Decepticon/blob/main/docker-compose.yaml
- Decepticon `langgraph.json` (16 agents, graph entry points, python_version:3.13) — https://github.com/PurpleAILAB/Decepticon/blob/main/langgraph.json
- Decepticon `decepticon/llm/models.py` (AGENT_TIERS, METHOD_MODELS, MODEL_PROFILE enum, temperature per agent) — https://github.com/PurpleAILAB/Decepticon/blob/main/decepticon/llm/models.py
- Decepticon tool registry (`decepticon/tools/` directory structure, bash.py, scanner_tools.py, ad/, cloud/, reversing/) — `/tmp/decepticon-clone-1778324100/decepticon/tools/` (cloned 2026-05-09)
- Decepticon `decepticon/tools/bash/bash.py` (INLINE_LIMIT, DockerSandbox wrapper, output management) — https://github.com/PurpleAILAB/Decepticon/blob/main/decepticon/tools/bash/bash.py
- Decepticon `clients/launcher/internal/config/env.example` (hardcoded `sk-decepticon-master` default key) — https://github.com/PurpleAILAB/Decepticon/blob/main/clients/launcher/internal/config/env.example
- Decepticon Apache-2.0 LICENSE — https://github.com/PurpleAILAB/Decepticon/blob/main/LICENSE
- Decepticon `decepticon/core/subagent_streaming.py` (custom event schema: `subagent_start`, `subagent_tool_result`, etc.) — https://github.com/PurpleAILAB/Decepticon/blob/main/decepticon/core/subagent_streaming.py
- Decepticon PR #184 (latest merge, structural refactor) — https://github.com/PurpleAILAB/Decepticon/pull/184
- Decepticon `containers/c2-sliver.Dockerfile` (c2-sliver profile, sandbox-net isolation) — https://github.com/PurpleAILAB/Decepticon/blob/main/containers/c2-sliver.Dockerfile
- Sprint 12 real adapter implementation — `packages/decepticon-adapter/src/real.ts` (commit `b908b87`, shipped 2026-04-29)
- Sprint 12 install diary: Docker stack footprint (8-12 GB RAM, 6-10 CPU, 15-20 GB images) — mempalace://wing/cyberstrike-hybrid/decisions/user-feedback-stack-too-heavy-lighten-next-time.md
- Sprint 12 DeepSeek hack mapping (~$0.50/scan, `models.py` patch, one-liner reapply script) — mempalace://wing/cyberstrike-hybrid/configuration/decepticon-deepseek-hack-mapping-runbook.md
- Decepticon repo investigation 2026-04-29 (architecture map, OPPLAN format origin, 16 agents, docker networks) — mempalace://wing/cyberstrike-hybrid/decisions/decepticon-repo-investigation-2026-04-29.md
- Tensol egress isolation decision (Strategy A → C, User-Agent mandatory, no rotating pool) — `/Users/saveliy/.claude/projects/-Users-saveliy-Documents-----------/memory/project_tensol_egress_isolation_decision_2026-05-09.md`
- `packages/decepticon-adapter/src/types.ts:134-142` (DecepticonAdapter interface verbatim) — `/Users/saveliy/Documents/пентест ИИ/packages/decepticon-adapter/src/types.ts`
- `packages/queue/src/types.ts` (ENVELOPE_KINDS, QueueAdapter interface) — `/Users/saveliy/Documents/пентест ИИ/packages/queue/src/types.ts`
