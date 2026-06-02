/**
 * FP-benchmark harness — T036
 *
 * Measures false-positive rate of two pipelines over a mixed benchmark corpus:
 *   1. "LLM-only"  — raw LLM verdicts, no SAST corroboration, no reachability
 *                    gate, no self-challenge.
 *   2. "Verified"  — full runReview pipeline: SAST corroboration + Joern
 *                    reachability + verifyFindings gate.
 *
 * The benchmark corpus contains:
 *   - GENUINE findings: real, reachable vulnerabilities the LLM correctly flags.
 *     Their fingerprints appear in both the FakeJoernClient map and the SAST
 *     raw-findings list.  They should survive in BOTH pipelines.
 *   - DECOY findings: benign code that a "noisy" LLM model wrongly flags. They
 *     are NOT in the joern map and NOT corroborated by SAST, so the verified
 *     pipeline should suppress them.
 *
 * Success criterion (SC-004): the verified pipeline's FP rate is ≥ 50% lower
 * than the LLM-only FP rate.
 *
 * The test uses FakeLlmClient + FakeJoernClient (+ FakeSastRunner) so the
 * whole run is deterministic and network/process-free.
 */
import { test, expect, describe } from "bun:test";
import { runReview, type RunReviewInput, type RunReviewDeps } from "../engine.ts";
import { FakeLlmClient } from "../reviewer.ts";
import { FakeJoernClient } from "../reachability/joern.ts";
import { FakeSastRunner } from "../sast/runner.ts";
import { fingerprint } from "../fingerprint.ts";
import type { DiffFile, RawFinding, CvssVector } from "../types.ts";

// ---------------------------------------------------------------------------
// Benchmark corpus
// ---------------------------------------------------------------------------

/**
 * Each entry describes one code location.
 *
 * `isGenuine` = true  → LLM flags it AND the verification oracle confirms it.
 * `isGenuine` = false → LLM flags it (noisy model), but the verification oracle
 *                       does NOT confirm it (SAST-miss + not reachable).
 */
interface CorpusEntry {
  filePath: string;
  startLine: number;
  category: string;
  cwe: string[];
  /** Confidence the noisy LLM reports for this verdict. */
  confidence: "verified" | "high" | "medium" | "low";
  /** cvss for high-impact genuine vs low-impact decoy */
  cvss: CvssVector;
  isGenuine: boolean;
  snippet: string;
}

const CORPUS: CorpusEntry[] = [
  // ------ GENUINE (reachable, SAST-corroborated) ------
  {
    filePath: "src/db.ts",
    startLine: 14,
    category: "SQL Injection",
    cwe: ["CWE-89"],
    confidence: "high",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
    isGenuine: true,
    snippet: 'const sql = "SELECT * FROM users WHERE id = " + req.query.id;',
  },
  {
    filePath: "src/auth.ts",
    startLine: 42,
    category: "Hardcoded Credential",
    cwe: ["CWE-798"],
    confidence: "verified",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "N", A: "N" },
    isGenuine: true,
    snippet: 'const SECRET = "hunter2";',
  },
  {
    filePath: "src/upload.ts",
    startLine: 7,
    category: "Path Traversal",
    cwe: ["CWE-22"],
    confidence: "high",
    cvss: { AV: "N", AC: "L", PR: "L", UI: "N", S: "U", C: "H", I: "H", A: "N" },
    isGenuine: true,
    snippet: "const dest = path.join(__dirname, req.body.filename);",
  },
  {
    filePath: "src/eval.ts",
    startLine: 3,
    category: "Code Injection",
    cwe: ["CWE-94"],
    confidence: "high",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "C", C: "H", I: "H", A: "H" },
    isGenuine: true,
    snippet: "eval(userInput);",
  },

  // ------ DECOYS (LLM false positives: no SAST corroboration, not reachable) ------
  {
    filePath: "src/utils.ts",
    startLine: 22,
    category: "XSS",
    cwe: ["CWE-79"],
    confidence: "medium",
    cvss: { AV: "N", AC: "L", PR: "N", UI: "R", S: "C", C: "L", I: "L", A: "N" },
    isGenuine: false,
    snippet: 'element.innerHTML = sanitize(userInput); // already sanitized',
  },
  {
    filePath: "src/config.ts",
    startLine: 10,
    category: "Information Disclosure",
    cwe: ["CWE-200"],
    confidence: "low",
    cvss: { AV: "N", AC: "H", PR: "N", UI: "N", S: "U", C: "L", I: "N", A: "N" },
    isGenuine: false,
    snippet: 'const version = process.env.APP_VERSION ?? "unknown";',
  },
  {
    filePath: "src/logger.ts",
    startLine: 5,
    category: "Log Injection",
    cwe: ["CWE-117"],
    confidence: "medium",
    cvss: { AV: "N", AC: "H", PR: "L", UI: "N", S: "U", C: "N", I: "L", A: "N" },
    isGenuine: false,
    snippet: "logger.info(`Request from: ${ip}`); // IP already validated above",
  },
  {
    filePath: "src/crypto.ts",
    startLine: 19,
    category: "Weak Cryptography",
    cwe: ["CWE-327"],
    confidence: "medium",
    cvss: { AV: "N", AC: "H", PR: "N", UI: "N", S: "U", C: "L", I: "N", A: "N" },
    isGenuine: false,
    snippet: 'crypto.createHash("sha256").update(salt + password).digest("hex");',
  },
];

const GENUINE_ENTRIES = CORPUS.filter((e) => e.isGenuine);
const DECOY_ENTRIES = CORPUS.filter((e) => !e.isGenuine);

// ---------------------------------------------------------------------------
// Derive pre-computed fingerprints for the genuine entries
// (needed to prime FakeJoernClient and classify results).
//
// The engine derives fingerprints from (cwe, filePath, category, candidateSnippet).
// For diff-only candidates (no SAST), the candidate object carries no snippet,
// so the engine calls fingerprint() with no snippet field.  We must match that.
// ---------------------------------------------------------------------------

/**
 * Fingerprint as the engine will compute it for a diff-only candidate:
 * no snippet (snippet is only injected when the candidate came from SAST).
 */
function fpForEngine(entry: CorpusEntry): string {
  return fingerprint({
    cwe: entry.cwe,
    filePath: entry.filePath,
    category: entry.category,
    // snippet intentionally omitted — matches engine behavior for diff candidates
  });
}

/**
 * Stable set of genuine-entry fingerprints computed the same way the engine
 * will compute them. Used by both runLlmOnlyPipeline and runVerifiedPipeline
 * to classify findings as TP vs FP.
 */
const GENUINE_FINGERPRINTS: ReadonlySet<string> = new Set(
  GENUINE_ENTRIES.map(fpForEngine),
);

// ---------------------------------------------------------------------------
// Build DiffFile array from the corpus
// ---------------------------------------------------------------------------

function buildDiffFiles(): DiffFile[] {
  // Group entries by filePath to build one DiffFile per file
  const byFile = new Map<string, CorpusEntry[]>();
  for (const entry of CORPUS) {
    const existing = byFile.get(entry.filePath) ?? [];
    byFile.set(entry.filePath, [...existing, entry]);
  }

  const files: DiffFile[] = [];
  for (const [path, entries] of byFile) {
    // Build a minimal patch with each entry's snippet as an added line
    const hunks = entries
      .map(
        (e) =>
          `@@ -${e.startLine - 1},0 +${e.startLine},1 @@\n+${e.snippet}`,
      )
      .join("\n");
    files.push({
      path,
      status: "modified",
      patch: hunks,
      contents: entries.map((e) => e.snippet).join("\n"),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Build the LLM responder — always flags every corpus entry as a vuln
// (simulates a noisy model that generates false positives on decoys)
// ---------------------------------------------------------------------------

function buildNoisyLlmResponder(): (user: string) => string {
  return (_user: string) => {
    const verdicts = CORPUS.map((entry, i) => ({
      candidate_id: `c${i}`,
      file_path: entry.filePath,
      start_line: entry.startLine,
      is_vulnerability: true,
      category: entry.category,
      cwe: entry.cwe,
      rationale_md: `Potential ${entry.category} at ${entry.filePath}:${entry.startLine}`,
      reachable: entry.isGenuine, // LLM "guesses" reachability correctly
      confidence: entry.confidence,
      cvss: entry.cvss,
      title: `${entry.category} in ${entry.filePath}`,
      ...(entry.snippet ? { poc_md: `Snippet: \`${entry.snippet}\`` } : {}),
    }));
    return JSON.stringify({ summary: "Benchmark review", verdicts });
  };
}

// ---------------------------------------------------------------------------
// Build SAST raw findings — only for GENUINE entries (SAST misses decoys)
// ---------------------------------------------------------------------------

function buildSastRawFindings(): RawFinding[] {
  return GENUINE_ENTRIES.map((entry): RawFinding => ({
    ruleId: `sast.${entry.category.replace(/\s+/g, "-").toLowerCase()}`,
    source: "sast",
    filePath: entry.filePath,
    startLine: entry.startLine,
    message: `${entry.category} detected`,
    cwe: entry.cwe,
    snippet: entry.snippet,
  }));
}

// ---------------------------------------------------------------------------
// Build FakeJoernClient — only proves reachability for genuine findings
// ---------------------------------------------------------------------------

/**
 * Build a FakeJoernClient that confirms reachability for every fingerprint
 * in the given set (the genuine findings).
 *
 * The FakeJoernClient's analyze() method filters by the findings array it
 * receives, so passing extra fingerprints for findings that don't appear in
 * the run is harmless — they're simply never matched.
 */
function buildFakeJoernClient(genuineFps: ReadonlySet<string>): FakeJoernClient {
  const cannedMap: Record<string, { reachable: boolean; evidenceMd?: string }> = {};
  for (const fp of genuineFps) {
    cannedMap[fp] = {
      reachable: true,
      evidenceMd: `Taint path confirmed by Joern analysis`,
    };
  }
  return new FakeJoernClient(cannedMap);
}

// ---------------------------------------------------------------------------
// LLM-only pipeline: extract findings from raw LLM output without any gate
// ---------------------------------------------------------------------------

/**
 * Run the engine WITHOUT the verification gate.
 *
 * We achieve "LLM-only" mode by calling runReview with NO reachability adapter,
 * NO SAST runner, and no confidenceFloor (so selfChallenge never runs). The
 * verifyFindings gate still runs but with no SAST corroboration and no
 * reachability map — so "high"/"verified" confidence findings become "verified"
 * via the confidence-only path, while "medium"/"low" become "unverified".
 *
 * To get a PURE LLM-only baseline (all LLM verdicts count regardless of the
 * verification gate), we count ALL findings the engine returns (including
 * unverified ones) — this matches what a system without the gate would post.
 */
async function runLlmOnlyPipeline(): Promise<{
  allFindings: string[]; // fingerprints of all findings
  fpFingerprints: string[]; // fingerprints that are false positives (decoys)
  tpFingerprints: string[]; // fingerprints that are true positives (genuine)
}> {
  const files = buildDiffFiles();
  const llm = new FakeLlmClient(buildNoisyLlmResponder());

  // Run with no verification helpers (no confidenceFloor, no reachability, no SAST)
  const result = await runReview(
    {
      kind: "pr",
      files,
      // No confidenceFloor → no selfChallenge
      // No rawFindings → no SAST corroboration
    } satisfies RunReviewInput,
    {
      llm,
      // No sastRunner, no reachability
    } satisfies RunReviewDeps,
  );

  // In LLM-only mode, we treat ALL returned findings as "posted"
  // (both verified and unverified — without the gate, they'd all surface)
  const allFindings = result.findings.map((f) => f.fingerprint);

  // Classify each finding as TP or FP using the engine-consistent fingerprint set
  const fpFingerprints = allFindings.filter((fp) => !GENUINE_FINGERPRINTS.has(fp));
  const tpFingerprints = allFindings.filter((fp) => GENUINE_FINGERPRINTS.has(fp));

  return { allFindings, fpFingerprints, tpFingerprints };
}

// ---------------------------------------------------------------------------
// Verified pipeline: full runReview with SAST + Joern reachability
// ---------------------------------------------------------------------------

/**
 * Run the full verified pipeline. Findings with verificationStatus === "verified"
 * are the ones the poster would actually post. We use these as the output set.
 */
async function runVerifiedPipeline(): Promise<{
  postedFindings: string[]; // fingerprints of verified findings
  fpFingerprints: string[]; // verified findings that are actually decoys (escaped FPs)
  tpFingerprints: string[]; // verified findings that are genuine
}> {
  const files = buildDiffFiles();
  const llm = new FakeLlmClient(buildNoisyLlmResponder());
  const sastRawFindings = buildSastRawFindings();

  // FakeJoernClient is keyed by the engine-consistent fingerprints (no snippet).
  // GENUINE_FINGERPRINTS is already computed that way — reuse it directly.
  const joernClient = buildFakeJoernClient(GENUINE_FINGERPRINTS);

  const result = await runReview(
    {
      kind: "pr",
      files,
      rawFindings: sastRawFindings,
      repoDir: "/tmp/benchmark-repo",
      confidenceFloor: "medium",
    } satisfies RunReviewInput,
    {
      llm,
      reachability: joernClient,
    } satisfies RunReviewDeps,
  );

  // "Posted" = only findings that passed the verification gate
  const postedFindings = result.findings
    .filter((f) => f.verificationStatus === "verified")
    .map((f) => f.fingerprint);

  const fpFingerprints = postedFindings.filter(
    (fp) => !GENUINE_FINGERPRINTS.has(fp),
  );
  const tpFingerprints = postedFindings.filter((fp) =>
    GENUINE_FINGERPRINTS.has(fp),
  );

  return { postedFindings, fpFingerprints, tpFingerprints };
}

// ---------------------------------------------------------------------------
// Utility: compute false-positive rate
// ---------------------------------------------------------------------------

function fpRate(fpCount: number, totalPosted: number): number {
  if (totalPosted === 0) return 0;
  return fpCount / totalPosted;
}

// ---------------------------------------------------------------------------
// Benchmark test suite
// ---------------------------------------------------------------------------

describe("FP benchmark — verified pipeline vs LLM-only (SC-004)", () => {
  test("corpus sanity: correct genuine/decoy split", () => {
    expect(GENUINE_ENTRIES.length).toBeGreaterThan(0);
    expect(DECOY_ENTRIES.length).toBeGreaterThan(0);
    // SC-004 requires ≥50% reduction, so we need enough decoys to measure it
    expect(DECOY_ENTRIES.length).toBeGreaterThanOrEqual(2);
  });

  test("LLM-only pipeline surfaces ALL corpus entries (genuine + decoys)", async () => {
    const { allFindings, tpFingerprints } = await runLlmOnlyPipeline();

    // The noisy LLM flags everything — at minimum all genuine ones should appear
    // (decoys might get dropped by the confidence floor in verifyFindings, but
    //  LLM-only mode has no floor → they should all be present or filtered by
    //  confidence gate of verifyFindings. Since verifyFindings still runs with
    //  no floor by default, low/medium confidence findings become unverified but
    //  are still returned in result.findings.)
    expect(allFindings.length).toBeGreaterThan(0);
    expect(tpFingerprints.length).toBe(GENUINE_ENTRIES.length);
  });

  test("LLM-only pipeline generates false positives from decoys", async () => {
    const { fpFingerprints } = await runLlmOnlyPipeline();
    // All decoys should appear as FPs in LLM-only mode
    expect(fpFingerprints.length).toBe(DECOY_ENTRIES.length);
  });

  test("verified pipeline posts genuine findings (no true-positive loss)", async () => {
    const { tpFingerprints } = await runVerifiedPipeline();
    // All genuine findings should survive the verification gate
    expect(tpFingerprints.length).toBe(GENUINE_ENTRIES.length);
  });

  test("verified pipeline suppresses decoys (FP reduction)", async () => {
    const { fpFingerprints, postedFindings } = await runVerifiedPipeline();

    // Decoys that are NOT SAST-corroborated and NOT reachable should be filtered.
    // With confidenceFloor="medium" and decoys at confidence="low"/"medium",
    // low-confidence decoys are dropped by the floor; medium-confidence decoys
    // are unverified (no SAST + no reachability → unverified); they are excluded
    // from the "verified" post set.
    expect(fpFingerprints.length).toBeLessThan(DECOY_ENTRIES.length);
    // And we should have actually posted some findings
    expect(postedFindings.length).toBeGreaterThan(0);
  });

  test("SC-004: verified FP rate is ≥50% lower than LLM-only FP rate", async () => {
    // Run both pipelines
    const llmOnly = await runLlmOnlyPipeline();
    const verified = await runVerifiedPipeline();

    const llmOnlyFPRate = fpRate(llmOnly.fpFingerprints.length, llmOnly.allFindings.length);
    const verifiedFPRate = fpRate(verified.fpFingerprints.length, verified.postedFindings.length);

    // Report rates for CI visibility
    const reduction =
      llmOnlyFPRate > 0 ? (llmOnlyFPRate - verifiedFPRate) / llmOnlyFPRate : 1;

    // Log rates for visibility (tests are run in a test harness; this output
    // is the "report" referenced in the task brief). Using process.stdout to
    // comply with the "no console.log in production" rule (this is test code).
    process.stdout.write(
      [
        "",
        "=== FP Benchmark Report ===",
        `  Corpus: ${GENUINE_ENTRIES.length} genuine + ${DECOY_ENTRIES.length} decoys = ${CORPUS.length} total`,
        "",
        `  LLM-only pipeline:`,
        `    total posted : ${llmOnly.allFindings.length}`,
        `    true positives : ${llmOnly.tpFingerprints.length}`,
        `    false positives: ${llmOnly.fpFingerprints.length}`,
        `    FP rate        : ${(llmOnlyFPRate * 100).toFixed(1)}%`,
        "",
        `  Verified pipeline (SAST + Joern + verifyFindings gate):`,
        `    total posted : ${verified.postedFindings.length}`,
        `    true positives : ${verified.tpFingerprints.length}`,
        `    false positives: ${verified.fpFingerprints.length}`,
        `    FP rate        : ${(verifiedFPRate * 100).toFixed(1)}%`,
        "",
        `  FP reduction : ${(reduction * 100).toFixed(1)}% (target ≥50%)`,
        "===========================",
        "",
      ].join("\n"),
    );

    // SC-004 acceptance criterion
    expect(llmOnlyFPRate).toBeGreaterThan(0);
    expect(reduction).toBeGreaterThanOrEqual(0.5);
  });

  test("verified pipeline's genuine findings carry reachabilityEvidenceMd", async () => {
    const files = buildDiffFiles();
    const llm = new FakeLlmClient(buildNoisyLlmResponder());
    const sastRawFindings = buildSastRawFindings();

    // Reuse GENUINE_FINGERPRINTS — already computed with engine-consistent logic
    const joernClient = buildFakeJoernClient(GENUINE_FINGERPRINTS);

    const result = await runReview(
      {
        kind: "pr",
        files,
        rawFindings: sastRawFindings,
        repoDir: "/tmp/benchmark-repo",
        confidenceFloor: "medium",
      },
      { llm, reachability: joernClient },
    );

    const verifiedWithEvidence = result.findings.filter(
      (f) =>
        f.verificationStatus === "verified" &&
        f.reachabilityEvidenceMd !== undefined,
    );

    // At least some genuine verified findings should carry reachability evidence
    expect(verifiedWithEvidence.length).toBeGreaterThan(0);
    expect(verifiedWithEvidence[0]!.reachabilityEvidenceMd).toContain(
      "Taint path confirmed",
    );
  });
});
