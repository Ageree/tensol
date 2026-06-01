/**
 * Deep Whitebox Research — TASK 1.6: the pipeline orchestrator.
 *
 * Composes the four LLM/deterministic research stages into one async function
 * that turns changed files into `LlmVerdict[]` — the SAME shape the engine's
 * fast path emits, so the EXISTING deterministic scoring + fingerprinting +
 * result assembly (score.ts / fingerprint.ts / engine.ts) is reused unchanged:
 *
 *   files ──recon(det)──▶ RoutingUnit[] ──routing(LLM)──▶ Scenario[]
 *     ──experts(LLM, fan-out)──▶ ScenarioResult[] ──▶ FindingCandidate[]
 *     ──triage(LLM)──▶ TriageDecision[] ──▶ LlmVerdict[]
 *
 * Robustness contract (mirrors the leaf modules): never throws on bad model
 * output. An empty routing-unit inventory short-circuits to `[]` WITHOUT
 * calling the LLM. Each expert run is wrapped in try/catch so one expert's
 * transport/throw cannot abort the whole fan-out — a throw is treated as a
 * `rejected` result (no candidate, no verdict).
 *
 * Reachability mapping: a verdict is `reachable` iff its source scenario result
 * is `verified` OR any of its proof obligations is `proven_vulnerable` — the
 * deterministic evidence of an end-to-end exploit path.
 *
 * Confidence mapping: triage emits high/medium/low; a `verified`-status source
 * result lifts the verdict confidence to "verified" (triage never emits it).
 *
 * Determinism: pure over the injected `LlmClient` — no clock, no RNG, no I/O of
 * its own beyond the leaf modules' cached prompt-file reads and the injected
 * transport. Inputs are never mutated.
 */
import type { DiffFile, LlmVerdict } from "../types.ts";
import type { LlmClient } from "../reviewer.ts";
import { buildRoutingUnits } from "./recon.ts";
import { routeScenarios } from "./routing.ts";
import { runExpert, type ExpertContext } from "./experts/index.ts";
import { triage } from "./triage.ts";
import type {
  FindingCandidate,
  ScenarioResult,
  TriageDecision,
} from "./types.ts";

/**
 * Optional run options. `budget.assertWithin()` is invoked once per scenario
 * before its expert fans out; it may throw to abort the run when a token/time
 * budget is exceeded (that throw is the caller's concern and propagates).
 */
export interface RunResearchOptions {
  budget?: { assertWithin(): void };
}

/** Triage decisions that may materialize a final finding. */
const ACCEPTING_DECISIONS: ReadonlySet<TriageDecision["decision"]> =
  new Set<TriageDecision["decision"]>(["accepted", "downgraded"]);

/**
 * Readable source for an expert to analyze, derived from a `DiffFile`:
 *   1. the full `contents` when present (richest);
 *   2. otherwise reconstruct from `patch` — drop hunk headers (`@@`) and removed
 *      (`-`) lines, then strip the leading `+`/` ` diff marker. For a whole-file
 *      added-diff (how `repo-fetch`/`fileToDiffFile` encode whitebox files, and
 *      what the engine's deep path receives) this recovers the ENTIRE file; for
 *      a PR hunk it yields the post-change added + context lines.
 *   3. otherwise "".
 *
 * Without this, patch-only files (the production whitebox case — `repo-fetch`
 * sets `patch`, never `contents`) reach every expert as an EMPTY file, so deep
 * research finds nothing. Recon already tolerates either field; this aligns the
 * expert context with it.
 */
export function fileSourceText(f: DiffFile): string {
  if (typeof f.contents === "string" && f.contents.length > 0) return f.contents;
  if (typeof f.patch === "string" && f.patch.length > 0) {
    return f.patch
      .split("\n")
      .filter((l) => !l.startsWith("@@") && !l.startsWith("-"))
      .map((l) => (l.startsWith("+") || l.startsWith(" ") ? l.slice(1) : l))
      .join("\n");
  }
  return "";
}

/** Zero-pad a 1-based sequence number to a minimum 3-digit "F###" suffix. */
function findingSeq(seq: number): string {
  return "F" + String(seq).padStart(3, "0");
}

/**
 * True when the scenario result is an end-to-end proven exploit path: either
 * its overall status is `verified`, or at least one proof obligation is
 * `proven_vulnerable`.
 */
function isReachable(result: ScenarioResult): boolean {
  return (
    result.status === "verified" ||
    result.proofObligations.some((p) => p.status === "proven_vulnerable")
  );
}

/**
 * Render a candidate's `rationaleMd`: the expert summary followed by one line
 * per proof obligation (status + summary). Pure string assembly.
 */
function buildRationale(result: ScenarioResult): string {
  const obligationLines = result.proofObligations.map(
    (p) => `- ${p.id} (${p.status}): ${p.summary}`,
  );
  return obligationLines.length > 0
    ? `${result.summary}\n\n${obligationLines.join("\n")}`
    : result.summary;
}

/**
 * Promote one `verified`/`candidate` scenario result to a `FindingCandidate`.
 * The location (filePath/startLine) comes from the FIRST evidence item; when no
 * evidence is present, the scenario's own target path is used as a fallback so a
 * candidate always carries a concrete file.
 */
function toCandidate(
  result: ScenarioResult,
  candidateId: string,
): FindingCandidate {
  const firstEvidence = result.evidence[0];
  const filePath = firstEvidence?.path ?? "";
  const title = result.primaryVulnerabilityClass ?? result.summary;

  const base: FindingCandidate = {
    candidateId,
    scenarioId: result.scenarioId,
    expert: result.expert,
    title,
    cwe: result.cwe,
    cvss: result.cvss,
    rationaleMd: buildRationale(result),
    evidence: result.evidence,
    filePath,
  };

  const startLine =
    firstEvidence !== undefined && typeof firstEvidence.line === "number"
      ? firstEvidence.line
      : undefined;

  return {
    ...base,
    ...(result.primaryVulnerabilityClass !== undefined
      ? { primaryVulnerabilityClass: result.primaryVulnerabilityClass }
      : {}),
    ...(startLine !== undefined ? { startLine } : {}),
  };
}

/**
 * Map an accepted/downgraded candidate to a final `LlmVerdict`, lifting
 * confidence to "verified" when the source scenario result was verified.
 * Optional fields are OMITTED (not set to `undefined`) for
 * `exactOptionalPropertyTypes`.
 */
function toVerdict(
  candidate: FindingCandidate,
  decision: TriageDecision,
  result: ScenarioResult,
): LlmVerdict {
  const confidence =
    result.status === "verified" ? "verified" : decision.finalConfidence;

  const base: LlmVerdict = {
    candidateId: candidate.candidateId,
    filePath: candidate.filePath,
    isVulnerability: true,
    category: candidate.primaryVulnerabilityClass ?? candidate.title,
    cwe: candidate.cwe,
    rationaleMd: candidate.rationaleMd,
    reachable: isReachable(result),
    confidence,
    cvss: candidate.cvss,
    title: candidate.title,
  };

  return {
    ...base,
    ...(candidate.startLine !== undefined
      ? { startLine: candidate.startLine }
      : {}),
    ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
  };
}

/**
 * Run the full deep-research pipeline over a set of changed files.
 *
 * @param files changed files (PR diff or whitebox repo files).
 * @param llm   the injected transport (fakeable for tests).
 * @param opts  optional run options (token/time budget guard).
 * @returns one `LlmVerdict` per accepted/downgraded finding. An empty routing
 *   inventory returns `[]` WITHOUT calling the LLM.
 */
export async function runResearch(
  files: DiffFile[],
  llm: LlmClient,
  opts?: RunResearchOptions,
): Promise<LlmVerdict[]> {
  // 1. Deterministic recon — no LLM. No points of interest -> nothing to do.
  const units = buildRoutingUnits(files);
  if (units.length === 0) return [];

  // 2. LLM router — fan routing units out into scoped scenarios.
  const scenarios = await routeScenarios(units, llm);
  if (scenarios.length === 0) return [];

  // 3. Expert fan-out. Build a read-only file context once (path + contents).
  const ctx: ExpertContext = {
    files: files.map((f) => ({ path: f.path, content: fileSourceText(f) })),
  };

  const results = await Promise.all(
    scenarios.map(async (scenario): Promise<ScenarioResult> => {
      opts?.budget?.assertWithin();
      try {
        return await runExpert(scenario, ctx, llm);
      } catch {
        // A throwing expert (transport error, etc.) must not abort the run —
        // treat it as a rejected result with a benign default CVSS vector.
        return {
          scenarioId: scenario.id,
          expert: scenario.expert,
          status: "rejected",
          summary: "expert run failed",
          evidence: [],
          proofObligations: [],
          cwe: [],
          cvss: {
            AV: "N",
            AC: "H",
            PR: "H",
            UI: "R",
            S: "U",
            C: "N",
            I: "N",
            A: "N",
          },
        };
      }
    }),
  );

  // 4. Promote verified/candidate results to triage-pending candidates. Track
  //    each candidate's source result so reachability/confidence can be mapped.
  const candidates: FindingCandidate[] = [];
  const resultByCandidateId = new Map<string, ScenarioResult>();
  for (const result of results) {
    if (result.status !== "verified" && result.status !== "candidate") {
      continue;
    }
    const candidateId = `${result.scenarioId}-${findingSeq(1)}`;
    candidates.push(toCandidate(result, candidateId));
    resultByCandidateId.set(candidateId, result);
  }
  if (candidates.length === 0) return [];

  // 5. Independent triage — only accepted/downgraded decisions materialize.
  const decisions = await triage(candidates, llm);
  const candidateById = new Map<string, FindingCandidate>(
    candidates.map((c) => [c.candidateId, c]),
  );

  const verdicts: LlmVerdict[] = [];
  for (const decision of decisions) {
    if (!ACCEPTING_DECISIONS.has(decision.decision)) continue;
    const candidate = candidateById.get(decision.candidateId);
    const result = resultByCandidateId.get(decision.candidateId);
    if (candidate === undefined || result === undefined) continue;
    verdicts.push(toVerdict(candidate, decision, result));
  }

  return verdicts;
}
