/**
 * 005-whitebox-mdash — Stage 3 core: multi-model adversarial DEBATE.
 *
 * MDASH validates each candidate with "debaters" on DIFFERENT models — model
 * disagreement is the credibility signal: "when an auditor flags something as
 * suspect and the debater can't refute it, that finding's posterior credibility
 * goes up." R1 = cheap refuter; R2 = independent SOTA counterpoint, run only on
 * R1 survivors (cost control). Refuters are tool-using so they can verify
 * reachability before deciding. The outcome is folded into `confidence` + a
 * `## Multi-model debate` markdown section (no schema change).
 */
import type { DiffFile, LlmVerdict, Confidence } from "../types.ts";
import type { ChatTransport, AgentTool, LoopBudget } from "../agent/loop.ts";
import type { CandidateFinding, DebateResult, HarnessSession } from "./types.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { REFUTE_PROTOCOL } from "./lenses.ts";

interface RefuteVote {
  refuted: boolean;
  confidence: "high" | "low";
  reasonMd: string;
}

/** Confidence ordering (mirrors verify.ts) — used to never DEMOTE on the agree-agree path. */
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2, verified: 3 };
function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

function parseRefute(raw: string | null): RefuteVote {
  if (!raw) return { refuted: false, confidence: "low", reasonMd: "(no response)" };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { refuted: false, confidence: "low", reasonMd: "(unparseable)" };
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      refuted: o.refuted === true,
      confidence: o.confidence === "high" ? "high" : "low",
      reasonMd: typeof o.reason_md === "string" ? o.reason_md : "",
    };
  } catch {
    return { refuted: false, confidence: "low", reasonMd: "(unparseable)" };
  }
}

async function refuteWith(
  transport: ChatTransport,
  finding: LlmVerdict,
  tools: AgentTool[],
  maxRounds: number,
  modelLabel: string,
  budget?: LoopBudget,
): Promise<RefuteVote> {
  const claim = [
    "CLAIMED VULNERABILITY (by another model):",
    `- file: ${finding.filePath}:${finding.startLine ?? "?"}`,
    `- category: ${finding.category} (${finding.cwe.join(", ")})`,
    `- rationale: ${finding.rationaleMd}`,
    `- reachable (claimed): ${finding.reachable}`,
    `- title: ${finding.title}`,
  ].join("\n");
  try {
    const res = await runAgentLoop({
      transport,
      messages: [
        { role: "system", content: REFUTE_PROTOCOL },
        { role: "user", content: claim },
      ],
      tools,
      maxRounds,
      // Thread the shared per-scan budget so a debate self-aborts mid-loop when
      // the ceiling is hit (auditors already do this via scan.ts). Without it the
      // most expensive stage ran unbudgeted and the USD ceiling was unenforced.
      ...(budget ? { budget } : {}),
    });
    return parseRefute(res.finalContent);
  } catch {
    return { refuted: false, confidence: "low", reasonMd: `(${modelLabel} debate errored — abstaining)` };
  }
}

export async function debate(args: {
  finding: CandidateFinding;
  files: DiffFile[];
  session: HarnessSession;
  tools: AgentTool[];
  maxRounds: number;
}): Promise<DebateResult> {
  const { finding, session } = args;

  const r1 = await refuteWith(
    session.models.debater,
    finding,
    args.tools,
    args.maxRounds,
    session.modelNames.debater,
    session.budget,
  );
  if (r1.refuted && r1.confidence === "high") {
    return { finding, credibility: 0.0, survived: false };
  }

  const r2 = await refuteWith(
    session.models.counterpoint,
    finding,
    args.tools,
    args.maxRounds,
    session.modelNames.counterpoint,
    session.budget,
  );

  let credibility: number;
  let confidence: Confidence;
  let contested = false;
  if (!r2.refuted) {
    // Neither independent model could refute ⇒ corroboration, never a reason to
    // LOWER the auditor's confidence. Take the MAX of the auditor's original and
    // the debate-assigned value so the validator only holds-or-raises on the
    // agree-agree path. (Previously the non-distinct default unconditionally set
    // "medium", silently demoting a real un-refuted finding to unverified →
    // excluded from the 0-5 score.)
    credibility = session.counterpointDistinct ? 0.9 : 0.65;
    confidence = maxConfidence(finding.confidence, session.counterpointDistinct ? "high" : "medium");
  } else {
    contested = true;
    credibility = 0.45;
    confidence = "low";
  }
  if (r1.refuted) {
    // R1 refuted at low confidence (high would have dropped above) — temper the posterior.
    credibility = Math.min(credibility, 0.5);
    confidence = "low";
  }

  const debateMd = [
    "\n\n## Multi-model debate",
    `- **Auditor** (${session.modelNames.auditor}): flagged as ${finding.category}.`,
    `- **Refuter R1** (${session.modelNames.debater}): ${
      r1.refuted ? `refuted (${r1.confidence}) — ${r1.reasonMd}` : "could not refute."
    }`,
    `- **Counterpoint R2** (${session.modelNames.counterpoint}${
      session.counterpointDistinct ? "" : ", = auditor model"
    }): ${r2.refuted ? `refuted — ${r2.reasonMd}` : "could not refute."}`,
    contested
      ? "- **Verdict: CONTESTED** — models disagree on exploitability; confidence downgraded."
      : `- **Verdict:** credibility ${(credibility * 100).toFixed(0)}%.`,
  ].join("\n");

  return {
    finding: { ...finding, confidence, rationaleMd: `${finding.rationaleMd}${debateMd}` },
    credibility,
    survived: true,
  };
}
