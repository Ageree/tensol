# Whitebox MDASH Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild whitebox **deep mode** as a 5-stage, multi-model, tool-using agentic harness modeled on Microsoft MDASH (Prepare → Scan auditors → Validate debaters → Dedup → Prove), default-OFF behind `TENSOL_HARNESS_ENABLED`, fast mode and the old `runResearch` deep path untouched as fallbacks.

**Architecture:** The harness builds MDASH stages 1–3 (Prepare/Scan/Validate) as a **drop-in replacement for `runResearch`** — it returns `LlmVerdict[]`, so the engine's existing deterministic moat (Dedup via `verdictToFinding` fingerprinting, Prove via Joern reachability + the gated Exploit Lab, the verify gate, and `score.ts`) realizes stages 4–5 unchanged. Multi-model = per-role `LlmClient`s (auditor=gpt-5.5 SOTA, debater=qwen cheap, counterpoint=2nd independent SOTA) over one shared per-scan budget. Generator ≠ Judge is preserved: models emit decomposed CVSS + confidence, never the 0–5 number.

**Tech Stack:** TypeScript (Bun), Zod config, OpenRouter `chat()` tool-calling, `runAgentLoop`, `createBudget`/`createMeteredClient`, Drizzle/SQLite. Tests: `bun test` with stubbed `LlmClient`/`ChatTransport` + fake tool capabilities. Real-model E2E via `OPENROUTER_API_KEY`.

---

## Design refinements vs. spec (locked from API recon)

1. **No migration.** `verdictToFinding` is private and `ReviewFinding`/persistence have no credibility column. The multi-model debate outcome is folded into existing fields: `confidence` band + a `## Multi-model debate` markdown section appended to `rationaleMd`. Zero schema/persistence risk. (Structured-credibility columns = optional future `0016_harness_findings.sql`, out of scope here.)
2. **Drop-in seam.** `runResearch(files, llm, opts): Promise<LlmVerdict[]>` and the harness both return `LlmVerdict[]`. New engine dep `deps.harness?.run({files, repoDir, rawFindings?, rulesMd?})`; chosen only in `mode === "deep"` when present + `repoDir` exists, else `runResearch`.
3. **`confidenceFloor` stays undefined** on the harness path → the engine's `selfChallenge` is NOT double-run (the harness's Validate stage already debated). `verifyFindings` uses its default `"low"` floor.
4. **Debate is tool-using and multi-model** (not the text-only `selfChallenge`): R1 refuter = debater model (qwen), R2 counterpoint = 2nd SOTA, run only on R1 survivors. Disagreement (R1 can't refute, R2 can) → downgrade + "contested" annotation.
5. **Prepare is deterministic + recon-augmented:** lens assignment & priority are deterministic (reliable, testable); the recon model (qwen) produces a best-effort threat-model markdown summary injected into auditor prompts (so the cheap model genuinely contributes without correctness depending on it).

---

## File Structure

**New files:**
| Path | Responsibility |
|---|---|
| `server/src/review/harness/types.ts` | Stage I/O types: `HarnessRole`, `HarnessModels`, `HarnessSession`, `AttackSurfaceUnit`, `CandidateFinding`, `DebateResult`, `HarnessOptions`, `HarnessRunArgs`, `HarnessRunner`. |
| `server/src/review/harness/models.ts` | `buildHarnessModels(...)` → `HarnessSession` (per-role metered clients on one shared budget; counterpoint fallback+warn). |
| `server/src/review/harness/lenses.ts` | `LENS_BY_CATEGORY`, `LENS_DIRECTIVE`, `REPO_TOOL_PROTOCOL`, `REFUTE_PROTOCOL` constants. |
| `server/src/review/harness/threat-model.ts` | `buildThreatModel(...)` (deterministic lens+priority) + `runReconPass(...)` (best-effort markdown). |
| `server/src/review/harness/prepare.ts` | `runPrepare(...)` → `{ candidates, units, threatModelMd }`. |
| `server/src/review/harness/auditor.ts` | `runAuditor(...)` → tool-using `runAgentLoop` per lens → `CandidateFinding[]`. |
| `server/src/review/harness/scan.ts` | `runScan(...)` parallel auditor fan-out (bounded, fault-isolated, budget-gated) + pre-dedup. |
| `server/src/review/harness/debate.ts` | `debate(...)` multi-model adversarial refute → `DebateResult` (credibility). |
| `server/src/review/harness/validate.ts` | `runValidate(...)` parallel debates → confidence-adjusted, annotated `LlmVerdict[]`. |
| `server/src/review/harness/orchestrator.ts` | `runHarness(args, session, deps)` sequences Prepare→Scan→Validate → `LlmVerdict[]`. |
| `server/src/review/agent/tools/repo-tools.ts` | `buildRepoAgentTools(caps)` + `createFsRepoCapabilities(...)`: read_file/list_files/grep/query_sast/query_reachability over the checkout. |
| `server/scripts/e2e-harness.ts` | Real-model E2E vs `Ageree/sthrip-review-testbed`. |

**Modified files:**
| Path | Change |
|---|---|
| `server/src/config.ts` | Add `TENSOL_HARNESS_*` env block. |
| `server/src/review/engine.ts` | Add `RunReviewDeps.harness?`; choose harness vs `runResearch` in the deep branch. |
| `server/src/jobs/handlers/whitebox-scan.ts` | Add `harness?` + `reachability?` deps; build session + harness runner per review; pass `reachability` to `runReview`. |
| `server/src/server.ts` | Build Joern client + harness config (gated); pass to `createWhiteboxScanHandler`. |

Test files mirror each source file under the same dir with `.test.ts`.

---

## Task 1: Config flags

**Files:**
- Modify: `server/src/config.ts` (after line 244, the `TENSOL_BLACKBOX_AGENT_ENABLED` entry)
- Test: `server/src/config.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```ts
// server/src/config.test.ts — add
test("harness flags: defaults are off and conservative", () => {
  const c = loadConfig({}); // existing helper that parses an env record
  expect(c.TENSOL_HARNESS_ENABLED).toBe(false);
  expect(c.TENSOL_HARNESS_MODEL_AUDITOR).toBe("openai/gpt-5.5");
  expect(c.TENSOL_HARNESS_MODEL_DEBATER).toBe("qwen/qwen3.7-max");
  expect(c.TENSOL_HARNESS_MODEL_COUNTERPOINT).toBe(""); // "" → fallback handled in models.ts
  expect(c.TENSOL_HARNESS_MODEL_RECON).toBe("qwen/qwen3.7-max");
  expect(c.TENSOL_HARNESS_BUDGET_USD).toBe(2.0);
  expect(c.TENSOL_HARNESS_MAX_AUDITORS).toBe(12);
  expect(c.TENSOL_HARNESS_AUDITOR_MAX_ROUNDS).toBe(6);
  expect(c.TENSOL_HARNESS_DEBATE_MAX_ROUNDS).toBe(3);
});
test("harness enabled parses strictly via envBool", () => {
  expect(loadConfig({ TENSOL_HARNESS_ENABLED: "true" }).TENSOL_HARNESS_ENABLED).toBe(true);
  expect(loadConfig({ TENSOL_HARNESS_ENABLED: "0" }).TENSOL_HARNESS_ENABLED).toBe(false);
});
```
(If `config.test.ts` lacks a `loadConfig` helper, use the same parse entrypoint other tests in that file use.)

- [ ] **Step 2: Run — expect FAIL** `bun test server/src/config.test.ts` → unknown keys / undefined.

- [ ] **Step 3: Implement** — add to the Zod schema in `config.ts`, mirroring the existing `envBool`/`z.coerce.number()` conventions:

```ts
  // Whitebox MDASH harness (multi-model agentic deep mode) — default OFF
  TENSOL_HARNESS_ENABLED:            envBool(false),
  TENSOL_HARNESS_MODEL_AUDITOR:      z.string().default("openai/gpt-5.5"),
  TENSOL_HARNESS_MODEL_DEBATER:      z.string().default("qwen/qwen3.7-max"),
  TENSOL_HARNESS_MODEL_COUNTERPOINT: z.string().default(""), // "" → fall back to auditor model + warn
  TENSOL_HARNESS_MODEL_RECON:        z.string().default("qwen/qwen3.7-max"),
  TENSOL_HARNESS_BUDGET_USD:         z.coerce.number().positive().default(2.0),
  TENSOL_HARNESS_USD_PER_MTOK_IN:    z.coerce.number().nonnegative().default(5.0),
  TENSOL_HARNESS_USD_PER_MTOK_OUT:   z.coerce.number().positive().default(30.0),
  TENSOL_HARNESS_MAX_AUDITORS:       z.coerce.number().int().positive().default(12),
  TENSOL_HARNESS_AUDITOR_MAX_ROUNDS: z.coerce.number().int().positive().default(6),
  TENSOL_HARNESS_DEBATE_MAX_ROUNDS:  z.coerce.number().int().positive().default(3),
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(harness): add TENSOL_HARNESS_* config flags (default off)`

---

## Task 2: Harness types

**Files:**
- Create: `server/src/review/harness/types.ts`

No standalone test (pure types — exercised by every later test). Compiles under `tsc`.

- [ ] **Step 1: Write the types**

```ts
import type { DiffFile, LlmVerdict, RawFinding, Candidate } from "../types.ts";
import type { ChatTransport, LoopBudget, AgentTool } from "../agent/loop.ts";
import type { LlmClient } from "../reviewer.ts";
import type { ReachabilityClient } from "../reachability/joern.ts";
import type { SastRunner } from "../sast/runner.ts";
import type { ExpertKey } from "../research/types.ts";

export type HarnessRole = "recon" | "auditor" | "debater" | "counterpoint" | "triage";

export interface HarnessModels {
  readonly recon: LlmClient;          // cheap, complete()
  readonly auditor: ChatTransport;    // SOTA, tool-loop
  readonly debater: ChatTransport;    // cheap, tool-loop (R1 refuter)
  readonly counterpoint: ChatTransport; // 2nd SOTA (R2); === auditor if unset
  readonly triage: LlmClient;         // cheap, complete()
}

export interface HarnessModelNames {
  readonly auditor: string;
  readonly debater: string;
  readonly counterpoint: string;      // resolved (may equal auditor)
  readonly recon: string;
}

export interface HarnessSession {
  readonly models: HarnessModels;
  readonly modelNames: HarnessModelNames;
  readonly budget: LoopBudget;        // shared per-scan ceiling
  readonly counterpointDistinct: boolean; // false → counterpoint fell back to auditor model
}

export interface AttackSurfaceUnit {
  readonly id: string;
  readonly lens: ExpertKey;
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly signals: string[];
  readonly priority: number;          // 0..1, git-recency + signal weighted
}

export interface CandidateFinding extends LlmVerdict {
  readonly auditorLens: string;       // which auditor produced it
}

export interface DebateResult {
  readonly finding: LlmVerdict;       // confidence-adjusted; debate appended to rationaleMd
  readonly credibility: number;       // 0..1 posterior
  readonly survived: boolean;         // false → refuted, drop
}

export interface HarnessOptions {
  readonly maxAuditors: number;
  readonly auditorMaxRounds: number;
  readonly debateMaxRounds: number;
}

export interface HarnessRunArgs {
  readonly files: DiffFile[];
  readonly repoDir: string;
  readonly rawFindings?: RawFinding[];
  readonly rulesMd?: string;
}

export interface HarnessRunDeps {
  readonly sastRunner?: SastRunner;
  readonly reachability?: ReachabilityClient;
  readonly opts: HarnessOptions;
}

// The object the engine receives as deps.harness
export interface HarnessRunner {
  run(args: HarnessRunArgs): Promise<LlmVerdict[]>;
}
```

- [ ] **Step 2: Run** `bunx tsc --noEmit` (server) → expect 0 errors (types resolve).
- [ ] **Step 3: Commit** `feat(harness): stage I/O types`

---

## Task 3: Lens & protocol constants

**Files:**
- Create: `server/src/review/harness/lenses.ts`
- Test: `server/src/review/harness/lenses.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "bun:test";
import { LENS_BY_CATEGORY, LENS_DIRECTIVE, REPO_TOOL_PROTOCOL, REFUTE_PROTOCOL } from "./lenses.ts";
import { EXPERT_KEYS } from "../research/types.ts";

test("every ExpertKey has a directive", () => {
  for (const k of EXPERT_KEYS) expect(typeof LENS_DIRECTIVE[k]).toBe("string");
});
test("category map only yields valid lenses", () => {
  for (const lens of Object.values(LENS_BY_CATEGORY)) expect(EXPERT_KEYS).toContain(lens);
});
test("protocols instruct plain-JSON final answer, not a tool call", () => {
  expect(REPO_TOOL_PROTOCOL).toContain("NOT a tool call");
  expect(REFUTE_PROTOCOL).toContain("strict JSON");
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement** — `lenses.ts`. `LENS_DIRECTIVE` keyed by every `ExpertKey` (12 keys from `EXPERT_KEYS`); `LENS_BY_CATEGORY` maps `RoutingUnitCategory` strings → `ExpertKey`; the two protocol strings:

```ts
import type { ExpertKey } from "../research/types.ts";

export const LENS_DIRECTIVE: Record<ExpertKey, string> = {
  "injection": "FOCUS: injection (SQL/NoSQL/OS-command/LDAP/template). Trace untrusted input to an interpreter sink.",
  "broken-access-control": "FOCUS: authorization — missing ownership/role checks, IDOR, path-based authz bypass.",
  "authentication-failures": "FOCUS: authentication — weak/missing auth, session fixation, credential handling.",
  "cryptographic-failures": "FOCUS: crypto — weak algorithms, hardcoded keys, bad randomness, plaintext secrets.",
  "insecure-design": "FOCUS: design flaws — missing rate limits, trust-boundary errors, unsafe defaults.",
  "security-misconfiguration": "FOCUS: misconfiguration — debug on, permissive CORS, exposed admin, default creds.",
  "sensitive-information-exposure": "FOCUS: data exposure — secrets in logs/responses, PII leakage, verbose errors.",
  "software-data-integrity-failures": "FOCUS: integrity — unsafe deserialization, unsigned updates, CI/CD trust.",
  "software-supply-chain-failures": "FOCUS: supply chain — vulnerable/typosquatted deps, build-time injection.",
  "unrestricted-resource-consumption": "FOCUS: DoS — unbounded loops/allocations, ReDoS, missing pagination/limits.",
  "path-traversal-unrestricted-upload": "FOCUS: path traversal & unrestricted upload — file path/type/size handling.",
  "memory-buffer-boundary-errors": "FOCUS: memory safety — buffer/bounds errors, integer overflow (native code).",
};

// RoutingUnitCategory → lens. Keys must match research/recon's category strings; default → "insecure-design".
export const LENS_BY_CATEGORY: Record<string, ExpertKey> = {
  "injection": "injection",
  "auth": "authentication-failures",
  "access-control": "broken-access-control",
  "crypto": "cryptographic-failures",
  "secrets": "sensitive-information-exposure",
  "deserialization": "software-data-integrity-failures",
  "path": "path-traversal-unrestricted-upload",
  "upload": "path-traversal-unrestricted-upload",
  "resource": "unrestricted-resource-consumption",
  "memory": "memory-buffer-boundary-errors",
  "config": "security-misconfiguration",
  "supply-chain": "software-supply-chain-failures",
};

export const REPO_TOOL_PROTOCOL = [
  "TOOL PROTOCOL — you are auditing a whole repository checkout with tools:",
  "- Use `list_files`/`grep` to navigate, `read_file` to read any file in the repo, `query_sast` for static-analysis hotspots, and `query_reachability` to check whether a sink is reachable from an entry point.",
  "- Investigate REACHABILITY and data flow with tools before classifying a candidate. Do not guess when a tool can confirm.",
  "- Focus on your assigned vulnerability lens, but report any clearly-exploitable issue you find.",
  "- When you have enough evidence, STOP calling tools and return your FINAL answer as the strict JSON object described above — a plain assistant message, NOT a tool call, with no prose or code fences.",
].join("\n");

export const REFUTE_PROTOCOL = [
  "You are an INDEPENDENT skeptic running on a DIFFERENT model than the one that produced this finding.",
  "Your job is to REFUTE it: show it is a false positive, unreachable, or not exploitable in context.",
  "Use the tools (`read_file`, `grep`, `query_reachability`) to verify reachability before deciding. Default to skepticism, but do not refute a finding you cannot actually disprove.",
  "When done, STOP calling tools and return ONLY this strict JSON as a plain assistant message (no fences):",
  '{ "refuted": boolean, "confidence": "high" | "low", "reason_md": string, "reachable": boolean }',
].join("\n");
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(harness): lens directives + tool/refute protocols`

---

## Task 4: Repo-scoped agent tools

**Files:**
- Create: `server/src/review/agent/tools/repo-tools.ts`
- Test: `server/src/review/agent/tools/repo-tools.test.ts`

- [ ] **Step 1: Failing test** (inject fake capabilities — no fs):

```ts
import { test, expect } from "bun:test";
import { buildRepoAgentTools, type RepoToolCapabilities } from "./repo-tools.ts";

const caps = (over: Partial<RepoToolCapabilities> = {}): RepoToolCapabilities => ({
  repoDir: "/repo",
  readFile: async (p) => (p === "src/a.ts" ? "export const x = 1;" : null),
  listFiles: async () => ["src/a.ts", "src/b.ts"],
  grep: async (pat) => (pat === "eval" ? ["src/b.ts:4: eval(input)"] : []),
  ...over,
});

const byName = (n: string, c = caps()) => buildRepoAgentTools(c).find((t) => t.spec.name === n)!;

test("read_file returns contents", async () => {
  expect(await byName("read_file").run({ path: "src/a.ts" })).toContain("export const x");
});
test("read_file rejects path traversal", async () => {
  const r = await byName("read_file").run({ path: "../../etc/passwd" });
  expect(r).toMatch(/^ERROR:/);
});
test("read_file rejects query-injection chars", async () => {
  expect(await byName("read_file").run({ path: "a.ts?ref=evil" })).toMatch(/^ERROR:/);
});
test("read_file miss is not an error", async () => {
  expect(await byName("read_file").run({ path: "src/missing.ts" })).toContain("file not found");
});
test("grep returns bounded matches", async () => {
  expect(await byName("grep").run({ pattern: "eval" })).toContain("src/b.ts:4");
});
test("query_reachability degrades gracefully when no client", async () => {
  const out = await byName("query_reachability").run({ file: "src/b.ts", line: 4 });
  expect(out).toContain("unknown");
});
test("query_sast degrades gracefully when no runner", async () => {
  expect(await byName("query_sast").run({})).toContain("no static-analysis");
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `repo-tools.ts`. Replicate `pr-tools` discipline (`unsafePathReason`, 60k `bound`) + a within-`repoDir` resolved-path guard; the Joern-tool wraps a synthetic finding:

```ts
import type { AgentTool } from "../loop.ts";
import type { SastRunner } from "../../sast/runner.ts";
import type { ReachabilityClient } from "../../reachability/joern.ts";

const MAX_RESULT_CHARS = 60_000;
const MAX_GREP_MATCHES = 100;

function bound(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated at ${MAX_RESULT_CHARS} chars)`;
}
export function unsafePathReason(path: string): string | null {
  if (!path || typeof path !== "string") return "path must be a non-empty string";
  if (/[?#\\]/.test(path)) return 'must not contain "?", "#", or "\\"';
  if (path.startsWith("/")) return "must be repo-relative (no leading /)";
  if (path.split("/").includes("..")) return 'must not contain a ".." segment';
  return null;
}

export interface RepoToolCapabilities {
  readonly repoDir: string;
  readFile(path: string): Promise<string | null>;
  listFiles(dir: string): Promise<string[]>;
  grep(pattern: string, glob?: string): Promise<string[]>;
  readonly sast?: SastRunner;
  readonly reachability?: ReachabilityClient;
}

export function buildRepoAgentTools(caps: RepoToolCapabilities): AgentTool[] {
  const readFile: AgentTool = {
    spec: {
      name: "read_file",
      description: "Read the full contents of a repo file. Use this to inspect callers, callees, config, and related modules before deciding whether a finding is exploitable.",
      parameters: { type: "object", properties: { path: { type: "string", description: 'Repo-relative path, e.g. "src/db/query.ts".' } }, required: ["path"] },
    },
    run: async (args) => {
      const path = String(args.path ?? "");
      const bad = unsafePathReason(path);
      if (bad) return `ERROR: path ${bad}`;
      const c = await caps.readFile(path);
      return c === null ? `(file not found: ${path})` : bound(c);
    },
  };
  const listFiles: AgentTool = {
    spec: {
      name: "list_files",
      description: "List repo-relative file paths under a directory (default: repo root).",
      parameters: { type: "object", properties: { dir: { type: "string", description: 'Repo-relative dir, e.g. "src". Empty = root.' } } },
    },
    run: async (args) => {
      const dir = String(args.dir ?? "");
      if (dir && unsafePathReason(dir)) return `ERROR: dir ${unsafePathReason(dir)}`;
      const files = await caps.listFiles(dir);
      return bound(files.join("\n") || "(empty)");
    },
  };
  const grep: AgentTool = {
    spec: {
      name: "grep",
      description: "Search the repo for a regular-expression pattern. Returns up to 100 'path:line: text' matches.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string", description: 'Optional path glob, e.g. "**/*.ts".' } }, required: ["pattern"] },
    },
    run: async (args) => {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return "ERROR: pattern must be a non-empty string";
      try {
        const matches = await caps.grep(pattern, args.glob ? String(args.glob) : undefined);
        return bound(matches.slice(0, MAX_GREP_MATCHES).join("\n") || "(no matches)");
      } catch (e) { return `ERROR: grep failed — ${(e as Error).message}`; }
    },
  };
  const querySast: AgentTool = {
    spec: {
      name: "query_sast",
      description: "Return static-analysis (SAST) hotspots for the repo, optionally filtered to one file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    run: async (args) => {
      if (!caps.sast) return "(no static-analysis runner available)";
      try {
        const findings = await caps.sast.run({ repoDir: caps.repoDir, ...(args.path ? { files: [String(args.path)] } : {}) });
        if (findings.length === 0) return "(no SAST findings)";
        return bound(findings.map((f) => `${f.filePath}:${f.startLine ?? "?"} [${f.ruleId}] ${f.message}`).join("\n"));
      } catch (e) { return `ERROR: SAST query failed — ${(e as Error).message}`; }
    },
  };
  const queryReach: AgentTool = {
    spec: {
      name: "query_reachability",
      description: "Check whether code at file:line is reachable from an entry point (taint/CPG). Returns reachable/unreachable/unknown with evidence.",
      parameters: { type: "object", properties: { file: { type: "string" }, line: { type: "number" } }, required: ["file", "line"] },
    },
    run: async (args) => {
      if (!caps.reachability) return "(reachability unknown: no analyzer available)";
      const file = String(args.file ?? "");
      const line = Number(args.line ?? 0);
      if (unsafePathReason(file)) return `ERROR: file ${unsafePathReason(file)}`;
      try {
        const fp = `probe:${file}:${line}`;
        const synthetic = { fingerprint: fp, filePath: file, startLine: line, side: "RIGHT", severity: "medium", cwe: [], cvssVector: "", cvssScore: 0, confidence: "low", reachable: false, category: "probe", title: "reachability probe", rationaleMd: "", source: "llm" } as const;
        const res = await caps.reachability.analyze({ repoDir: caps.repoDir, findings: [synthetic as never] });
        const r = res[fp];
        if (!r) return "(reachability unknown)";
        return `reachable=${r.reachable}${r.evidenceMd ? `\n${bound(r.evidenceMd)}` : ""}`;
      } catch (e) { return `ERROR: reachability query failed — ${(e as Error).message}`; }
    },
  };
  return [readFile, listFiles, grep, querySast, queryReach];
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Implement `createFsRepoCapabilities`** in the same file (fs-backed default; bounded recursive walk; ignores `.git`/`node_modules`). Add a test that reads a temp file written under a `mkdtemp` dir and that traversal outside `repoDir` is blocked even via `readFile`:

```ts
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// test: create dir, write src/a.ts, assert createFsRepoCapabilities(dir).readFile("src/a.ts") works,
// and readFile("../../etc/passwd") returns null/blocked (resolved path escapes repoDir).
```
`createFsRepoCapabilities`:
```ts
import { readFile as fsRead, readdir } from "node:fs/promises";
import { resolve, relative, join, sep } from "node:path";

export function createFsRepoCapabilities(repoDir: string, extra?: { sast?: SastRunner; reachability?: ReachabilityClient }): RepoToolCapabilities {
  const root = resolve(repoDir);
  const inside = (p: string) => { const abs = resolve(root, p); return abs === root || abs.startsWith(root + sep) ? abs : null; };
  const IGNORE = new Set([".git", "node_modules", "dist", "build", ".next"]);
  async function walk(dir: string, acc: string[], depth = 0): Promise<void> {
    if (depth > 12 || acc.length > 5000) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, acc, depth + 1);
      else acc.push(relative(root, abs));
    }
  }
  return {
    repoDir: root,
    readFile: async (p) => { const abs = inside(p); if (!abs) return null; try { return await fsRead(abs, "utf8"); } catch { return null; } },
    listFiles: async (d) => { const abs = inside(d || "."); if (!abs) return []; const acc: string[] = []; await walk(abs, acc); return acc; },
    grep: async (pattern, _glob) => {
      const all: string[] = []; await walk(root, all);
      let re: RegExp; try { re = new RegExp(pattern); } catch { return []; }
      const out: string[] = [];
      for (const rel of all) {
        if (out.length >= 100) break;
        const abs = inside(rel); if (!abs) continue;
        let text; try { text = await fsRead(abs, "utf8"); } catch { continue; }
        text.split("\n").forEach((ln, i) => { if (out.length < 100 && re.test(ln)) out.push(`${rel}:${i + 1}: ${ln.trim().slice(0, 200)}`); });
      }
      return out;
    },
    ...(extra?.sast ? { sast: extra.sast } : {}),
    ...(extra?.reachability ? { reachability: extra.reachability } : {}),
  };
}
```

- [ ] **Step 6: Run — expect PASS. Commit** `feat(harness): repo-scoped agent tools (read/list/grep/sast/reachability) with path safety`

---

## Task 5: Harness models (multi-model routing)

**Files:**
- Create: `server/src/review/harness/models.ts`
- Test: `server/src/review/harness/models.test.ts`

- [ ] **Step 1: Failing test** (inject a fake client factory — no network):

```ts
import { test, expect } from "bun:test";
import { buildHarnessModels } from "./models.ts";
import { createBudget } from "../../exploit/budget.ts";

const fakeFactory = (a: { model: string }) => ({
  _model: a.model,
  complete: async () => "{}",
  chat: async () => ({ content: "{}", toolCalls: [] }),
});

const base = () => ({
  apiKey: "k", baseUrl: "u",
  auditorModel: "openai/gpt-5.5", debaterModel: "qwen/qwen3.7-max",
  reconModel: "qwen/qwen3.7-max",
  budget: createBudget({ ceilingUsd: 2, usdPerMTokOut: 30, usdPerMTokIn: 5 }),
  makeClient: fakeFactory as never,
});

test("counterpoint distinct when set", () => {
  const s = buildHarnessModels({ ...base(), counterpointModel: "google/gemini-x" });
  expect(s.counterpointDistinct).toBe(true);
  expect(s.modelNames.counterpoint).toBe("google/gemini-x");
});
test("counterpoint falls back to auditor model when empty", () => {
  const s = buildHarnessModels({ ...base(), counterpointModel: "" });
  expect(s.counterpointDistinct).toBe(false);
  expect(s.modelNames.counterpoint).toBe("openai/gpt-5.5");
});
test("all role clients chat-capable where required + share one budget", () => {
  const s = buildHarnessModels({ ...base(), counterpointModel: "x/y" });
  expect(typeof s.models.auditor.chat).toBe("function");
  expect(typeof s.models.debater.chat).toBe("function");
  expect(typeof s.models.counterpoint.chat).toBe("function");
  expect(s.budget).toBeDefined();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `models.ts`:

```ts
import type { LlmClient } from "../reviewer.ts";
import type { ChatTransport } from "../agent/loop.ts";
import type { Budget } from "../../exploit/budget.ts";
import { createOpenRouterClient } from "../llm/openrouter.ts";
import { createMeteredClient } from "../../exploit/metered-client.ts";
import type { HarnessSession } from "./types.ts";

type ClientFactory = (a: { apiKey: string; baseUrl: string; model: string; jsonMode?: boolean }) => LlmClient;

export function buildHarnessModels(args: {
  apiKey: string; baseUrl: string;
  auditorModel: string; debaterModel: string; counterpointModel: string; reconModel: string;
  budget: Budget;
  makeClient?: ClientFactory;
}): HarnessSession {
  const make = args.makeClient ?? ((a) => createOpenRouterClient(a));
  const metered = (model: string, jsonMode: boolean) =>
    createMeteredClient(make({ apiKey: args.apiKey, baseUrl: args.baseUrl, model, jsonMode }), args.budget);

  const counterpointDistinct = args.counterpointModel.trim() !== "";
  const resolvedCounterpoint = counterpointDistinct ? args.counterpointModel : args.auditorModel;
  if (!counterpointDistinct) {
    console.warn("[tensol] TENSOL_HARNESS_MODEL_COUNTERPOINT unset — debate counterpoint falls back to the auditor model; this is NOT a true multi-model ensemble.");
  }

  const auditor = metered(args.auditorModel, false);
  const debater = metered(args.debaterModel, false);
  const counterpoint = metered(resolvedCounterpoint, false);
  const recon = metered(args.reconModel, true);
  const triage = metered(args.reconModel, true);

  const asTransport = (c: LlmClient): ChatTransport => {
    if (typeof c.chat !== "function") throw new Error("[tensol] harness model is not chat-capable");
    return c as ChatTransport;
  };

  return {
    models: { recon, triage, auditor: asTransport(auditor), debater: asTransport(debater), counterpoint: asTransport(counterpoint) },
    modelNames: { auditor: args.auditorModel, debater: args.debaterModel, counterpoint: resolvedCounterpoint, recon: args.reconModel },
    budget: args.budget,
    counterpointDistinct,
  };
}
```
(Note: `console.warn` here mirrors the existing `server.ts:1079` agent-fallback warn — acceptable per the codebase's existing warn-on-degrade pattern; not a `console.log`.)

- [ ] **Step 4: Run — expect PASS. Commit** `feat(harness): per-role multi-model client routing on a shared budget`

---

## Task 6: Threat model + Prepare stage

**Files:**
- Create: `server/src/review/harness/threat-model.ts`, `server/src/review/harness/prepare.ts`
- Test: `server/src/review/harness/threat-model.test.ts`, `server/src/review/harness/prepare.test.ts`

- [ ] **Step 1: threat-model failing test**

```ts
import { test, expect } from "bun:test";
import { buildThreatModel } from "./threat-model.ts";

const unit = (over: any) => ({ id: "u1", kind: "sink", category: "injection", filePath: "a.ts", line: 3, snippet: "db.query(x)", signals: ["sql"], ...over });

test("maps category to lens and bounds count", () => {
  const units = [unit({}), unit({ id: "u2", category: "crypto", filePath: "b.ts" }), unit({ id: "u3", category: "weird", filePath: "c.ts" })];
  const out = buildThreatModel({ units, rawFindings: [], maxUnits: 2 });
  expect(out.length).toBe(2);
  expect(out[0]!.lens).toBeDefined();
  expect(out.every((u) => u.priority >= 0 && u.priority <= 1)).toBe(true);
});
test("git recency raises priority", () => {
  const units = [unit({ id: "x", filePath: "hot.ts" }), unit({ id: "y", filePath: "cold.ts" })];
  const out = buildThreatModel({ units, rawFindings: [], gitRecency: { "hot.ts": 1 }, maxUnits: 2 });
  expect(out[0]!.filePath).toBe("hot.ts"); // highest priority first
});
test("unknown category falls back to insecure-design", () => {
  const out = buildThreatModel({ units: [unit({ category: "nonsense" })], rawFindings: [], maxUnits: 5 });
  expect(out[0]!.lens).toBe("insecure-design");
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `threat-model.ts`:

```ts
import type { RawFinding } from "../types.ts";
import type { RoutingUnit } from "../research/types.ts";
import type { LlmClient } from "../reviewer.ts";
import type { AttackSurfaceUnit } from "./types.ts";
import { LENS_BY_CATEGORY } from "./lenses.ts";

export function buildThreatModel(args: {
  units: RoutingUnit[]; rawFindings: RawFinding[];
  gitRecency?: Record<string, number>; maxUnits: number;
}): AttackSurfaceUnit[] {
  const sastFiles = new Set(args.rawFindings.map((f) => f.filePath));
  const scored = args.units.map((u): AttackSurfaceUnit => {
    const lens = LENS_BY_CATEGORY[u.category] ?? "insecure-design";
    const recency = args.gitRecency?.[u.filePath] ?? 0;
    const signalScore = Math.min(1, u.signals.length / 4);
    const sastBoost = sastFiles.has(u.filePath) ? 0.3 : 0;
    const priority = Math.min(1, 0.4 * signalScore + 0.3 * recency + sastBoost);
    return { id: u.id, lens, filePath: u.filePath, line: u.line, snippet: u.snippet, signals: u.signals, priority };
  });
  return scored.sort((a, b) => b.priority - a.priority).slice(0, args.maxUnits);
}

export async function runReconPass(reconLlm: LlmClient, repoSummary: string): Promise<string> {
  try {
    const md = await reconLlm.complete({
      system: "You are a security recon assistant. Given a repo summary, produce a SHORT markdown threat model: entry points, trust boundaries, and the highest-risk areas. <= 200 words. No code fences.",
      user: repoSummary,
    });
    return typeof md === "string" ? md.slice(0, 4000) : "";
  } catch { return ""; }
}
```

- [ ] **Step 4: prepare failing test** (stub recon llm; deterministic units via injected `buildRoutingUnits`/`deriveCandidates` are real funcs — pass real DiffFiles):

```ts
import { test, expect } from "bun:test";
import { runPrepare } from "./prepare.ts";
import type { DiffFile } from "../types.ts";

const files: DiffFile[] = [{ path: "a.ts", status: "added", contents: "const q = req.query.id; db.query(`SELECT ${q}`);" }];
const reconLlm = { complete: async () => "## Threat model\n- entry: req.query" };

test("prepare returns candidates, units and a threat-model md", async () => {
  const r = await runPrepare({ files, rawFindings: [], reconLlm: reconLlm as never, maxAuditors: 12 });
  expect(Array.isArray(r.candidates)).toBe(true);
  expect(Array.isArray(r.units)).toBe(true);
  expect(typeof r.threatModelMd).toBe("string");
});
test("prepare tolerates recon failure", async () => {
  const r = await runPrepare({ files, rawFindings: [], reconLlm: { complete: async () => { throw new Error("down"); } } as never, maxAuditors: 12 });
  expect(r.threatModelMd).toBe("");
});
```

- [ ] **Step 5: Implement** `prepare.ts`:

```ts
import type { DiffFile, RawFinding, Candidate } from "../types.ts";
import type { LlmClient } from "../reviewer.ts";
import type { AttackSurfaceUnit } from "./types.ts";
import { deriveCandidates } from "../candidates.ts";
import { buildRoutingUnits } from "../research/recon.ts";
import { buildThreatModel, runReconPass } from "./threat-model.ts";

export interface PrepareResult { candidates: Candidate[]; units: AttackSurfaceUnit[]; threatModelMd: string; }

export async function runPrepare(args: {
  files: DiffFile[]; rawFindings?: RawFinding[];
  reconLlm: LlmClient; gitRecency?: Record<string, number>; maxAuditors: number;
}): Promise<PrepareResult> {
  const rawFindings = args.rawFindings ?? [];
  const candidates = deriveCandidates({ files: args.files, rawFindings });
  const routing = buildRoutingUnits(args.files);
  const units = buildThreatModel({ units: routing, rawFindings, ...(args.gitRecency ? { gitRecency: args.gitRecency } : {}), maxUnits: Math.max(args.maxAuditors * 4, 24) });
  const summary = `Files: ${args.files.map((f) => f.path).join(", ")}\nHotspots: ${units.slice(0, 20).map((u) => `${u.filePath}:${u.line} (${u.lens})`).join("; ")}`;
  const threatModelMd = await runReconPass(args.reconLlm, summary);
  return { candidates, units, threatModelMd };
}
```

- [ ] **Step 6: Run both — expect PASS. Commit** `feat(harness): deterministic threat model + recon-augmented Prepare stage`

---

## Task 7: Auditor (Scan sub-agent)

**Files:**
- Create: `server/src/review/harness/auditor.ts`
- Test: `server/src/review/harness/auditor.test.ts`

- [ ] **Step 1: Failing test** (stub `ChatTransport` that returns a final strict-JSON verdict with no tool calls; fake tools):

```ts
import { test, expect } from "bun:test";
import { runAuditor } from "./auditor.ts";
import type { ChatResult } from "../llm/chat-types.ts";

const verdictJson = JSON.stringify({
  summary: "x",
  verdicts: [{ candidate_id: "c1", file_path: "a.ts", is_vulnerability: true, category: "SQL Injection",
    cwe: ["CWE-89"], rationale_md: "tainted query", reachable: true, confidence: "high",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" }, title: "SQLi" }],
});
const transport = { chat: async (): Promise<ChatResult> => ({ content: verdictJson, toolCalls: [] }) };

test("auditor parses verdicts and tags lens, keeping only vulnerabilities", async () => {
  const out = await runAuditor({
    lens: "injection", units: [], files: [{ path: "a.ts", status: "added", contents: "x" }],
    candidates: [{ id: "c1", filePath: "a.ts", source: "llm", hint: "h" }],
    threatModelMd: "", transport: transport as never, tools: [], maxRounds: 4,
  });
  expect(out).toHaveLength(1);
  expect(out[0]!.auditorLens).toBe("injection");
  expect(out[0]!.isVulnerability).toBe(true);
});
test("auditor drops non-vulnerabilities", async () => {
  const t = { chat: async (): Promise<ChatResult> => ({ content: JSON.stringify({ summary: "", verdicts: [{ candidate_id: "c1", file_path: "a.ts", is_vulnerability: false, category: "x", cwe: [], rationale_md: "safe", reachable: false, confidence: "low", cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" }, title: "t" }] }), toolCalls: [] }) };
  const out = await runAuditor({ lens: "injection", units: [], files: [{ path: "a.ts", status: "added", contents: "x" }], candidates: [{ id: "c1", filePath: "a.ts", source: "llm", hint: "h" }], threatModelMd: "", transport: t as never, tools: [], maxRounds: 4 });
  expect(out).toHaveLength(0);
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `auditor.ts` (reuse `buildContextBundle` + `buildReviewPrompt` + `runAgentLoop` + `parseReviewVerdicts`):

```ts
import type { DiffFile, Candidate } from "../types.ts";
import type { ChatTransport, AgentTool, LoopBudget } from "../agent/loop.ts";
import type { ExpertKey } from "../research/types.ts";
import type { AttackSurfaceUnit, CandidateFinding } from "./types.ts";
import { buildContextBundle } from "../context/repomap.ts";
import { buildReviewPrompt, parseReviewVerdicts } from "../reviewer.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { LENS_DIRECTIVE, REPO_TOOL_PROTOCOL } from "./lenses.ts";

export async function runAuditor(args: {
  lens: ExpertKey; units: AttackSurfaceUnit[]; files: DiffFile[]; candidates: Candidate[];
  threatModelMd: string; transport: ChatTransport; tools: AgentTool[];
  maxRounds: number; maxToolCalls?: number; budget?: LoopBudget; rulesMd?: string;
}): Promise<CandidateFinding[]> {
  const context = buildContextBundle({ files: args.files, candidates: args.candidates });
  const prompt = buildReviewPrompt({ context, candidates: args.candidates, ...(args.rulesMd !== undefined ? { rulesMd: args.rulesMd } : {}) });
  const threat = args.threatModelMd ? `\n\nTHREAT MODEL (recon):\n${args.threatModelMd}` : "";
  const result = await runAgentLoop({
    transport: args.transport,
    messages: [
      { role: "system", content: `${LENS_DIRECTIVE[args.lens]}\n\n${prompt.system}${threat}\n\n${REPO_TOOL_PROTOCOL}` },
      { role: "user", content: prompt.user },
    ],
    tools: args.tools, maxRounds: args.maxRounds,
    ...(args.maxToolCalls !== undefined ? { maxToolCalls: args.maxToolCalls } : {}),
    ...(args.budget ? { budget: args.budget } : {}),
  });
  return parseReviewVerdicts(result.finalContent)
    .filter((v) => v.isVulnerability)
    .map((v) => ({ ...v, auditorLens: args.lens }));
}
```

- [ ] **Step 4: Run — PASS. Commit** `feat(harness): tool-using auditor sub-agent (Scan)`

---

## Task 8: Scan orchestration (parallel auditors)

**Files:**
- Create: `server/src/review/harness/scan.ts`
- Test: `server/src/review/harness/scan.test.ts`

- [ ] **Step 1: Failing test** (assert fan-out, fault isolation, pre-dedup, maxAuditors cap):

```ts
import { test, expect } from "bun:test";
import { runScan } from "./scan.ts";

const okVerdict = (file: string) => ({ content: JSON.stringify({ summary: "", verdicts: [{ candidate_id: "c", file_path: file, start_line: 1, is_vulnerability: true, category: "SQLi", cwe: ["CWE-89"], rationale_md: "r", reachable: true, confidence: "high", cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" }, title: "t" }] }), toolCalls: [] });

function session() {
  const t = { chat: async () => okVerdict("a.ts") };
  return { models: { auditor: t, debater: t, counterpoint: t, recon: { complete: async () => "" }, triage: { complete: async () => "" } },
    modelNames: { auditor: "a", debater: "d", counterpoint: "c", recon: "r" }, budget: { assertWithin() {} }, counterpointDistinct: true } as never;
}
const units = (lens: string, file: string) => ({ id: `${lens}:${file}`, lens, filePath: file, line: 1, snippet: "s", signals: ["x"], priority: 0.5 });

test("fans out over lenses and dedups identical findings", async () => {
  const out = await runScan({
    units: [units("injection", "a.ts"), units("broken-access-control", "a.ts")],
    files: [{ path: "a.ts", status: "added", contents: "x" }],
    candidates: [{ id: "c", filePath: "a.ts", source: "llm", hint: "h" }],
    threatModelMd: "", session: session(), tools: [], opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 },
  });
  // both auditors emit a.ts:1 SQLi → deduped to one
  expect(out.length).toBe(1);
});
test("a throwing auditor does not abort the scan", async () => {
  const good = { chat: async () => okVerdict("a.ts") };
  const bad = { chat: async () => { throw new Error("boom"); } };
  const s = session(); (s as any).models.auditor = good;
  const out = await runScan({
    units: [units("injection", "a.ts"), units("crypto", "b.ts")],
    files: [{ path: "a.ts", status: "added", contents: "x" }],
    candidates: [{ id: "c", filePath: "a.ts", source: "llm", hint: "h" }],
    threatModelMd: "", session: s, tools: [], opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 },
  });
  expect(out.length).toBeGreaterThanOrEqual(1);
});
```
(Note: all auditors in `session()` share one transport; the dedup test relies on `runScan` grouping by lens and the pre-dedup key `filePath|startLine|category`.)

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scan.ts`:

```ts
import type { DiffFile, Candidate } from "../types.ts";
import type { AgentTool } from "../agent/loop.ts";
import type { ExpertKey } from "../research/types.ts";
import type { AttackSurfaceUnit, CandidateFinding, HarnessSession, HarnessOptions } from "./types.ts";
import { runAuditor } from "./auditor.ts";

const dedupKey = (f: CandidateFinding) => `${f.filePath}|${f.startLine ?? "?"}|${f.category.toLowerCase()}`;

export async function runScan(args: {
  units: AttackSurfaceUnit[]; files: DiffFile[]; candidates: Candidate[]; threatModelMd: string;
  session: HarnessSession; tools: AgentTool[]; opts: HarnessOptions; rulesMd?: string;
}): Promise<CandidateFinding[]> {
  // group units by lens, rank lenses by summed priority, cap to maxAuditors
  const byLens = new Map<ExpertKey, AttackSurfaceUnit[]>();
  for (const u of args.units) { const a = byLens.get(u.lens) ?? []; a.push(u); byLens.set(u.lens, a); }
  const lenses = [...byLens.entries()]
    .sort((a, b) => b[1].reduce((s, u) => s + u.priority, 0) - a[1].reduce((s, u) => s + u.priority, 0))
    .slice(0, args.opts.maxAuditors)
    .map(([lens]) => lens);

  const results = await Promise.all(lenses.map(async (lens) => {
    try { args.session.budget.assertWithin(); } catch { return [] as CandidateFinding[]; }
    try {
      return await runAuditor({
        lens, units: byLens.get(lens)!, files: args.files, candidates: args.candidates,
        threatModelMd: args.threatModelMd, transport: args.session.models.auditor, tools: args.tools,
        maxRounds: args.opts.auditorMaxRounds, budget: args.session.budget,
        ...(args.rulesMd !== undefined ? { rulesMd: args.rulesMd } : {}),
      });
    } catch { return [] as CandidateFinding[]; }
  }));

  const seen = new Set<string>(); const out: CandidateFinding[] = [];
  for (const f of results.flat()) { const k = dedupKey(f); if (!seen.has(k)) { seen.add(k); out.push(f); } }
  return out;
}
```

- [ ] **Step 4: Run — PASS. Commit** `feat(harness): parallel auditor fan-out with fault isolation + pre-dedup (Scan)`

---

## Task 9: Debate (multi-model Validate)

**Files:**
- Create: `server/src/review/harness/debate.ts`
- Test: `server/src/review/harness/debate.test.ts`

- [ ] **Step 1: Failing test** — covers the four outcomes (R1 refutes → drop; R1 fails+R2 fails → high credibility; R1 fails+R2 refutes → contested downgrade; counterpoint not distinct → no R2 boost):

```ts
import { test, expect } from "bun:test";
import { debate } from "./debate.ts";

const finding = { filePath: "a.ts", startLine: 3, isVulnerability: true, category: "SQLi", cwe: ["CWE-89"], rationaleMd: "tainted", reachable: true, confidence: "high", cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" }, title: "SQLi", auditorLens: "injection" } as never;
const refute = (refuted: boolean, confidence = "high") => ({ chat: async () => ({ content: JSON.stringify({ refuted, confidence, reason_md: "x", reachable: !refuted }), toolCalls: [] }) });
const sess = (debater: any, counterpoint: any, distinct = true) => ({ models: { debater, counterpoint, auditor: debater, recon: {}, triage: {} }, modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" }, budget: { assertWithin() {} }, counterpointDistinct: distinct } as never);

test("R1 refutes → dropped", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(true), refute(false)), tools: [], maxRounds: 3 });
  expect(r.survived).toBe(false);
});
test("both fail to refute → high credibility, survives", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(false), refute(false)), tools: [], maxRounds: 3 });
  expect(r.survived).toBe(true);
  expect(r.credibility).toBeGreaterThanOrEqual(0.85);
  expect(r.finding.rationaleMd).toContain("Multi-model debate");
});
test("R1 fails, R2 refutes → contested downgrade, survives at low confidence", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(false), refute(true)), tools: [], maxRounds: 3 });
  expect(r.survived).toBe(true);
  expect(r.credibility).toBeLessThan(0.6);
  expect(r.finding.confidence).toBe("low");
  expect(r.finding.rationaleMd.toLowerCase()).toContain("contested");
});
test("counterpoint not distinct → no R2 promotion above medium", async () => {
  const r = await debate({ finding, files: [], session: sess(refute(false), refute(false), false), tools: [], maxRounds: 3 });
  expect(r.credibility).toBeLessThanOrEqual(0.7);
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `debate.ts` — a tool-using refute loop + defensive parser:

```ts
import type { DiffFile, LlmVerdict, Confidence } from "../types.ts";
import type { ChatTransport, AgentTool } from "../agent/loop.ts";
import type { CandidateFinding, DebateResult, HarnessSession } from "./types.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { REFUTE_PROTOCOL } from "./lenses.ts";

interface RefuteVote { refuted: boolean; confidence: "high" | "low"; reasonMd: string; }

function parseRefute(raw: string | null): RefuteVote {
  if (!raw) return { refuted: false, confidence: "low", reasonMd: "(no response)" };
  const m = raw.match(/\{[\s\S]*\}/); if (!m) return { refuted: false, confidence: "low", reasonMd: "(unparseable)" };
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    return { refuted: o.refuted === true, confidence: o.confidence === "high" ? "high" : "low", reasonMd: typeof o.reason_md === "string" ? o.reason_md : "" };
  } catch { return { refuted: false, confidence: "low", reasonMd: "(unparseable)" }; }
}

async function refuteWith(transport: ChatTransport, finding: LlmVerdict, tools: AgentTool[], maxRounds: number, modelLabel: string): Promise<RefuteVote> {
  const claim = `CLAIMED VULNERABILITY (by another model):\n- file: ${finding.filePath}:${finding.startLine ?? "?"}\n- category: ${finding.category} (${finding.cwe.join(", ")})\n- rationale: ${finding.rationaleMd}\n- reachable (claimed): ${finding.reachable}\n- title: ${finding.title}`;
  try {
    const res = await runAgentLoop({ transport, messages: [{ role: "system", content: REFUTE_PROTOCOL }, { role: "user", content: claim }], tools, maxRounds });
    return parseRefute(res.finalContent);
  } catch { return { refuted: false, confidence: "low", reasonMd: `(${modelLabel} debate errored — abstaining)` }; }
}

export async function debate(args: { finding: CandidateFinding; files: DiffFile[]; session: HarnessSession; tools: AgentTool[]; maxRounds: number }): Promise<DebateResult> {
  const { finding, session } = args;
  const r1 = await refuteWith(session.models.debater, finding, args.tools, args.maxRounds, session.modelNames.debater);
  if (r1.refuted && r1.confidence === "high") {
    return { finding, credibility: 0.0, survived: false };
  }
  // survived R1 → counterpoint
  const r2 = await refuteWith(session.models.counterpoint, finding, args.tools, args.maxRounds, session.modelNames.counterpoint);

  let credibility: number; let confidence: Confidence; let contested = false;
  if (!r2.refuted) {
    credibility = session.counterpointDistinct ? 0.9 : 0.65; // independent model couldn't refute ⇒ strong signal
    confidence = session.counterpointDistinct ? "high" : "medium";
  } else {
    contested = true; credibility = 0.45; confidence = "low"; // model disagreement
  }
  if (r1.refuted) { credibility = Math.min(credibility, 0.5); confidence = "low"; }

  const debateMd = [
    "\n\n## Multi-model debate",
    `- **Auditor** (${session.modelNames.auditor}): flagged as ${finding.category}.`,
    `- **Refuter R1** (${session.modelNames.debater}): ${r1.refuted ? `refuted (${r1.confidence}) — ${r1.reasonMd}` : "could not refute."}`,
    `- **Counterpoint R2** (${session.modelNames.counterpoint}${session.counterpointDistinct ? "" : ", = auditor model"}): ${r2.refuted ? `refuted — ${r2.reasonMd}` : "could not refute."}`,
    contested ? "- **Verdict: CONTESTED** — models disagree on exploitability; confidence downgraded." : `- **Verdict:** credibility ${(credibility * 100).toFixed(0)}%.`,
  ].join("\n");

  return { finding: { ...finding, confidence, rationaleMd: `${finding.rationaleMd}${debateMd}` }, credibility, survived: true };
}
```

- [ ] **Step 4: Run — PASS. Commit** `feat(harness): multi-model adversarial debate with credibility (Validate core)`

---

## Task 10: Validate orchestration

**Files:**
- Create: `server/src/review/harness/validate.ts`
- Test: `server/src/review/harness/validate.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "bun:test";
import { runValidate } from "./validate.ts";

const cand = (file: string) => ({ filePath: file, startLine: 1, isVulnerability: true, category: "SQLi", cwe: ["CWE-89"], rationaleMd: "r", reachable: true, confidence: "high", cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" }, title: "t", auditorLens: "injection" } as never);
const refute = (refuted: boolean) => ({ chat: async () => ({ content: JSON.stringify({ refuted, confidence: "high", reason_md: "x", reachable: !refuted }), toolCalls: [] }) });
const sess = (refuted: boolean) => ({ models: { debater: refute(refuted), counterpoint: refute(false), auditor: refute(false), recon: {}, triage: {} }, modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" }, budget: { assertWithin() {} }, counterpointDistinct: true } as never);

test("drops refuted, keeps survivors as LlmVerdict[]", async () => {
  const survivors = await runValidate({ candidates: [cand("a.ts"), cand("b.ts")], files: [], session: sess(false), tools: [], opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 } });
  expect(survivors.length).toBe(2);
  expect((survivors[0] as any).auditorLens).toBeUndefined(); // returned as plain LlmVerdict
});
test("all refuted → empty", async () => {
  const survivors = await runValidate({ candidates: [cand("a.ts")], files: [], session: sess(true), tools: [], opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 } });
  expect(survivors.length).toBe(0);
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `validate.ts`:

```ts
import type { DiffFile, LlmVerdict } from "../types.ts";
import type { AgentTool } from "../agent/loop.ts";
import type { CandidateFinding, HarnessSession, HarnessOptions } from "./types.ts";
import { debate } from "./debate.ts";

export async function runValidate(args: {
  candidates: CandidateFinding[]; files: DiffFile[]; session: HarnessSession; tools: AgentTool[]; opts: HarnessOptions;
}): Promise<LlmVerdict[]> {
  const results = await Promise.all(args.candidates.map(async (finding) => {
    try { args.session.budget.assertWithin(); } catch {
      // budget exhausted → keep the finding un-debated at medium confidence rather than dropping evidence
      const { auditorLens: _l, ...v } = finding; return { ...v, confidence: "medium" as const };
    }
    try {
      const r = await debate({ finding, files: args.files, session: args.session, tools: args.tools, maxRounds: args.opts.debateMaxRounds });
      if (!r.survived) return null;
      const { auditorLens: _lens, ...v } = r.finding as CandidateFinding; return v;
    } catch {
      const { auditorLens: _l, ...v } = finding; return { ...v, confidence: "low" as const };
    }
  }));
  return results.filter((v): v is LlmVerdict => v !== null);
}
```

- [ ] **Step 4: Run — PASS. Commit** `feat(harness): Validate orchestration (parallel debates, drop refuted)`

---

## Task 11: Orchestrator (drop-in for runResearch)

**Files:**
- Create: `server/src/review/harness/orchestrator.ts`
- Test: `server/src/review/harness/orchestrator.test.ts`

- [ ] **Step 1: Failing test** (end-to-end with stub session + real repo-tools over fake caps; asserts it returns `LlmVerdict[]`):

```ts
import { test, expect } from "bun:test";
import { runHarness } from "./orchestrator.ts";
import type { DiffFile } from "../types.ts";

const files: DiffFile[] = [{ path: "a.ts", status: "added", contents: "const id = req.query.id; db.query(`SELECT * WHERE id=${id}`);" }];
const auditorJson = JSON.stringify({ summary: "", verdicts: [{ candidate_id: "c", file_path: "a.ts", start_line: 1, is_vulnerability: true, category: "SQLi", cwe: ["CWE-89"], rationale_md: "tainted", reachable: true, confidence: "high", cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" }, title: "SQLi" }] });
const auditor = { chat: async () => ({ content: auditorJson, toolCalls: [] }) };
const noRefute = { chat: async () => ({ content: JSON.stringify({ refuted: false, confidence: "high", reason_md: "ok", reachable: true }), toolCalls: [] }) };
const session = { models: { auditor, debater: noRefute, counterpoint: noRefute, recon: { complete: async () => "tm" }, triage: { complete: async () => "" } }, modelNames: { auditor: "A", debater: "D", counterpoint: "C", recon: "R" }, budget: { assertWithin() {} }, counterpointDistinct: true } as never;

test("runHarness returns surviving LlmVerdict[]", async () => {
  const verdicts = await runHarness({ files, repoDir: "/repo" }, session, { opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 } });
  expect(verdicts.length).toBe(1);
  expect(verdicts[0]!.rationaleMd).toContain("Multi-model debate");
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `orchestrator.ts`:

```ts
import type { LlmVerdict } from "../types.ts";
import type { HarnessRunArgs, HarnessRunDeps, HarnessSession } from "./types.ts";
import { buildRepoAgentTools, createFsRepoCapabilities } from "../agent/tools/repo-tools.ts";
import { runPrepare } from "./prepare.ts";
import { runScan } from "./scan.ts";
import { runValidate } from "./validate.ts";

export async function runHarness(args: HarnessRunArgs, session: HarnessSession, deps: HarnessRunDeps): Promise<LlmVerdict[]> {
  const caps = createFsRepoCapabilities(args.repoDir, { ...(deps.sastRunner ? { sast: deps.sastRunner } : {}), ...(deps.reachability ? { reachability: deps.reachability } : {}) });
  const tools = buildRepoAgentTools(caps);

  const prep = await runPrepare({ files: args.files, ...(args.rawFindings ? { rawFindings: args.rawFindings } : {}), reconLlm: session.models.recon, maxAuditors: deps.opts.maxAuditors });
  const candidates = await runScan({ units: prep.units, files: args.files, candidates: prep.candidates, threatModelMd: prep.threatModelMd, session, tools, opts: deps.opts, ...(args.rulesMd !== undefined ? { rulesMd: args.rulesMd } : {}) });
  if (candidates.length === 0) return [];
  return await runValidate({ candidates, files: args.files, session, tools, opts: deps.opts });
}
```

- [ ] **Step 4: Run — PASS. Run full harness dir** `bun test server/src/review/harness/` → all green. **Commit** `feat(harness): orchestrator sequencing Prepare→Scan→Validate`

---

## Task 12: Engine integration (deep-mode harness branch)

**Files:**
- Modify: `server/src/review/engine.ts` (RunReviewDeps ~85-120; deep branch ~276-285)
- Test: `server/src/review/engine.test.ts` (extend)

- [ ] **Step 1: Failing test** (harness dep chosen in deep mode; downstream score still computed; fast mode unaffected):

```ts
// server/src/review/engine.test.ts — add
import type { HarnessRunner } from "./harness/types.ts";

test("deep mode uses deps.harness when present + repoDir, and scores its verdicts", async () => {
  const harness: HarnessRunner = { run: async () => ([{ filePath: "a.ts", startLine: 1, isVulnerability: true, category: "SQLi", cwe: ["CWE-89"], rationaleMd: "r", reachable: true, confidence: "high", cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" }, title: "SQLi" }] as never) };
  const llm = { complete: async () => "{}" };
  const res = await runReview(
    { kind: "whitebox", files: [{ path: "a.ts", status: "added", contents: "x" }], repoDir: "/repo", mode: "deep" },
    { llm: llm as never, harness },
  );
  expect(res.findings.length).toBe(1);
  expect(res.score0to5).toBeLessThan(5); // a high-sev finding lowers the score
});

test("deep mode without harness falls back to runResearch (no throw)", async () => {
  const llm = { complete: async () => JSON.stringify({ summary: "", verdicts: [] }) };
  const res = await runReview({ kind: "whitebox", files: [{ path: "a.ts", status: "added", contents: "x" }], mode: "deep" }, { llm: llm as never });
  expect(res).toBeDefined(); // runResearch path still works
});
```

- [ ] **Step 2: Run — FAIL** (deps.harness unknown).
- [ ] **Step 3: Implement** — add to `RunReviewDeps` (after the `agent?` block):

```ts
  readonly harness?: import("./harness/types.ts").HarnessRunner;
```
and replace the deep branch (engine.ts:279-285) with:

```ts
if (input.mode === "deep") {
  if (deps.harness && input.repoDir) {
    verdicts = await deps.harness.run({
      files: input.files,
      repoDir: input.repoDir,
      ...(rawFindings.length > 0 ? { rawFindings } : {}),
      ...(input.rulesMd !== undefined ? { rulesMd: input.rulesMd } : {}),
    });
  } else {
    verdicts = await runResearch(
      input.files, deps.llm,
      deps.researchBudget ? { budget: deps.researchBudget } : undefined,
    );
  }
}
```
(`rawFindings` is already in scope from the SAST gather above the branch. Confirm with `grep -n "rawFindings" engine.ts` that it's defined before line 276; if it's only defined inside the else branch, hoist the SAST gather above the `if (input.mode === "deep")`.)

- [ ] **Step 4: Run — PASS. Run** `bunx tsc --noEmit` → 0. **Commit** `feat(engine): harness as deep-mode verdict source (drop-in for runResearch)`

---

## Task 13: Handler + server wiring

**Files:**
- Modify: `server/src/jobs/handlers/whitebox-scan.ts`, `server/src/server.ts`
- Test: `server/src/jobs/handlers/whitebox-scan.test.ts` (extend)

- [ ] **Step 1: Failing test** — handler builds a harness runner per review for deep mode and threads `reachability` into `runReview`. Use the handler's existing test harness (fake `service`/`fetcher`); inject a fake `harness.makeSession` + a spy `reachability`:

```ts
// whitebox-scan.test.ts — add
test("deep review with harness dep runs the harness runner", async () => {
  let harnessRan = false;
  const makeSession = () => ({ models: {}, modelNames: {}, budget: { assertWithin() {} }, counterpointDistinct: true } as never);
  const deps = makeBaseDeps(); // existing test factory: service+fetcher+llm+cloneUrlFor
  const handler = createWhiteboxScanHandler({
    ...deps,
    deepResearchAllowed: true,
    harness: {
      makeSession,
      opts: { maxAuditors: 12, auditorMaxRounds: 4, debateMaxRounds: 3 },
      makeRunner: (_session) => ({ run: async () => { harnessRan = true; return []; } }),
    },
  });
  await handler(/* jobId */ "j1", /* payload for a mode:"deep" review */ deepPayload);
  expect(harnessRan).toBe(true);
});
```
(Use the file's existing fakes/fixtures; `deepPayload` is a review whose row has `mode: "deep"`.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement handler** — extend `WhiteboxScanHandlerDeps`:

```ts
  readonly reachability?: ReachabilityClient;
  readonly harness?: {
    makeSession: () => HarnessSession;
    makeRunner: (session: HarnessSession) => HarnessRunner;
    opts: HarnessOptions;
  };
```
(import `ReachabilityClient` from `../../review/reachability/joern.ts`; `HarnessSession`/`HarnessRunner`/`HarnessOptions` from `../../review/harness/types.ts`.)

In the handler body, after `const deep = ...` (whitebox-scan.ts:135), build the harness runner and pass `harness` + `reachability` into the `runReview` deps object:

```ts
const useHarness = deep && deps.harness && checkout.repoDir !== undefined;
const harnessRunner = useHarness ? deps.harness!.makeRunner(deps.harness!.makeSession()) : undefined;

const result = await runReview(
  {
    kind: "whitebox",
    files: checkout.files,
    ...(checkout.repoDir !== undefined ? { repoDir: checkout.repoDir } : {}),
    ...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
    ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
    ...(deep ? { mode: "deep" as const } : {}),
  },
  {
    llm: reviewLlm,
    ...(deps.sastRunner ? { sastRunner: deps.sastRunner } : {}),
    ...(deps.reachability ? { reachability: deps.reachability } : {}),
    ...(researchBudget ? { researchBudget } : {}),
    ...(harnessRunner ? { harness: harnessRunner } : {}),
  },
);
```
(The `makeRunner` indirection keeps the handler testable without importing `runHarness`; `server.ts` wires `makeRunner = (s) => ({ run: (a) => runHarness(a, s, { sastRunner, reachability, opts }) })`.)

- [ ] **Step 4: Implement server wiring** (`server.ts`, near the whitebox handler block ~1179): build a Joern client and the harness config, gated:

```ts
import { createJoernClient } from "./review/reachability/joern.ts";
import { buildHarnessModels } from "./review/harness/models.ts";
import { runHarness } from "./review/harness/orchestrator.ts";
import { createBudget } from "./exploit/budget.ts";

const joernClient = createJoernClient(); // out-of-process; degrades to {} if `joern` absent

const harnessConfig =
  config.TENSOL_HARNESS_ENABLED && config.TENSOL_RESEARCH_ENABLED && config.TENSOL_REVIEW_LLM_API_KEY
    ? {
        makeSession: () =>
          buildHarnessModels({
            apiKey: config.TENSOL_REVIEW_LLM_API_KEY,
            baseUrl: config.TENSOL_REVIEW_LLM_BASE_URL,
            auditorModel: config.TENSOL_HARNESS_MODEL_AUDITOR,
            debaterModel: config.TENSOL_HARNESS_MODEL_DEBATER,
            counterpointModel: config.TENSOL_HARNESS_MODEL_COUNTERPOINT,
            reconModel: config.TENSOL_HARNESS_MODEL_RECON,
            budget: createBudget({
              ceilingUsd: config.TENSOL_HARNESS_BUDGET_USD,
              usdPerMTokOut: config.TENSOL_HARNESS_USD_PER_MTOK_OUT,
              usdPerMTokIn: config.TENSOL_HARNESS_USD_PER_MTOK_IN,
            }),
          }),
        makeRunner: (session: HarnessSession) => ({
          run: (a: HarnessRunArgs) =>
            runHarness(a, session, {
              sastRunner: reviewSastRunner,
              reachability: joernClient,
              opts: {
                maxAuditors: config.TENSOL_HARNESS_MAX_AUDITORS,
                auditorMaxRounds: config.TENSOL_HARNESS_AUDITOR_MAX_ROUNDS,
                debateMaxRounds: config.TENSOL_HARNESS_DEBATE_MAX_ROUNDS,
              },
            }),
        }),
        opts: {
          maxAuditors: config.TENSOL_HARNESS_MAX_AUDITORS,
          auditorMaxRounds: config.TENSOL_HARNESS_AUDITOR_MAX_ROUNDS,
          debateMaxRounds: config.TENSOL_HARNESS_DEBATE_MAX_ROUNDS,
        },
      }
    : undefined;

if (config.TENSOL_HARNESS_ENABLED && !harnessConfig) {
  console.warn("[tensol] harness enabled but prerequisites missing (TENSOL_RESEARCH_ENABLED + review LLM key) — whitebox deep falls back to runResearch.");
}
```
then add to the `createWhiteboxScanHandler({ ... })` call:
```ts
        reachability: joernClient,
        ...(harnessConfig ? { harness: harnessConfig } : {}),
```
(import `HarnessSession`/`HarnessRunArgs` types at top.)

- [X] **Step 5: Run** `bun test server/src/jobs/handlers/whitebox-scan.test.ts` → 4 pass / 0 fail; `bunx tsc -p server/tsconfig.json --noEmit` → PASS / 0 errors. Follow-up full backend checkpoint: `bun run --cwd server test` → 2017 pass / 1 skip / 0 fail.
- [ ] **Step 6: Commit** `feat(harness): wire harness + Joern reachability into whitebox deep mode`

---

## Task 14: Full-suite + tsc checkpoint

- [ ] **Step 1:** `cd server && bunx tsc --noEmit` → expect 0 errors.
- [ ] **Step 2:** `cd server && bun test` → expect the full suite green (floor ~1894/0; new harness tests add to the count, 0 fail).
- [ ] **Step 3 (frontend types untouched, but verify nothing imported broke):** `cd apps/site && bunx tsc --noEmit` if the harness exposed any wire change (it does not — no migration) → expect 0.
- [ ] **Step 4: Commit** (if any test-only fixups) `test(harness): full-suite green checkpoint`

---

## Task 15: Real-model E2E

**Files:**
- Create: `server/scripts/e2e-harness.ts` (model on `server/scripts/e2e-zeroday.ts`)

- [ ] **Step 1:** Resolve a valid counterpoint model id at runtime: `GET https://openrouter.ai/api/v1/models` with the key; pick an independent SOTA (non-OpenAI, non-qwen) that is available (e.g. a current Gemini or Claude id). Log the chosen id.
- [ ] **Step 2:** Script flow (no test framework — a runnable script, exits non-zero on failure):
  1. Read `OPENROUTER_API_KEY` (fail fast if unset).
  2. Clone `Ageree/sthrip-review-testbed` to a temp dir (the testbed has known vulns + 1 decoy).
  3. Build a real `HarnessSession` via `buildHarnessModels` (real `createOpenRouterClient`, budget ceiling `2.0`).
  4. Build `runHarness` deps with the real `CompositeSastRunner` + `createJoernClient()` (Joern degrades gracefully if absent).
  5. Run `runHarness({ files, repoDir }, session, { sastRunner, reachability, opts })`.
  6. Assert: ≥ (N-1)/N planted vulns recalled; the decoy is NOT in survivors (FP control); at least one finding shows a `## Multi-model debate` section; `session.budget.spentUsd()` > 0 and ≤ 2.0 (≈$0 spend ⇒ short-circuit ⇒ FAIL, per the user's standard).
  7. Print a summary table (recall, FP, spend, per-role token usage, contested count) and exit 0/1.
- [ ] **Step 3: Run** `OPENROUTER_API_KEY=… bun server/scripts/e2e-harness.ts` and capture the report. Spend ≤ ~$2.
- [ ] **Step 4: Commit** `test(harness): real-model E2E vs sthrip-review-testbed`

---

## Self-Review (run after writing — completed inline)

**Spec coverage:** Prepare (T6), Scan/auditors (T7–T8), Validate/debaters multi-model (T9–T10), Dedup (engine `verdictToFinding` — unchanged, reached via T12), Prove (Joern wired T13 + Exploit Lab hook already in handler), multi-model ensemble (T5), gating/flags (T1), real tests (T15), independent review (post-impl, not a code task). ✓

**Placeholder scan:** every code step has real code; the only deploy-time-resolved value is the counterpoint model id, resolved live in T15 with a documented `""`→auditor fallback (T5). ✓

**Type consistency:** `HarnessRunner.run(HarnessRunArgs)`, `HarnessSession`, `HarnessOptions`, `CandidateFinding` (extends `LlmVerdict` + `auditorLens`), `DebateResult` used identically across T2/T5/T7–T13. `runHarness(args, session, deps)` signature matches the engine's `deps.harness.run` (engine calls only `.run`, server's `makeRunner` closes over `session`+`deps`). Verdict output shape flows through `parseReviewVerdicts` (guaranteed by reusing `buildReviewPrompt`). ✓

**One open item flagged for implementation:** confirm `rawFindings` is in scope above engine.ts:276 (hoist the SAST gather if not) — noted in T12 Step 3.

---

## Post-implementation (not code tasks — per project workflow)

- **Independent-context review:** ≥3 fresh-context subagents (Code Reviewer, Security Engineer, a real-OpenRouter E2E verifier running the actual harness modules), then fix found issues (≤2 rounds, then ship with a backlog). [[feedback_verify_agentic_with_independent_subagents_real_model]]
- **Commit/push:** only on the user's request. `gitnexus_detect_changes({scope:"staged"})` pre-commit.
