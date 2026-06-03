/**
 * 005-whitebox-mdash — Stage 3: Validate.
 *
 * Runs the multi-model debate over every candidate in parallel, drops refuted
 * findings, and returns the survivors as plain `LlmVerdict[]` (the `auditorLens`
 * tag is stripped) so they flow into the engine's deterministic dedup/verify/
 * score path. Budget exhaustion or a debate error keeps the finding rather than
 * silently discarding evidence — but at a tempered confidence.
 */
import type { DiffFile, LlmVerdict } from "../types.ts";
import type { AgentTool } from "../agent/loop.ts";
import type { CandidateFinding, HarnessSession, HarnessOptions } from "./types.ts";
import { debate } from "./debate.ts";

function strip(finding: CandidateFinding): LlmVerdict {
  const { auditorLens: _auditorLens, ...verdict } = finding;
  return verdict;
}

export async function runValidate(args: {
  candidates: CandidateFinding[];
  files: DiffFile[];
  session: HarnessSession;
  tools: AgentTool[];
  opts: HarnessOptions;
}): Promise<LlmVerdict[]> {
  const results = await Promise.all(
    args.candidates.map(async (finding): Promise<LlmVerdict | null> => {
      try {
        args.session.budget.assertWithin();
      } catch {
        // Budget exhausted → keep un-debated at the auditor's ORIGINAL confidence.
        // Failure to debate is not evidence against a flagged finding; demoting it
        // here would silently drop a real (possibly critical) finding from the
        // scored set. (Mirrors selfChallenge, which keeps verdicts unchanged when
        // the second pass can't run.)
        return strip(finding);
      }
      try {
        const r = await debate({
          finding,
          files: args.files,
          session: args.session,
          tools: args.tools,
          maxRounds: args.opts.debateMaxRounds,
        });
        // r.finding spreads the CandidateFinding, so strip the auditorLens tag
        // to return a plain LlmVerdict (preserving the debate-adjusted fields).
        return r.survived ? strip(r.finding as CandidateFinding) : null;
      } catch {
        // Debate transport error (a flake) → keep the finding at its original
        // confidence rather than demoting it out of the scored set. A transport
        // failure is not a refutation.
        return strip(finding);
      }
    }),
  );
  return results.filter((v): v is LlmVerdict => v !== null);
}
