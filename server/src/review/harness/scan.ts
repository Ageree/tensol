/**
 * 005-whitebox-mdash — Stage 2: Scan.
 *
 * Spawns specialized AUDITOR sub-agents in parallel — one per detected lens —
 * ranked by summed attack-surface priority and capped at `maxAuditors`. Each
 * auditor is fault-isolated (a throwing/failed auditor degrades to no findings
 * rather than aborting the scan) and budget-gated. Overlapping auditors are
 * pre-deduped by (file|line|category) before the Validate stage.
 */
import type { DiffFile, Candidate } from "../types.ts";
import type { AgentTool } from "../agent/loop.ts";
import type { ExpertKey } from "../research/types.ts";
import type { AttackSurfaceUnit, CandidateFinding, HarnessSession, HarnessOptions } from "./types.ts";
import { runAuditor } from "./auditor.ts";

const dedupKey = (f: CandidateFinding) => `${f.filePath}|${f.startLine ?? "?"}|${f.category.toLowerCase()}`;

export async function runScan(args: {
  units: AttackSurfaceUnit[];
  files: DiffFile[];
  candidates: Candidate[];
  threatModelMd: string;
  session: HarnessSession;
  tools: AgentTool[];
  opts: HarnessOptions;
  rulesMd?: string;
}): Promise<CandidateFinding[]> {
  const byLens = new Map<ExpertKey, AttackSurfaceUnit[]>();
  for (const u of args.units) {
    const arr = byLens.get(u.lens) ?? [];
    arr.push(u);
    byLens.set(u.lens, arr);
  }
  let lenses = [...byLens.entries()]
    .sort(
      (a, b) =>
        b[1].reduce((s, u) => s + u.priority, 0) - a[1].reduce((s, u) => s + u.priority, 0),
    )
    .slice(0, args.opts.maxAuditors)
    .map(([lens]) => lens);

  // Recall safety: if recon detected no routing units but there ARE candidates
  // to audit (e.g. SAST hits or whole files recon's patterns didn't tag), spawn
  // one generalist auditor so the file is never silently skipped.
  if (lenses.length === 0 && args.candidates.length > 0) {
    lenses = ["insecure-design"];
  }

  const results = await Promise.all(
    lenses.map(async (lens): Promise<CandidateFinding[]> => {
      try {
        args.session.budget.assertWithin();
      } catch {
        return [];
      }
      try {
        return await runAuditor({
          lens,
          units: byLens.get(lens) ?? [],
          files: args.files,
          candidates: args.candidates,
          threatModelMd: args.threatModelMd,
          transport: args.session.models.auditor,
          tools: args.tools,
          maxRounds: args.opts.auditorMaxRounds,
          budget: args.session.budget,
          ...(args.rulesMd !== undefined ? { rulesMd: args.rulesMd } : {}),
        });
      } catch {
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const out: CandidateFinding[] = [];
  for (const f of results.flat()) {
    const k = dedupKey(f);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
