/**
 * 005-whitebox-mdash — Prepare-stage threat model (deterministic) + recon pass.
 *
 * `buildThreatModel` deterministically assigns each recon `RoutingUnit` to an
 * OWASP lens (via its fine-grained `kind`) and a 0..1 priority weighted by
 * signal density, SAST corroboration, and optional git recency. Correctness
 * never depends on a model here. `runReconPass` is a best-effort cheap-model
 * threat-model summary injected into auditor prompts (so the recon model
 * genuinely contributes context without gating correctness).
 */
import type { RawFinding } from "../types.ts";
import type { RoutingUnit } from "../research/types.ts";
import type { LlmClient } from "../reviewer.ts";
import type { AttackSurfaceUnit } from "./types.ts";
import { LENS_BY_KIND } from "./lenses.ts";

export function buildThreatModel(args: {
  units: RoutingUnit[];
  rawFindings: RawFinding[];
  gitRecency?: Record<string, number>;
  maxUnits: number;
}): AttackSurfaceUnit[] {
  const sastFiles = new Set(args.rawFindings.map((f) => f.filePath));
  const scored = args.units.map((u): AttackSurfaceUnit => {
    const lens = LENS_BY_KIND[u.kind] ?? "insecure-design";
    const recency = args.gitRecency?.[u.filePath] ?? 0;
    const signalScore = Math.min(1, u.signals.length / 4);
    const sastBoost = sastFiles.has(u.filePath) ? 0.3 : 0;
    const priority = Math.min(1, 0.4 * signalScore + 0.3 * recency + sastBoost);
    return {
      id: u.id,
      lens,
      filePath: u.filePath,
      line: u.line,
      snippet: u.snippet,
      signals: u.signals,
      priority,
    };
  });
  return scored.sort((a, b) => b.priority - a.priority).slice(0, args.maxUnits);
}

/** Best-effort cheap-model threat-model summary. Returns "" on any failure. */
export async function runReconPass(reconLlm: LlmClient, repoSummary: string): Promise<string> {
  try {
    const md = await reconLlm.complete({
      system:
        "You are a security recon assistant. Given a repo summary, produce a SHORT markdown threat model: entry points, trust boundaries, and the highest-risk areas. <= 200 words. No code fences.",
      user: repoSummary,
    });
    return typeof md === "string" ? md.slice(0, 4000) : "";
  } catch {
    return "";
  }
}
