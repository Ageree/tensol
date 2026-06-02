# OSS Hunt — SAST / Reachability Engines (2026)

**Research date:** 29 May 2026 · **For:** Sthrip (commercial closed-source SaaS, AI code review competing in code-review/security space)
**Verdict lens:** "COMMERCIAL-SAFE" = can a *paid SaaS that competes in code review/security* legally orchestrate this binary (and/or its rules) without copyleft contamination of Sthrip's own source or a no-compete/no-SaaS clause.

> **Headline correction to prior findings (important):** The Opengrep *engine* is clean (LGPL-2.1), but **the `opengrep/opengrep-rules` repo is LGPL-2.1 + Commons Clause** (verified from its raw `LICENSE` file) — Commons Clause forbids "selling" a product/service whose value substantially derives from it. So you get the engine free, but you must **NOT** ship Opengrep's own bundled rules in Sthrip. Use **Aikido's MIT-licensed `AikidoSec/opengrep-rules`** and/or rules you author. This is the single most-overlooked licensing trap in the stack.

---

## 1. License safety model (read this first)

| License | Can a competing paid SaaS orchestrate the **CLI** (separate process, no linking)? | Can it ship the **rules/content**? | Notes |
|---|---|---|---|
| **Apache-2.0 / MIT** | YES | YES | Cleanest. Trivy, Grype, OSV-Scanner, Gitleaks, ggshield, ast-grep, GuardDog, datadog-static-analyzer, Joern, Kingfisher, Betterleaks. |
| **LGPL-2.1 (CLI, run as sidecar)** | YES (no static linking; spawn as subprocess) | n/a | Opengrep & Semgrep CE *engines*. Sidecar/`Bun.spawn` avoids LGPL relink obligations entirely. |
| **AGPL-3.0** | **Sidecar-only & risky.** Network-use copyleft can reach a SaaS that *exposes the tool's functionality* over the network. Safe ONLY as an internal, unmodified, non-user-facing subprocess whose output you transform — and even then conservative counsel often says avoid for a competing product. | NO | TruffleHog, Vulnhuntr. |
| **Semgrep Rules License v1.0 (SRL-1.0)** | engine is fine; **RULES forbidden** in competing/SaaS use | **NO** | Confirmed still in force 2026 (grace period ended 31 Jan 2025). |
| **Elastic License 2.0 (ELv2)** | **NO** — explicit "may not provide the software to third parties as a hosted or managed service" clause | NO | **Bearer** is ELv2. Disqualified for a SaaS. |
| **Commons Clause (+ any base)** | **NO** — forbids "Sell": a product/service whose value substantially derives from it | NO | **opengrep-rules** carry this. |
| **Proprietary (free only on OSS code)** | NO for proprietary-code scanning in a product | NO | CodeQL engine. |

---

## 2. Established engines — 2026 re-verification (all prior findings re-checked)

### Opengrep (engine) — **SAST, recommended core**
- **URL:** https://github.com/opengrep/opengrep · site https://www.opengrep.dev/
- **Stars:** ~2.6k · **Latest:** v1.22.0 (19 May 2026); v1.21.0 (11 May 2026) added intrafile taint over LSP; v1.20.0 (21 Apr 2026) Python `match/case` support. Very active in 2026.
- **License:** **LGPL-2.1** (verified `LICENSE`). Engine is clean.
- **COMMERCIAL-SAFE?** **YES** as a sidecar (spawn the CLI; do not statically link).
- **Category:** SAST (incl. taint / cross-function analysis that Semgrep moved behind its paywall — Opengrep restored it free).
- **SARIF:** YES (`--sarif-output=`, SARIF 2.1.0). · **Languages:** 30+ (Java, JS/TS, Python, Go, C/C++, C#, Ruby, PHP, Rust, Kotlin, Swift, Scala, Terraform, etc.).
- **Backing:** Consortium (Aikido, Endor Labs, Jit, Orca, +) with full-time OCaml team — durable, not a hobby fork.
- **Orchestration:** `Bun.spawn(["opengrep","scan","--sarif-output=-","--config",<rules dir>, repoPath])`.
- **RULES CAVEAT (critical):** `opengrep/opengrep-rules` = LGPL-2.1 **+ Commons Clause** → **do NOT bundle** in Sthrip. Source rules from MIT sets / your own (see §4).

### Semgrep — what changed, and why you still avoid it
- **URL:** https://github.com/semgrep/semgrep · licensing https://semgrep.dev/legal/rules-license/
- **Engine:** still **LGPL-2.1** in 2026 (unchanged). The *engine* was never the problem.
- **Rules (`semgrep/semgrep-rules`):** **SRL-1.0** — "available only for internal, non-competing, non-SaaS contexts." Confirmed **still in force in 2026**. A competing code-review SaaS **cannot** use Semgrep-maintained rules. Engine also lost taint/cross-function from CE (you'd pay for Semgrep Pro/AppSec for those).
- **Verdict:** Use **Opengrep instead** — same rule format & SARIF, free taint, no SRL on the engine. Prior finding **CONFIRMED**.

### Trivy — **deps + IaC + secrets + SBOM, recommended**
- **URL:** https://github.com/aquasecurity/trivy · **Stars:** ~32.2k (most-starred OSS security scanner).
- **License:** **Apache-2.0** (Aqua moved it off AGPL years ago; confirmed Apache-2.0 in 2026). `trivy-checks` content also Apache-2.0.
- **COMMERCIAL-SAFE?** **YES.** · **Category:** deps (SCA/CVE), IaC misconfig (absorbed tfsec), secrets, SBOM, license scan.
- **SARIF:** YES (`-f sarif`). · Wide ecosystem/language + container/k8s/cloud coverage.
- **Orchestration:** `Bun.spawn(["trivy","fs","--format","sarif","--output","-",repoPath])`. Prior finding **CONFIRMED (Apache, safe)**.

### Grype + Syft — **deps/SBOM, recommended complement to Trivy**
- **URL:** https://github.com/anchore/grype (+ https://github.com/anchore/syft) · **Stars:** ~11.5k.
- **License:** **Apache-2.0.** · **Latest:** v0.111.1 (Apr 2026) fixed SARIF `helpURI` metadata. (Note: Grype DB schema v5 EOL 6 Mar 2026 — pin a current schema.)
- **COMMERCIAL-SAFE?** **YES.** · **Category:** deps (SBOM-driven CVE matching). · **SARIF:** YES (also JSON, CycloneDX).
- **Orchestration:** `syft <repo> -o cyclonedx-json | grype --output sarif`. Good second SCA opinion / SBOM generator.

### OSV-Scanner (v2) — **deps, recommended (the canonical OSV client)**
- **URL:** https://github.com/google/osv-scanner · **Stars:** ~6k. · **Latest:** v2.x, v2.3.5 (Mar 2026) added transitive scan for `requirements.txt` via deps.dev.
- **License:** **Apache-2.0.** · **COMMERCIAL-SAFE?** **YES.** · **Category:** deps (uses osv.dev DB). · **SARIF:** YES (`--format sarif`, SARIF 2.1.0).
- **osv.dev** data is the distributed open vuln DB (CC-BY for the data). · **Orchestration:** `Bun.spawn(["osv-scanner","--format","sarif","-r",repoPath])`.
- Best-in-class for accurate, low-noise OSS dependency CVEs across most ecosystems.

### Gitleaks — **secrets, recommended baseline**
- **URL:** https://github.com/gitleaks/gitleaks · **Stars:** ~26k.
- **License:** **MIT** (CLI). ⚠️ `gitleaks-action` ≥ v2.0.0 went proprietary — use the **CLI**, not that Action.
- **COMMERCIAL-SAFE?** **YES (CLI).** · **Category:** secrets (regex + entropy, git-history aware). · **SARIF:** YES (`--report-format sarif`).
- **Orchestration:** `Bun.spawn(["gitleaks","detect","--report-format","sarif","--report-path","-","-s",repoPath])`.

### TruffleHog — **secrets w/ live verification, SIDECAR-ONLY (AGPL)**
- **URL:** https://github.com/trufflesecurity/trufflehog · **License:** **AGPL-3.0** (confirmed 2026, latest ~Apr 2026).
- **COMMERCIAL-SAFE?** **SIDECAR-ONLY & legally risky.** AGPL network clause can attach if your SaaS exposes its functionality. Its standout feature — **live credential verification** (800+ detectors that actually call the API to confirm a secret is live) — is valuable, but for a paid SaaS prefer **Kingfisher (Apache-2.0)** which now does the same.
- **Category:** secrets + verification. · **SARIF:** limited/JSON-first.

### CodeQL — **proprietary, OSS-code-only (not for Sthrip's product)**
- **URL:** https://github.com/github/codeql (queries MIT) vs. the **CLI/engine = proprietary**.
- **License:** Queries MIT; **engine free only on research/OSS code.** Scanning customers' proprietary code in a commercial product requires GitHub Advanced Security. **CONFIRMED still proprietary in 2026.**
- **COMMERCIAL-SAFE?** **NO** for Sthrip's product. Strong tech (deep dataflow CPG) but a licensing dead-end for a competing SaaS.

### Bearer — **DISQUALIFIED (Elastic License 2.0)**
- **URL:** https://github.com/Bearer/bearer (now "Bearer by Cycode"; Cycode acquired Bearer 2024).
- **License:** **Elastic License 2.0** (verified `LICENSE.txt`) — explicitly: "may not provide the software to third parties as a hosted or managed service."
- **COMMERCIAL-SAFE?** **NO.** Cannot be the engine of a competing SaaS. Privacy/PII-flow SAST is nice, but ELv2 kills it for Sthrip. Prior finding **CONFIRMED**.

### Joern — **OSS reachability / CPG taint, recommended (advanced tier)**
- **URL:** https://github.com/joernio/joern · **Stars:** ~3.2k. · **Latest:** v4.x, actively released (e.g. v4.0.5xx, May 2026).
- **License:** **Apache-2.0** (verified `LICENSE`; bundled web assets MIT). Originated at ShiftLeft/Qwiet, now community Joern Project.
- **COMMERCIAL-SAFE?** **YES.** · **Category:** reachability / taint via **Code Property Graph** (the same CPG primitive Qwiet/ShiftLeft and Semgrep Pro deep-analysis use). · **Languages:** C/C++, Java, JVM bytecode, Kotlin, Python, JS/TS, Go, LLVM bitcode, x86 binaries.
- **SARIF:** No first-class SARIF; outputs CPG/JSON via its CPGQL query language — you normalize yourself.
- **Orchestration:** heavier — spawn `joern --script <cpgql>` against a generated CPG; treat as the **only OSS engine that gives true function-level taint/reachability** to back "exploitable, not theoretical." Pair with deps findings to compute reachability of vulnerable functions.

---

## 3. NEW in 2026 — freshest first (flag = NEW)

### Kingfisher (MongoDB) — **NEW 2026 · secrets + live validation · recommended replacement for TruffleHog**
- **URL:** https://github.com/mongodb/kingfisher · **Stars:** ~1k. · **Released:** mid-2025, **heavy 2026 activity** (87 releases), Rust.
- **License:** **Apache-2.0** (no telemetry, no vendor lock-in). · **COMMERCIAL-SAFE?** **YES.**
- **Category:** secrets. **~942 rules, 484 with LIVE validation** across 16 languages; SIMD/Hyperscan + language-aware parsing → fast & precise. "Access Map" maps a leaked credential to cloud identities/resources across 42 providers (real blast radius) and supports direct revocation.
- **Why it matters for Sthrip:** gives you TruffleHog-grade *live verification* under **Apache-2.0** instead of AGPL. **Pick this over TruffleHog.**
- **Orchestration:** `Bun.spawn(["kingfisher","scan",repoPath,"--format","json"])` (SARIF/JSON; normalize).

### Betterleaks (Zach Rice, Gitleaks creator) — **NEW Feb 2026 · secrets · drop-in faster Gitleaks**
- **URL:** github.com/(gitleaks author zricethezav)/betterleaks · coverage: https://thenewstack.io/betterleaks-open-source-secret-scanner/ · https://www.aikido.dev/blog/betterleaks-gitleaks-successor
- **Started:** 3 Feb 2026 by the original Gitleaks author. · **License:** **MIT.** · **COMMERCIAL-SAFE?** **YES.**
- **Category:** secrets. Drop-in Gitleaks replacement (same flags/configs), **RE2 + multi git-worker → 4–5x faster** on large repos. "Built for the agentic era."
- **Verdict:** If you adopt Gitleaks, evaluate Betterleaks as the faster successor; same MIT safety. Still young (watch maturity).

### datadog-static-analyzer + GuardDog (Datadog) — **NEW-ish, Apache-2.0 · SAST + malicious-package**
- **URLs:** https://github.com/DataDog/datadog-static-analyzer · https://github.com/DataDog/guarddog
- **License:** both **Apache-2.0.** · **COMMERCIAL-SAFE?** **YES.**
- **datadog-static-analyzer:** Rust SAST engine using **its own open rule format** (and can run some `tree-sitter`/Semgrep-style rules) — an alternative engine whose rules aren't SRL/Commons-encumbered. SARIF output. Worth piloting alongside Opengrep for rule diversity.
- **GuardDog (2.0):** detects **malicious** PyPI/npm/Go/RubyGems/GitHub-Actions/VSCode packages (YARA + heuristics) — covers the *supply-chain-attack* angle Trivy/OSV (known-CVE) miss. Great for "is this dependency itself hostile."

### ast-grep — **structural-search engine usable for custom security rules · MIT**
- **URL:** https://github.com/ast-grep/ast-grep · **Stars:** ~14.2k. · **Latest:** v0.43.0 (25 May 2026). · **License:** **MIT.**
- **COMMERCIAL-SAFE?** **YES.** · **Category:** SAST-capable (it's a fast tree-sitter AST pattern matcher; `ast-grep scan` + YAML rules). **SARIF output supported.** Many languages via tree-sitter.
- **Use for Sthrip:** author **your own** MIT-clean structural security rules here (no SRL/Commons baggage at all) where you want determinism/speed without Opengrep's heavier semantic engine. Complements, not replaces, Opengrep's taint.

### GitHub Security Lab — Taskflow Agent — **NEW 6 Mar 2026 · agentic SAST/triage framework · MIT**
- **URL:** https://github.com/GitHubSecurityLab/seclab-taskflow-agent (+ `seclab-taskflows`)
- **License:** **MIT.** · **COMMERCIAL-SAFE?** **YES.** · **Category:** AI/agentic triage + auditing framework (orchestrates LLM agents over code; ran a campaign that surfaced 80+ real OSS flaws).
- **Use for Sthrip:** a reference architecture/skeleton for your AI triage layer — wire it (or its taskflow patterns) over Opengrep/Joern SARIF to do exploitability reasoning and FP filtering. MIT lets you fork/port.

### Rival "SASTBench" — **NEW 2026 · benchmark + agentic-triage design data**
- **URL:** https://rival.security/posts/sastbench-overview · paper https://arxiv.org/html/2601.02941v1
- **Open-sourced.** Benchmarks AI SAST *triage* (real CVEs as TPs + filtered SAST findings as approx FPs). Finding: a ReAct agent with code-context fetch + dataflow + exploitability assessment ~doubled triage accuracy; gains are strong for Claude Sonnet 4 / GPT-5-class backbones.
- **Use for Sthrip:** use it to *measure* your triage layer's FP-reduction and exploitability accuracy (proof points for the "exploitable, not theoretical" marketing). Also see arXiv 2601.22952 (LLM agents cut FP rate from >92% to ~6.3% on OWASP Benchmark + real Java).

### Vulnhuntr (Protect AI) — **LLM zero-shot exploit discovery · AGPL · SIDECAR-ONLY**
- **URL:** https://github.com/protectai/vulnhuntr · **Stars:** ~2.7k. · **License:** **AGPL-3.0.**
- **COMMERCIAL-SAFE?** **SIDECAR-ONLY / risky** (AGPL; Protect AI now part of Palo Alto). · **Category:** AI exploitability — traces remote-input→sink call chains with Claude/GPT to find multi-step RCE/SSRF/IDOR etc.
- **Use for Sthrip:** **study its prompt/call-chain methodology and re-implement clean** in your own MIT/closed triage layer rather than shipping the AGPL binary. Fork `CompassSecurity/xvulnhuntr` exists.

### Qualys "Agent Val" — **commercial, reference only**
- https://blog.qualys.com/.../meet-agent-val — agentic exploitability validation ("TruConfirm" PoC validation at machine speed). Closed-source; cite as market direction for "validate before alerting," not a component.

---

## 4. Rules sourcing — staying SRL/Commons-free (the part everyone gets wrong)

| Rule source | License | Safe to ship in Sthrip? |
|---|---|---|
| `semgrep/semgrep-rules` | SRL-1.0 | **NO** (no-compete/no-SaaS) |
| `opengrep/opengrep-rules` | LGPL-2.1 **+ Commons Clause** | **NO** (Commons Clause "Sell") |
| **`AikidoSec/opengrep-rules`** | **MIT** (verified `LICENSE`) | **YES** ✅ |
| **Rules you author** (Opengrep/ast-grep YAML) | yours | **YES** ✅ |
| Trivy `trivy-checks`, datadog-static-analyzer rules, GuardDog heuristics | Apache-2.0 | **YES** ✅ |
| CodeQL queries | MIT | YES for the *query text*, but useless without the proprietary engine |

**Action:** ship Opengrep engine + (Aikido MIT rules ⊕ Sthrip-authored rules). Never `--config p/...` pulling Semgrep's registry, and never bundle `opengrep-rules` verbatim.

---

## 5. Ranked recommendation for Sthrip's SAST stack

**Tier 1 — adopt now, fully commercial-safe sidecars (`Bun.spawn`, normalize to SARIF):**
1. **Opengrep** (LGPL-2.1 engine) — primary SAST + taint. Rules = **Aikido MIT + your own**.
2. **Trivy** (Apache-2.0) — deps/CVE + IaC + SBOM + secrets, one binary.
3. **OSV-Scanner v2** (Apache-2.0) — canonical, low-noise OSS dependency CVEs.
4. **Kingfisher** (Apache-2.0, **NEW**) — secrets *with live validation* → real, not theoretical, secret findings. (Use instead of AGPL TruffleHog.)
5. **Gitleaks** (MIT) or **Betterleaks** (MIT, **NEW**, faster) — fast git-history secret baseline.

**Tier 2 — add for depth / the "whitebox, exploitable" differentiator:**
6. **Joern** (Apache-2.0) — the only OSS **function-level taint/reachability (CPG)** engine; back "exploitable-not-theoretical" and compute whether a CVE's vulnerable function is actually reachable. (You normalize its JSON; no native SARIF.)
7. **Grype + Syft** (Apache-2.0) — second SCA opinion + SBOM generation.
8. **GuardDog** (Apache-2.0, **NEW 2.0**) — malicious-package detection (supply-chain attacks beyond known CVEs).
9. **ast-grep** (MIT) — author fast, deterministic, 100%-clean custom structural security rules.
10. **datadog-static-analyzer** (Apache-2.0) — alt SAST engine for rule diversity, non-SRL.

**Tier 3 — AI triage / exploitability layer (the Hacktron-grade quality moat):**
11. **GitHub Seclab Taskflow Agent** (MIT, **NEW**) — fork/port as the skeleton for Sthrip's agentic triage over the SARIF firehose.
12. **SASTBench / arXiv FP-filtering research** (open) — measure & tune FP reduction + exploitability accuracy.
13. **Vulnhuntr methodology** (AGPL — **port, don't ship**) — re-implement its remote-input→sink LLM call-chain technique inside Sthrip's closed triage code.

**Explicitly excluded for Sthrip's product engine:**
- **Semgrep registry rules** (SRL-1.0 — no-compete/no-SaaS). *(Engine LGPL is fine; just use Opengrep.)*
- **CodeQL engine** (proprietary; free only on OSS code).
- **Bearer** (Elastic License 2.0 — explicit no-hosted-service clause).
- **TruffleHog / Vulnhuntr binaries** (AGPL — sidecar-only & legally risky for a SaaS that exposes their function; replace/port).

**Architecture note:** every Tier-1/2 tool is a process you `Bun.spawn` and feed `repoPath`; collect each tool's SARIF (or JSON→SARIF for Joern/Kingfisher/GuardDog), **merge with a SARIF normalizer** (e.g. SARIF SDK / `sarif-tools`, or your own `microsoft/sarif-tools` MIT), dedupe by rule+location, then run the LLM triage/exploitability layer (Tier 3) to filter FPs and rank by reachability. Sidecar isolation also keeps every LGPL/Apache obligation satisfied without touching Sthrip's source.

---

## Sources

- Opengrep: https://github.com/opengrep/opengrep · https://www.opengrep.dev/ · rules license (raw): https://raw.githubusercontent.com/opengrep/opengrep-rules/main/LICENSE
- Aikido OSS rules (MIT): https://github.com/AikidoSec/opengrep-rules · https://www.aikido.dev/blog/opengrep-sast-one-year
- Semgrep rules license (SRL-1.0): https://semgrep.dev/legal/rules-license/ · https://semgrep.dev/docs/licensing
- Opengrep fork background: https://www.infoq.com/news/2025/02/semgrep-forked-opengrep/ · https://socket.dev/blog/opengrep-forks-semgrep
- Trivy: https://github.com/aquasecurity/trivy · https://www.aquasec.com/blog/trivy-open-source-vulnerability-scanner-apache2-0-license/
- Grype/Syft: https://github.com/anchore/grype · https://oss.anchore.com/docs/
- OSV-Scanner: https://github.com/google/osv-scanner · https://google.github.io/osv-scanner/output/
- Gitleaks: https://github.com/gitleaks/gitleaks · https://gitleaks.io/
- TruffleHog: https://github.com/trufflesecurity/trufflehog
- ggshield: https://github.com/GitGuardian/ggshield
- Kingfisher: https://github.com/mongodb/kingfisher · https://www.mongodb.com/company/blog/product-release-announcements/introducing-kingfisher-real-time-secret-detection-validation
- Betterleaks: https://thenewstack.io/betterleaks-open-source-secret-scanner/ · https://www.aikido.dev/blog/betterleaks-gitleaks-successor
- ast-grep: https://github.com/ast-grep/ast-grep
- Joern: https://github.com/joernio/joern · https://docs.joern.io/ · LICENSE: https://raw.githubusercontent.com/joernio/joern/master/LICENSE
- CodeQL: https://github.com/github/codeql · https://codeql.github.com/
- Bearer (ELv2): https://github.com/Bearer/bearer
- Datadog static analyzer / GuardDog: https://github.com/DataDog/datadog-static-analyzer · https://github.com/DataDog/guarddog
- GitHub Seclab Taskflow Agent: https://github.com/GitHubSecurityLab/seclab-taskflow-agent · https://github.blog/security/ai-supported-vulnerability-triage-with-the-github-security-lab-taskflow-agent/
- Rival SASTBench: https://rival.security/posts/sastbench-overview · https://arxiv.org/html/2601.02941v1 · FP-filtering study: https://arxiv.org/pdf/2601.22952
- Vulnhuntr: https://github.com/protectai/vulnhuntr · https://www.helpnetsecurity.com/2025/07/28/vulnhuntr-open-source-tool-identify-remotely-exploitable-vulnerabilities/
- Endor Labs / Socket reachability: https://docs.endorlabs.com/scan/sca/reachability-analysis/ · https://socket.dev/blog/comparing-reachability-analysis-providers
- Qualys Agent Val: https://blog.qualys.com/product-tech/2026/03/23/meet-agent-val-closing-the-validation-gap-in-exposure-management-at-machine-speed-with-agentic-ai
