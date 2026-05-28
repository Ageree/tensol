/**
 * 003-whitebox — deterministic CVSS 3.1 scoring + merge-readiness rubric.
 *
 * This is the anti reward-hacking core: the LLM emits a DECOMPOSED CVSS vector
 * (objective metrics) + reachability + confidence, and NEVER the final numeric
 * score or severity. This module derives them deterministically:
 *
 *   - `vectorToString`   : canonical "CVSS:3.1/..." string.
 *   - `cvssBaseScore`    : the EXACT CVSS 3.1 base equation (ISS/Impact/
 *                          Exploitability, scope-aware, official roundup).
 *   - `severityFromScore`: CVSS 3.1 qualitative severity rating bands.
 *   - `overallScore0to5` : Greptile-style 0-5 merge readiness (5 = clean),
 *                          worst-severity gating over *counted* findings.
 *
 * All functions are pure and deterministic (no clock / RNG / I/O).
 * Spec & metric constants: CVSS 3.1 specification, §7 (Base Metrics).
 */

import type { CvssVector, Severity, Confidence } from "./types.ts";

/** Numeric weights for each CVSS 3.1 base metric (per the v3.1 spec). */
const AV_VALUES: Record<CvssVector["AV"], number> = {
  N: 0.85,
  A: 0.62,
  L: 0.55,
  P: 0.2,
};
const AC_VALUES: Record<CvssVector["AC"], number> = { L: 0.77, H: 0.44 };
const UI_VALUES: Record<CvssVector["UI"], number> = { N: 0.85, R: 0.62 };
const CIA_VALUES: Record<CvssVector["C"], number> = { N: 0, L: 0.22, H: 0.56 };

/** Order of metrics in the canonical CVSS vector string. */
const VECTOR_ORDER: ReadonlyArray<keyof CvssVector> = [
  "AV",
  "AC",
  "PR",
  "UI",
  "S",
  "C",
  "I",
  "A",
];

/**
 * Privileges Required is scope-dependent: when Scope changes, the values for
 * Low and High privileges increase (it is "easier" to escalate across a
 * boundary), per the v3.1 spec.
 */
function privilegesRequiredValue(
  pr: CvssVector["PR"],
  scope: CvssVector["S"],
): number {
  if (pr === "N") return 0.85;
  if (pr === "L") return scope === "C" ? 0.68 : 0.62;
  // pr === "H"
  return scope === "C" ? 0.5 : 0.27;
}

/**
 * Official CVSS 3.1 "roundup": round a value UP to the nearest 0.1, using the
 * spec's integer arithmetic so floating-point artifacts cannot leak (e.g.
 * 9.799999... rounds to 9.8 exactly, not 9.9).
 */
function roundup(value: number): number {
  const scaled = Math.round(value * 100000);
  if (scaled % 10000 === 0) {
    return scaled / 100000;
  }
  return (Math.floor(scaled / 10000) + 1) / 10;
}

/**
 * Build the canonical CVSS 3.1 vector string, e.g.
 * "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H".
 */
export function vectorToString(v: CvssVector): string {
  const parts = VECTOR_ORDER.map((metric) => `${metric}:${v[metric]}`);
  return ["CVSS:3.1", ...parts].join("/");
}

/**
 * Compute the CVSS 3.1 Base Score (0.0–10.0, rounded up to one decimal).
 *
 * ISC_base   = 1 - ((1-C)*(1-I)*(1-A))
 * Impact     = 6.42 * ISC_base                                   (Scope: U)
 *            = 7.52*(ISC_base-0.029) - 3.25*(ISC_base-0.02)^15   (Scope: C)
 * Exploit    = 8.22 * AV * AC * PR * UI
 * BaseScore  = 0                                if Impact <= 0
 *            = roundup(min(Impact+Exploit,10))  if Scope: U
 *            = roundup(min(1.08*(Impact+Exploit),10)) if Scope: C
 */
export function cvssBaseScore(v: CvssVector): number {
  const iscBase =
    1 - (1 - CIA_VALUES[v.C]) * (1 - CIA_VALUES[v.I]) * (1 - CIA_VALUES[v.A]);

  const impact =
    v.S === "U"
      ? 6.42 * iscBase
      : 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15);

  if (impact <= 0) {
    return 0.0;
  }

  const exploitability =
    8.22 *
    AV_VALUES[v.AV] *
    AC_VALUES[v.AC] *
    privilegesRequiredValue(v.PR, v.S) *
    UI_VALUES[v.UI];

  const raw =
    v.S === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);

  return roundup(raw);
}

/**
 * CVSS 3.1 qualitative severity rating from a base score:
 *   0.0 -> informational (CVSS "None")
 *   0.1–3.9 -> low
 *   4.0–6.9 -> medium
 *   7.0–8.9 -> high
 *   9.0–10.0 -> critical
 */
export function severityFromScore(score: number): Severity {
  if (score <= 0) return "informational";
  if (score < 4.0) return "low";
  if (score < 7.0) return "medium";
  if (score < 9.0) return "high";
  return "critical";
}

/** Confidence levels that "count" toward the merge-readiness gate. */
const COUNTED_CONFIDENCE: ReadonlySet<Confidence> = new Set<Confidence>([
  "verified",
  "high",
  "medium",
]);

/**
 * Whether a finding should gate the merge-readiness score:
 * confidence must be in {verified,high,medium} (undefined -> treated as
 * "medium" and therefore counted) AND reachable must not be explicitly false.
 */
function isCounted(finding: {
  confidence?: Confidence;
  reachable?: boolean;
}): boolean {
  const confidence = finding.confidence ?? "medium";
  if (!COUNTED_CONFIDENCE.has(confidence)) return false;
  if (finding.reachable === false) return false;
  return true;
}

/**
 * Greptile-style merge-readiness, 0–5 where 5 = clean / safe to merge.
 *
 * Worst-severity gating over the COUNTED findings only:
 *   any critical -> 0
 *   else any high -> 2
 *   else any medium -> 3
 *   else any low -> 4
 *   else (none / only informational / all filtered out) -> 5
 */
export function overallScore0to5(
  findings: Array<{
    severity: Severity;
    confidence?: Confidence;
    reachable?: boolean;
  }>,
): number {
  const counted = findings.filter(isCounted);

  if (counted.some((f) => f.severity === "critical")) return 0;
  if (counted.some((f) => f.severity === "high")) return 2;
  if (counted.some((f) => f.severity === "medium")) return 3;
  if (counted.some((f) => f.severity === "low")) return 4;
  return 5;
}
