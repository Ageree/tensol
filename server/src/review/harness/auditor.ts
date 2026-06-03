/**
 * 005-whitebox-mdash — Stage 2 sub-agent: a specialized AUDITOR.
 *
 * Reuses the EXACT review prompt + strict-JSON parse gate as the fixed reviewer
 * (so verdicts flow through the identical downstream deterministic moat), but
 * runs as a tool-using `runAgentLoop` over repo-scoped tools and prepends a
 * lens directive + the recon threat model. The model investigates reachability
 * with tools, then emits the same strict JSON as a plain final message.
 */
import type { DiffFile, Candidate } from "../types.ts";
import type { ChatTransport, AgentTool, LoopBudget } from "../agent/loop.ts";
import type { ExpertKey } from "../research/types.ts";
import type { AttackSurfaceUnit, CandidateFinding } from "./types.ts";
import { buildContextBundle } from "../context/repomap.ts";
import { buildReviewPrompt, parseReviewVerdicts } from "../reviewer.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { LENS_DIRECTIVE, REPO_TOOL_PROTOCOL } from "./lenses.ts";

export async function runAuditor(args: {
  lens: ExpertKey;
  units: AttackSurfaceUnit[];
  files: DiffFile[];
  candidates: Candidate[];
  threatModelMd: string;
  transport: ChatTransport;
  tools: AgentTool[];
  maxRounds: number;
  maxToolCalls?: number;
  budget?: LoopBudget;
  rulesMd?: string;
}): Promise<CandidateFinding[]> {
  const context = buildContextBundle({ files: args.files, candidates: args.candidates });
  const prompt = buildReviewPrompt({
    context,
    candidates: args.candidates,
    ...(args.rulesMd !== undefined ? { rulesMd: args.rulesMd } : {}),
  });
  const threat = args.threatModelMd ? `\n\nTHREAT MODEL (recon):\n${args.threatModelMd}` : "";
  const systemPrompt = `${LENS_DIRECTIVE[args.lens]}\n\n${prompt.system}${threat}`;
  const result = await runAgentLoop({
    transport: args.transport,
    messages: [
      { role: "system", content: `${systemPrompt}\n\n${REPO_TOOL_PROTOCOL}` },
      { role: "user", content: prompt.user },
    ],
    tools: args.tools,
    maxRounds: args.maxRounds,
    ...(args.maxToolCalls !== undefined ? { maxToolCalls: args.maxToolCalls } : {}),
    ...(args.budget ? { budget: args.budget } : {}),
  });

  // The loop returns finalContent=null on `max_rounds`/`budget` and the in-flight
  // tool-requesting turn (not the verdict JSON) on `max_tool_calls` — either way
  // parseReviewVerdicts yields []. A tool-heavy lens that exhausts its cap mid-
  // investigation would then silently report ZERO findings. Salvage one final
  // no-tools emit from the ORIGINAL prompt (a clean one-shot — no dangling tool
  // calls to replay), budget permitting, so the lens still reports.
  let finalContent = result.finalContent;
  if (result.stopReason !== "final") {
    try {
      args.budget?.assertWithin();
      const salvage = await args.transport.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt.user },
          {
            role: "user",
            content:
              "Stop investigating. Based on the candidates and context above, emit your FINAL verdicts NOW as the strict JSON object specified — a plain assistant message, no tool calls, no prose.",
          },
        ],
      });
      finalContent = salvage.content;
    } catch {
      // Over budget or transport error on salvage → keep whatever we had (may be []).
    }
  }

  return parseReviewVerdicts(finalContent)
    .filter((v) => v.isVulnerability)
    .map((v) => ({ ...v, auditorLens: args.lens }));
}
