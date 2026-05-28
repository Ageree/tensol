/**
 * 003-whitebox — review engine orchestrator.
 *
 * Composes the leaf modules into one pipeline shared by both sub-products:
 *
 *   (SAST candidates) ─┐
 *                      ├─► deriveCandidates ─► buildContextBundle ─► LLM review
 *   (changed hunks) ───┘                                                  │
 *                                                                         ▼
 *               deterministic scoring (CVSS) + fingerprint ─► ReviewResult
 *
 * The LLM judge emits a decomposed CVSS vector + reachability + confidence; the
 * deterministic scorer (`score.ts`) computes the numeric severity and the 0-5
 * merge-readiness — the model never sets the number (anti reward-hacking).
 *
 * All external effects (LLM, SAST shell-out) are injected, so the whole engine
 * is unit-testable with fakes and has no network/process dependency in tests.
 */
import { deriveCandidates } from "./candidates.ts";
import { buildContextBundle } from "./context/repomap.ts";
import { fingerprint } from "./fingerprint.ts";
import { review, type LlmClient } from "./reviewer.ts";
import type { SastRunner } from "./sast/runner.ts";
import {
  cvssBaseScore,
  overallScore0to5,
  severityFromScore,
  vectorToString,
} from "./score.ts";
import type {
  Candidate,
  DiffFile,
  LlmVerdict,
  RawFinding,
  ReviewFinding,
  ReviewKind,
  ReviewResult,
} from "./types.ts";

export interface RunReviewInput {
  readonly kind: ReviewKind;
  readonly files: DiffFile[];
  /** Pre-computed SAST findings (optional — engine can also run a SastRunner). */
  readonly rawFindings?: RawFinding[];
  /** Repo custom rules (`.tensol/rules.md` / `.hacktron/rules.md` equivalent). */
  readonly rulesMd?: string;
  /** Filesystem path to a checked-out repo; required to run the SAST runner. */
  readonly repoDir?: string;
  readonly tokenBudget?: number;
}

export interface RunReviewDeps {
  readonly llm: LlmClient;
  /** Optional SAST runner; when present + repoDir set, its findings are merged. */
  readonly sastRunner?: SastRunner;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/** Convert one LLM verdict into a scored, fingerprinted finding. */
function verdictToFinding(
  v: LlmVerdict,
  candidateSnippet: string | undefined,
): ReviewFinding {
  const cvssScore = cvssBaseScore(v.cvss);
  const severity = severityFromScore(cvssScore);
  const cvssVector = vectorToString(v.cvss);
  const fp = fingerprint({
    cwe: v.cwe ?? [],
    filePath: v.filePath,
    ...(candidateSnippet !== undefined ? { snippet: candidateSnippet } : {}),
    category: v.category,
  });
  return {
    fingerprint: fp,
    filePath: v.filePath,
    ...(v.startLine !== undefined ? { startLine: v.startLine } : {}),
    ...(v.endLine !== undefined ? { endLine: v.endLine } : {}),
    side: "RIGHT",
    severity,
    cwe: v.cwe ?? [],
    cvssVector,
    cvssScore,
    confidence: v.confidence,
    reachable: v.reachable,
    category: v.category,
    title: v.title,
    rationaleMd: v.rationaleMd,
    ...(v.pocMd !== undefined ? { pocMd: v.pocMd } : {}),
    ...(v.fixPromptMd !== undefined ? { fixPromptMd: v.fixPromptMd } : {}),
    source: "llm",
  };
}

/** Build a deterministic, human-readable summary from the findings. */
function buildSummary(findings: ReviewFinding[], score: number): string {
  if (findings.length === 0) {
    return `## Sthrip Review — ${score}/5 ✅\n\nNo security findings in the reviewed changes.`;
  }
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const order = ["critical", "high", "medium", "low", "informational"];
  const countLine = order
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
  const top = [...findings]
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
    )
    .slice(0, 10)
    .map((f) => {
      const loc = f.startLine ? `${f.filePath}:${f.startLine}` : f.filePath;
      return `- **${f.severity}** — ${f.title} (\`${loc}\`)`;
    })
    .join("\n");
  return `## Sthrip Review — ${score}/5\n\n${findings.length} finding(s): ${countLine}.\n\n${top}`;
}

/**
 * De-duplicate findings WITHIN one review, keeping the first occurrence.
 *
 * Keyed on (fingerprint + startLine), NOT fingerprint alone: the fingerprint is
 * intentionally line-INVARIANT (so it stays stable across re-reviews as code
 * shifts — that's what `review_threads` keys on for cross-review dedup). But
 * within a single review, two DISTINCT vulnerabilities of the same class in the
 * same file (e.g. two separate SQLi sinks at different lines) share a
 * fingerprint and would otherwise be collapsed into one — a silent
 * true-positive loss. Including the line distinguishes them here while leaving
 * the line-shift-tolerant cross-review dedup (poster `alreadyPosted`) intact.
 */
function dedupeByFingerprint(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    const key = `${f.fingerprint}:${f.startLine ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Run the full review pipeline. Pure w.r.t. injected deps — no I/O of its own.
 */
export async function runReview(
  input: RunReviewInput,
  deps: RunReviewDeps,
): Promise<ReviewResult> {
  // 1. Gather SAST findings (provided + optionally run a runner).
  let rawFindings: RawFinding[] = input.rawFindings ? [...input.rawFindings] : [];
  if (deps.sastRunner && input.repoDir) {
    const sastFindings = await deps.sastRunner.run({ repoDir: input.repoDir });
    rawFindings = [...rawFindings, ...sastFindings];
  }

  // 2. Derive candidates from diff hunks + SAST hits.
  const candidates = deriveCandidates({ files: input.files, rawFindings });
  if (candidates.length === 0) {
    return {
      kind: input.kind,
      score0to5: 5,
      summaryMd: buildSummary([], 5),
      findings: [],
    };
  }

  // 3. Build the token-budgeted context bundle.
  const context = buildContextBundle({
    files: input.files,
    candidates,
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
  });

  // 4. LLM judge (generator≠judge boundary lives at the model layer).
  const verdicts = await review({
    context,
    candidates,
    llm: deps.llm,
    ...(input.rulesMd !== undefined ? { rulesMd: input.rulesMd } : {}),
  });

  // 5. Deterministic scoring + fingerprinting.
  const candById = new Map<string, Candidate>(
    candidates.map((c) => [c.id, c]),
  );
  const findings = dedupeByFingerprint(
    verdicts.map((v) =>
      verdictToFinding(
        v,
        v.candidateId ? candById.get(v.candidateId)?.snippet : undefined,
      ),
    ),
  );

  const score0to5 = overallScore0to5(findings);
  return {
    kind: input.kind,
    score0to5,
    summaryMd: buildSummary(findings, score0to5),
    findings,
  };
}
