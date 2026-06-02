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
import { runResearch } from "./research/orchestrator.ts";
import { review, selfChallenge, type LlmClient } from "./reviewer.ts";
import type { ReachabilityClient } from "./reachability/joern.ts";
import { verifyFindings } from "./verify.ts";
import {
  applyRulesMd,
  applySuppressions,
  NEVER_SUPPRESS,
  parseRulesMd,
} from "./learning.ts";
import type { SastRunner } from "./sast/runner.ts";
import {
  cvssBaseScore,
  overallScore0to5,
  severityFromScore,
  vectorToString,
} from "./score.ts";
import type {
  Candidate,
  Confidence,
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
  /**
   * Review depth. "fast" (default) runs the single-pass candidate reviewer;
   * "deep" runs the multi-agent research pipeline (recon → routing → experts →
   * triage) to obtain verdicts. Both feed the SAME deterministic downstream
   * (scoring + fingerprinting + result assembly). Omitting it preserves the
   * exact fast-mode behavior for existing callers.
   */
  readonly mode?: "fast" | "deep";
  /**
   * Confidence floor for the trust gate (T046). When set, an adversarial
   * self-challenge pass runs over the verdicts BEFORE scoring: verdicts below
   * the floor are dropped, and the LLM is asked to refute each remaining one
   * (refuted → dropped). Omitted → no self-challenge pass (back-compat).
   */
  readonly confidenceFloor?: Confidence;
  /**
   * Categories the repo has suppressed (derived from the learning loop). The
   * engine filters findings in these categories — but NEVER security/correctness
   * (a hard invariant re-enforced here as defense in depth).
   */
  readonly suppressedCategories?: ReadonlySet<string>;
}

export interface RunReviewDeps {
  readonly llm: LlmClient;
  /** Optional SAST runner; when present + repoDir set, its findings are merged. */
  readonly sastRunner?: SastRunner;
  /**
   * Optional spend meter for DEEP mode (F1). When present, it is threaded into
   * the research pipeline and `assertWithin()` is consulted once per scenario so
   * a deep run is COST-BOUNDED. The caller is responsible for metering `llm`
   * (e.g. wrapping it with `createMeteredClient`) so this budget actually
   * accumulates. Ignored in fast mode. Without it, deep mode runs UNBOUNDED.
   */
  readonly researchBudget?: { assertWithin(): void };
  /**
   * Optional reachability adapter (e.g. Joern). When present + repoDir set, it
   * is run over the scored findings; proven taint paths upgrade a finding to
   * `verified` and attach `reachabilityEvidenceMd`. MUST degrade gracefully —
   * a `{}` result simply leaves findings un-upgraded.
   */
  readonly reachability?: ReachabilityClient;
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
 * Findings that gate the merge-readiness score: a finding counts only when it
 * is `verified` OR carries no `verificationStatus` (legacy / verify did not
 * run). `unverified` and `refuted` findings are surfaced in the result but must
 * NOT drive the 0-5 score — that is what "score on the verified set" means.
 */
function scoringSet(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter(
    (f) =>
      f.verificationStatus === undefined || f.verificationStatus === "verified",
  );
}

/**
 * Build the suppressed-category set that the engine will actually apply.
 *
 * Combines caller-provided suppressions with NEVER_SUPPRESS removal: even if a
 * caller (buggy or malicious) lists `security`/`correctness`, those are stripped
 * here so a security finding can never be filtered out (FR-024, defense in depth).
 */
function effectiveSuppressed(
  suppressed: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (!suppressed || suppressed.size === 0) return new Set<string>();
  const out = new Set<string>();
  for (const cat of suppressed) {
    if (!NEVER_SUPPRESS.has(cat)) out.add(cat);
  }
  return out;
}

/**
 * Run the full review pipeline. Pure w.r.t. injected deps — no I/O of its own.
 *
 * Trust upgrades (T046): after the LLM verdicts and BEFORE scoring, an
 * adversarial self-challenge pass (gated by `confidenceFloor`) drops refuted /
 * below-floor verdicts. After deterministic scoring, an optional reachability
 * adapter attaches taint-path evidence, the verification gate labels every
 * finding (`verified` / `unverified` / `refuted`), and learned suppressions +
 * `.sthrip` rules filter the noisy classes (never security/correctness). The
 * 0-5 score is computed over the VERIFIED set; the full labelled finding list
 * is returned so the service persists everything and the poster filters.
 */
export async function runReview(
  input: RunReviewInput,
  deps: RunReviewDeps,
): Promise<ReviewResult> {
  // 1. Gather SAST findings (provided + optionally run a runner). The fast path
  // uses them as candidates; both paths use them as verification evidence.
  let rawFindings: RawFinding[] = input.rawFindings
    ? [...input.rawFindings]
    : [];
  if (deps.sastRunner && input.repoDir) {
    const sastFindings = await deps.sastRunner.run({ repoDir: input.repoDir });
    rawFindings = [...rawFindings, ...sastFindings];
  }

  // 2. Obtain LLM verdicts. Deep mode uses the multi-agent research pipeline;
  // fast mode derives candidates from hunks + SAST hits and runs one review pass.
  let verdicts: LlmVerdict[];
  let candById = new Map<string, Candidate>();

  if (input.mode === "deep") {
    verdicts = await runResearch(
      input.files,
      deps.llm,
      deps.researchBudget ? { budget: deps.researchBudget } : undefined,
    );
    // Deep-mode verdicts carry research candidateIds ("S001-F001"), which never
    // collide with fast-path candidate ids — there is no snippet map to join.
  } else {
    const candidates = deriveCandidates({ files: input.files, rawFindings });
    if (candidates.length === 0) {
      return {
        kind: input.kind,
        score0to5: 5,
        summaryMd: buildSummary([], 5),
        findings: [],
      };
    }

    const context = buildContextBundle({
      files: input.files,
      candidates,
      ...(input.tokenBudget !== undefined
        ? { tokenBudget: input.tokenBudget }
        : {}),
    });

    verdicts = await review({
      context,
      candidates,
      llm: deps.llm,
      ...(input.rulesMd !== undefined ? { rulesMd: input.rulesMd } : {}),
    });

    candById = new Map<string, Candidate>(candidates.map((c) => [c.id, c]));
  }

  // 4b. Adversarial self-challenge — only when a confidence floor is set.
  // Drops verdicts below the floor + any the LLM can refute. Runs BEFORE
  // scoring so the deterministic scorer never sees a refuted finding.
  if (input.confidenceFloor !== undefined) {
    verdicts = await selfChallenge({
      verdicts,
      llm: deps.llm,
      confidenceFloor: input.confidenceFloor,
    });
  }

  // 5. Deterministic scoring + fingerprinting (shared by both modes).
  let findings = dedupeByFingerprint(
    verdicts.map((v) =>
      verdictToFinding(
        v,
        v.candidateId ? candById.get(v.candidateId)?.snippet : undefined,
      ),
    ),
  );

  // 6. Suppressions + `.sthrip` rules filtering (style/nit classes only — the
  // effectiveSuppressed() guard guarantees security/correctness survive).
  const suppressed = effectiveSuppressed(input.suppressedCategories);
  if (suppressed.size > 0) {
    findings = applySuppressions(findings, suppressed);
  }
  if (input.rulesMd !== undefined) {
    findings = applyRulesMd(findings, parseRulesMd(input.rulesMd));
  }

  // 7. Optional reachability analysis over the scored, fingerprinted findings.
  // The adapter is keyed by fingerprint and degrades to {} when unavailable.
  let reachable: Record<string, { reachable: boolean; evidenceMd?: string }> = {};
  if (deps.reachability && input.repoDir) {
    reachable = await deps.reachability.analyze({
      repoDir: input.repoDir,
      findings,
    });
  }

  // 8. Verification gate — label every finding (verified/unverified/refuted)
  // and attach reachability evidence. This is the set the service persists.
  const verified = verifyFindings({
    findings,
    rawFindings,
    reachable,
    ...(input.confidenceFloor !== undefined
      ? { confidenceFloor: input.confidenceFloor }
      : {}),
  });

  // 9. Score over the VERIFIED set only; surface the full labelled list.
  const score0to5 = overallScore0to5(scoringSet(verified));
  return {
    kind: input.kind,
    score0to5,
    summaryMd: buildSummary(scoringSet(verified), score0to5),
    findings: verified,
  };
}
