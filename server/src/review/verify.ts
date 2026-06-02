/**
 * verify.ts — the verification gate (T031).
 *
 * Pure, deterministic, no I/O. Maps raw findings + reachability evidence
 * onto each ReviewFinding's VerificationStatus.
 *
 * Logic (from contract):
 *   verified  iff: sastCorroborated
 *                  || reachabilityProven
 *                  || (confidence ∈ {verified,high} && !pocRefuted)
 *   refuted   iff: pocRefuted && !sastCorroborated && !reachabilityProven
 *   else unverified
 *
 * Only 'verified' findings are posted (engine responsibility — the gate
 * just labels; caller decides what to do with unverified/refuted).
 */

import type { ReviewFinding, RawFinding } from "./types.ts";

// Re-export the type so engine.ts can import from here
export type { VerificationStatus } from "./types.ts";

export interface VerifyInput {
  finding: ReviewFinding;
  /** A SAST/secrets/SCA RawFinding overlaps this finding's file+line/class. */
  sastCorroborated: boolean;
  /** Reachability adapter proved a taint path. */
  reachabilityProven: boolean;
  /** Self-challenge refuted the PoC. */
  pocRefuted: boolean;
}

import type { VerificationStatus } from "./types.ts";

/**
 * Classify a single finding.
 * Frozen signature — engine.ts wires this.
 */
export function classifyVerification(input: VerifyInput): VerificationStatus {
  const { finding, sastCorroborated, reachabilityProven, pocRefuted } = input;

  // verified wins over refuted when corroboration exists
  if (sastCorroborated || reachabilityProven) {
    return "verified";
  }

  if (pocRefuted) {
    return "refuted";
  }

  if (finding.confidence === "verified" || finding.confidence === "high") {
    return "verified";
  }

  return "unverified";
}

// ---------------------------------------------------------------------------
// Confidence ordering — used by the floor filter
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  verified: 3,
};

function confidenceRank(c: string): number {
  return CONFIDENCE_ORDER[c] ?? 0;
}

// ---------------------------------------------------------------------------
// SAST corroboration check
// ---------------------------------------------------------------------------

/**
 * Returns true if any RawFinding overlaps the given ReviewFinding by:
 *   - same filePath + same startLine, OR
 *   - same filePath + at least one shared CWE
 */
function isSastCorroborated(finding: ReviewFinding, rawFindings: RawFinding[]): boolean {
  for (const raw of rawFindings) {
    if (raw.filePath !== finding.filePath) continue;

    // line overlap
    if (
      finding.startLine !== undefined &&
      raw.startLine !== undefined &&
      raw.startLine === finding.startLine
    ) {
      return true;
    }

    // CWE overlap
    if (finding.cwe.length > 0 && raw.cwe && raw.cwe.length > 0) {
      const findingCweSet = new Set(finding.cwe);
      for (const cwe of raw.cwe) {
        if (findingCweSet.has(cwe)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// verifyFindings — batch mapper
// ---------------------------------------------------------------------------

/**
 * Map rawFindings→sastCorroboration by file+line/CWE overlap, apply the
 * reachable map (keyed by fingerprint), honor confidenceFloor, and return
 * each finding with verificationStatus (+ reachabilityEvidenceMd from the
 * reachable map).
 *
 * Frozen signature — engine.ts wires this.
 */
export function verifyFindings(args: {
  findings: ReviewFinding[];
  rawFindings: RawFinding[];
  /** keyed by fingerprint; {} when degraded */
  reachable?: Record<string, { reachable: boolean; evidenceMd?: string }>;
  confidenceFloor?: "verified" | "high" | "medium" | "low";
}): Array<ReviewFinding & { verificationStatus: VerificationStatus; reachabilityEvidenceMd?: string }> {
  const { findings, rawFindings, reachable = {}, confidenceFloor = "low" } = args;
  const floorRank = confidenceRank(confidenceFloor);

  const results: Array<ReviewFinding & { verificationStatus: VerificationStatus; reachabilityEvidenceMd?: string }> = [];

  for (const finding of findings) {
    // Apply confidence floor — skip findings below the threshold
    if (confidenceRank(finding.confidence) < floorRank) {
      continue;
    }

    const sastCorroborated = isSastCorroborated(finding, rawFindings);

    const reachEntry = reachable[finding.fingerprint];
    const reachabilityProven = reachEntry?.reachable === true;
    const evidenceMd = reachEntry?.evidenceMd;

    // pocRefuted: in the verifyFindings context there is no self-challenge
    // result here — that is done upstream (engine/reviewer). At this level
    // pocRefuted=false since we don't have the self-challenge output yet.
    // The engine calls classifyVerification directly when it has the full
    // pocRefuted signal; verifyFindings is the batch path without it.
    const pocRefuted = false;

    const verificationStatus = classifyVerification({
      finding,
      sastCorroborated,
      reachabilityProven,
      pocRefuted,
    });

    const result: ReviewFinding & { verificationStatus: VerificationStatus; reachabilityEvidenceMd?: string } = {
      ...finding,
      verificationStatus,
      ...(evidenceMd !== undefined ? { reachabilityEvidenceMd: evidenceMd } : {}),
    };

    results.push(result);
  }

  return results;
}
