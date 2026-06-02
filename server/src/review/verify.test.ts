/**
 * Tests for verify.ts — the verification gate (T027).
 *
 * TDD: all tests written BEFORE implementation. Run:
 *   cd server && bun test src/review/verify.test.ts
 */

import { test, expect, describe } from "bun:test";
import { classifyVerification, verifyFindings } from "./verify.ts";
import type { VerifyInput } from "./verify.ts";
import type { ReviewFinding, RawFinding } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers — minimal ReviewFinding factories
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    fingerprint: "aabbccdd11223344",
    filePath: "src/auth.ts",
    side: "RIGHT",
    severity: "high",
    cwe: ["CWE-89"],
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    cvssScore: 9.8,
    confidence: "medium",
    reachable: false,
    category: "SQL Injection",
    title: "User-controlled SQL fragment",
    rationaleMd: "Direct interpolation without parameterization.",
    source: "llm",
    ...overrides,
  };
}

function makeRawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    ruleId: "sql-injection",
    source: "sast",
    filePath: "src/auth.ts",
    startLine: 42,
    message: "SQL injection via string interpolation",
    cwe: ["CWE-89"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyVerification — unit tests
// ---------------------------------------------------------------------------

describe("classifyVerification", () => {
  // ---- refuted path --------------------------------------------------------

  test("refuted when pocRefuted=true, no corroboration, no reachability", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "medium" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: true,
    };
    expect(classifyVerification(input)).toBe("refuted");
  });

  test("refuted when pocRefuted=true even with confidence=high — no corroboration or reachability", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "high" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: true,
    };
    expect(classifyVerification(input)).toBe("refuted");
  });

  // ---- verified path -------------------------------------------------------

  test("verified when sastCorroborated=true, even if pocRefuted=true", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "medium" }),
      sastCorroborated: true,
      reachabilityProven: false,
      pocRefuted: true,
    };
    expect(classifyVerification(input)).toBe("verified");
  });

  test("verified when reachabilityProven=true, even if pocRefuted=true", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "medium" }),
      sastCorroborated: false,
      reachabilityProven: true,
      pocRefuted: true,
    };
    expect(classifyVerification(input)).toBe("verified");
  });

  test("verified when confidence=verified and pocRefuted=false, no SAST/reachability", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "verified" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: false,
    };
    expect(classifyVerification(input)).toBe("verified");
  });

  test("verified when confidence=high and pocRefuted=false", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "high" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: false,
    };
    expect(classifyVerification(input)).toBe("verified");
  });

  test("verified when both sastCorroborated and reachabilityProven", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "low" }),
      sastCorroborated: true,
      reachabilityProven: true,
      pocRefuted: false,
    };
    expect(classifyVerification(input)).toBe("verified");
  });

  // ---- unverified path -----------------------------------------------------

  test("unverified when no SAST, no reachability, confidence=medium, pocRefuted=false", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "medium" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: false,
    };
    expect(classifyVerification(input)).toBe("unverified");
  });

  test("unverified when no SAST, no reachability, confidence=low, pocRefuted=false", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "low" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: false,
    };
    expect(classifyVerification(input)).toBe("unverified");
  });

  // CRITICAL: the task description requires this assertion explicitly
  test("NOT verified when no SAST, no reachability, pocRefuted=true", () => {
    const input: VerifyInput = {
      finding: makeFinding({ confidence: "high" }),
      sastCorroborated: false,
      reachabilityProven: false,
      pocRefuted: true,
    };
    const result = classifyVerification(input);
    expect(result).not.toBe("verified");
    expect(result).toBe("refuted");
  });
});

// ---------------------------------------------------------------------------
// verifyFindings — integration-level tests
// ---------------------------------------------------------------------------

describe("verifyFindings", () => {
  test("finding with overlapping SAST raw finding (same file + line) → verified", () => {
    const finding = makeFinding({ startLine: 42, filePath: "src/auth.ts", cwe: ["CWE-89"] });
    const raw = makeRawFinding({ filePath: "src/auth.ts", startLine: 42, cwe: ["CWE-89"] });

    const results = verifyFindings({ findings: [finding], rawFindings: [raw] });

    expect(results).toHaveLength(1);
    expect(results[0]!.verificationStatus).toBe("verified");
  });

  test("finding with CWE overlap (no line match) → verified via CWE corroboration", () => {
    const finding = makeFinding({ startLine: 42, filePath: "src/auth.ts", cwe: ["CWE-89"] });
    const raw = makeRawFinding({ filePath: "src/auth.ts", startLine: 99, cwe: ["CWE-89"] });

    const results = verifyFindings({ findings: [finding], rawFindings: [raw] });

    expect(results[0]!.verificationStatus).toBe("verified");
  });

  test("finding reachable via reachable map → verified + evidenceMd attached", () => {
    const fingerprint = "fp1234567890abcd";
    const finding = makeFinding({ fingerprint, confidence: "medium" });
    const reachable: Record<string, { reachable: boolean; evidenceMd?: string }> = {
      [fingerprint]: { reachable: true, evidenceMd: "path: A → B → C" },
    };

    const results = verifyFindings({ findings: [finding], rawFindings: [], reachable });

    expect(results[0]!.verificationStatus).toBe("verified");
    expect(results[0]!.reachabilityEvidenceMd).toBe("path: A → B → C");
  });

  test("finding not in reachable map stays unverified (medium confidence)", () => {
    const finding = makeFinding({ fingerprint: "fp-unknown", confidence: "medium" });

    const results = verifyFindings({ findings: [finding], rawFindings: [] });

    expect(results[0]!.verificationStatus).toBe("unverified");
  });

  test("finding in reachable map with reachable=false → not boosted by reachability", () => {
    const fingerprint = "fp-not-reachable";
    const finding = makeFinding({ fingerprint, confidence: "medium" });
    const reachable: Record<string, { reachable: boolean; evidenceMd?: string }> = {
      [fingerprint]: { reachable: false },
    };

    const results = verifyFindings({ findings: [finding], rawFindings: [], reachable });

    // No SAST, no proven reachability (map says false), confidence=medium → unverified
    expect(results[0]!.verificationStatus).toBe("unverified");
  });

  test("confidenceFloor=verified filters out medium/high/low findings when unverified", () => {
    const findings = [
      makeFinding({ fingerprint: "fp-a", confidence: "medium" }),
      makeFinding({ fingerprint: "fp-b", confidence: "verified" }),
    ];

    const results = verifyFindings({
      findings,
      rawFindings: [],
      confidenceFloor: "verified",
    });

    // medium is below floor and unverified → excluded; verified is at floor → included
    const statuses = results.map((r) => r.confidence);
    expect(statuses).not.toContain("medium");
    expect(statuses).toContain("verified");
  });

  test("confidenceFloor=medium includes medium, high, verified but excludes low", () => {
    const findings = [
      makeFinding({ fingerprint: "fp-low", confidence: "low" }),
      makeFinding({ fingerprint: "fp-medium", confidence: "medium" }),
      makeFinding({ fingerprint: "fp-high", confidence: "high" }),
      makeFinding({ fingerprint: "fp-verified", confidence: "verified" }),
    ];

    // Give each a SAST corroboration so all pass the verification gate
    const rawFindings = [
      makeRawFinding({ filePath: "src/auth.ts", startLine: 42, cwe: ["CWE-89"] }),
    ];

    const results = verifyFindings({
      findings,
      rawFindings,
      confidenceFloor: "medium",
    });

    const confidences = results.map((r) => r.confidence);
    expect(confidences).not.toContain("low");
    expect(confidences).toContain("medium");
    expect(confidences).toContain("high");
    expect(confidences).toContain("verified");
  });

  test("returns new objects, does not mutate input findings", () => {
    const finding = makeFinding();
    const original = { ...finding };

    verifyFindings({ findings: [finding], rawFindings: [] });

    expect(finding).toEqual(original);
  });

  test("empty findings returns empty array", () => {
    const results = verifyFindings({ findings: [], rawFindings: [] });
    expect(results).toHaveLength(0);
  });

  test("multiple findings each classified independently", () => {
    const fpSast = "fp-sast-00000001";
    const fpNone = "fp-none-00000002";
    const findings = [
      makeFinding({ fingerprint: fpSast, confidence: "medium", filePath: "src/auth.ts", startLine: 42, cwe: ["CWE-89"] }),
      makeFinding({ fingerprint: fpNone, confidence: "low", filePath: "src/other.ts", startLine: 10, cwe: ["CWE-79"] }),
    ];
    const rawFindings = [
      makeRawFinding({ filePath: "src/auth.ts", startLine: 42, cwe: ["CWE-89"] }),
    ];

    const results = verifyFindings({ findings, rawFindings });

    const byFp = Object.fromEntries(results.map((r) => [r.fingerprint, r]));
    expect(byFp[fpSast]!.verificationStatus).toBe("verified");
    expect(byFp[fpNone]!.verificationStatus).toBe("unverified");
  });

  test("finding with no SAST match, no reachability, high confidence → verified", () => {
    const finding = makeFinding({ confidence: "high" });

    const results = verifyFindings({ findings: [finding], rawFindings: [] });

    expect(results[0]!.verificationStatus).toBe("verified");
  });
});
