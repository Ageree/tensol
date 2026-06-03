/**
 * 005-whitebox-mdash — MDASH-style multi-model agentic harness: stage I/O types.
 *
 * The harness rebuilds whitebox DEEP mode as the MDASH pipeline
 *   Prepare → Scan (auditors) → Validate (debaters)
 * and emits `LlmVerdict[]` — a DROP-IN for `runResearch` — so the engine's
 * existing deterministic moat (dedup/fingerprint, Joern reachability, verify
 * gate, score.ts) realizes MDASH's Dedup + Prove stages unchanged.
 *
 * Multi-model: each role gets its own metered `LlmClient`/`ChatTransport` over
 * ONE shared per-scan budget (auditor=SOTA, debater=cheap, counterpoint=2nd
 * independent SOTA). Generator ≠ Judge is preserved — models emit decomposed
 * CVSS + confidence, never the 0–5 number.
 */
import type { DiffFile, LlmVerdict, RawFinding } from "../types.ts";
import type { ChatTransport, LoopBudget } from "../agent/loop.ts";
import type { LlmClient } from "../reviewer.ts";
import type { ReachabilityClient } from "../reachability/joern.ts";
import type { SastRunner } from "../sast/runner.ts";
import type { ExpertKey } from "../research/types.ts";

export type HarnessRole = "recon" | "auditor" | "debater" | "counterpoint" | "triage";

export interface HarnessModels {
  readonly recon: LlmClient; // cheap, complete()
  readonly auditor: ChatTransport; // SOTA, tool-loop
  readonly debater: ChatTransport; // cheap, tool-loop (R1 refuter)
  readonly counterpoint: ChatTransport; // 2nd SOTA (R2); === auditor when unset
  readonly triage: LlmClient; // cheap, complete()
}

export interface HarnessModelNames {
  readonly auditor: string;
  readonly debater: string;
  readonly counterpoint: string; // resolved (may equal auditor)
  readonly recon: string;
}

export interface HarnessSession {
  readonly models: HarnessModels;
  readonly modelNames: HarnessModelNames;
  readonly budget: LoopBudget; // shared per-scan ceiling
  readonly counterpointDistinct: boolean; // false → counterpoint fell back to auditor model
}

export interface AttackSurfaceUnit {
  readonly id: string;
  readonly lens: ExpertKey;
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly signals: string[];
  readonly priority: number; // 0..1, signal + SAST + (optional) git-recency weighted
}

export interface CandidateFinding extends LlmVerdict {
  readonly auditorLens: string; // which auditor produced it
}

export interface DebateResult {
  readonly finding: LlmVerdict; // confidence-adjusted; debate appended to rationaleMd
  readonly credibility: number; // 0..1 posterior
  readonly survived: boolean; // false → refuted, drop
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

/** The object the engine receives as `deps.harness`. */
export interface HarnessRunner {
  run(args: HarnessRunArgs): Promise<LlmVerdict[]>;
}
