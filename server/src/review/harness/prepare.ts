/**
 * 005-whitebox-mdash — Stage 1: Prepare.
 *
 * Deterministic recon (candidates + routing units) + a deterministic,
 * git-recency-aware threat model + a best-effort cheap-model threat summary.
 * Produces the seeds the Scan auditors fan out over.
 */
import type { DiffFile, RawFinding, Candidate } from "../types.ts";
import type { LlmClient } from "../reviewer.ts";
import type { AttackSurfaceUnit } from "./types.ts";
import { deriveCandidates } from "../candidates.ts";
import { buildRoutingUnits } from "../research/recon.ts";
import { buildThreatModel, runReconPass } from "./threat-model.ts";

export interface PrepareResult {
  candidates: Candidate[];
  units: AttackSurfaceUnit[];
  threatModelMd: string;
}

export async function runPrepare(args: {
  files: DiffFile[];
  rawFindings?: RawFinding[];
  reconLlm: LlmClient;
  gitRecency?: Record<string, number>;
  maxAuditors: number;
}): Promise<PrepareResult> {
  const rawFindings = args.rawFindings ?? [];
  const candidates = deriveCandidates({ files: args.files, rawFindings });
  const routing = buildRoutingUnits(args.files);
  const units = buildThreatModel({
    units: routing,
    rawFindings,
    ...(args.gitRecency ? { gitRecency: args.gitRecency } : {}),
    // Keep more units than auditors so lens grouping has signal to rank over.
    maxUnits: Math.max(args.maxAuditors * 4, 24),
  });
  const summary = `Files: ${args.files.map((f) => f.path).join(", ")}\nHotspots: ${units
    .slice(0, 20)
    .map((u) => `${u.filePath}:${u.line} (${u.lens})`)
    .join("; ")}`;
  const threatModelMd = await runReconPass(args.reconLlm, summary);
  return { candidates, units, threatModelMd };
}
