/**
 * 005-whitebox-mdash — harness orchestrator.
 *
 * Sequences MDASH stages 1–3 (Prepare → Scan → Validate) and emits
 * `LlmVerdict[]` — a DROP-IN for `runResearch`. The engine then realizes MDASH
 * stages 4–5 (Dedup via fingerprinting, Prove via Joern reachability + the
 * gated Exploit Lab) over these verdicts with its existing deterministic moat.
 */
import type { LlmVerdict } from "../types.ts";
import type { HarnessRunArgs, HarnessRunDeps, HarnessSession } from "./types.ts";
import { buildRepoAgentTools, createFsRepoCapabilities } from "../agent/tools/repo-tools.ts";
import { runPrepare } from "./prepare.ts";
import { runScan } from "./scan.ts";
import { runValidate } from "./validate.ts";

export async function runHarness(
  args: HarnessRunArgs,
  session: HarnessSession,
  deps: HarnessRunDeps,
): Promise<LlmVerdict[]> {
  const caps = createFsRepoCapabilities(args.repoDir, {
    ...(deps.sastRunner ? { sast: deps.sastRunner } : {}),
    ...(deps.reachability ? { reachability: deps.reachability } : {}),
  });
  const tools = buildRepoAgentTools(caps);

  const prep = await runPrepare({
    files: args.files,
    ...(args.rawFindings ? { rawFindings: args.rawFindings } : {}),
    reconLlm: session.models.recon,
    maxAuditors: deps.opts.maxAuditors,
  });

  const candidates = await runScan({
    units: prep.units,
    files: args.files,
    candidates: prep.candidates,
    threatModelMd: prep.threatModelMd,
    session,
    tools,
    opts: deps.opts,
    ...(args.rulesMd !== undefined ? { rulesMd: args.rulesMd } : {}),
  });
  if (candidates.length === 0) return [];

  return runValidate({ candidates, files: args.files, session, tools, opts: deps.opts });
}
