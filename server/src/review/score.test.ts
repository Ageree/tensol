/**
 * Tests for score.ts — CVSS 3.1 base scoring + Greptile-style merge readiness.
 */

import { test, expect, describe } from "bun:test";
import {
  vectorToString,
  cvssBaseScore,
  severityFromScore,
  overallScore0to5,
} from "./score.ts";
import type { CvssVector } from "./types.ts";

const CRITICAL: CvssVector = {
  AV: "N",
  AC: "L",
  PR: "N",
  UI: "N",
  S: "U",
  C: "H",
  I: "H",
  A: "H",
};

const NONE: CvssVector = {
  AV: "N",
  AC: "L",
  PR: "N",
  UI: "N",
  S: "U",
  C: "N",
  I: "N",
  A: "N",
};

describe("vectorToString", () => {
  test("emits canonical CVSS 3.1 string", () => {
    expect(vectorToString(CRITICAL)).toBe(
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    );
  });

  test("round-trips a scope-changed vector", () => {
    const v: CvssVector = {
      AV: "A",
      AC: "H",
      PR: "L",
      UI: "R",
      S: "C",
      C: "L",
      I: "L",
      A: "N",
    };
    expect(vectorToString(v)).toBe(
      "CVSS:3.1/AV:A/AC:H/PR:L/UI:R/S:C/C:L/I:L/A:N",
    );
  });
});

describe("cvssBaseScore", () => {
  test("full-impact RCE vector scores 9.8", () => {
    expect(cvssBaseScore(CRITICAL)).toBe(9.8);
  });

  test("no-impact vector scores 0.0", () => {
    expect(cvssBaseScore(NONE)).toBe(0.0);
  });

  test("scope-changed full-impact vector scores 10.0", () => {
    const v: CvssVector = {
      AV: "N",
      AC: "L",
      PR: "N",
      UI: "N",
      S: "C",
      C: "H",
      I: "H",
      A: "H",
    };
    expect(cvssBaseScore(v)).toBe(10.0);
  });

  test("scope-changed mixed vector scores 5.4", () => {
    const v: CvssVector = {
      AV: "N",
      AC: "L",
      PR: "L",
      UI: "R",
      S: "C",
      C: "L",
      I: "L",
      A: "N",
    };
    expect(cvssBaseScore(v)).toBe(5.4);
  });

  test("Heartbleed-style info-disclosure vector scores 7.5", () => {
    const v: CvssVector = {
      AV: "N",
      AC: "L",
      PR: "N",
      UI: "N",
      S: "U",
      C: "H",
      I: "N",
      A: "N",
    };
    expect(cvssBaseScore(v)).toBe(7.5);
  });

  test("result is rounded up to one decimal place", () => {
    const score = cvssBaseScore(CRITICAL);
    expect(Number.isInteger(score * 10)).toBe(true);
  });
});

describe("severityFromScore", () => {
  test("0.0 -> informational", () => {
    expect(severityFromScore(0.0)).toBe("informational");
  });
  test("0.1 -> low", () => {
    expect(severityFromScore(0.1)).toBe("low");
  });
  test("3.9 -> low", () => {
    expect(severityFromScore(3.9)).toBe("low");
  });
  test("4.0 -> medium", () => {
    expect(severityFromScore(4.0)).toBe("medium");
  });
  test("6.9 -> medium", () => {
    expect(severityFromScore(6.9)).toBe("medium");
  });
  test("7.0 -> high", () => {
    expect(severityFromScore(7.0)).toBe("high");
  });
  test("8.9 -> high", () => {
    expect(severityFromScore(8.9)).toBe("high");
  });
  test("9.0 -> critical", () => {
    expect(severityFromScore(9.0)).toBe("critical");
  });
  test("10.0 -> critical", () => {
    expect(severityFromScore(10.0)).toBe("critical");
  });
});

describe("overallScore0to5", () => {
  test("no findings -> 5 (clean)", () => {
    expect(overallScore0to5([])).toBe(5);
  });

  test("a counted critical -> 0", () => {
    expect(overallScore0to5([{ severity: "critical" }])).toBe(0);
  });

  test("worst-severity gating: critical beats high/medium", () => {
    expect(
      overallScore0to5([
        { severity: "low" },
        { severity: "high" },
        { severity: "critical" },
        { severity: "medium" },
      ]),
    ).toBe(0);
  });

  test("any high (no critical) -> 2", () => {
    expect(overallScore0to5([{ severity: "high" }, { severity: "low" }])).toBe(2);
  });

  test("any medium (no high/critical) -> 3", () => {
    expect(overallScore0to5([{ severity: "medium" }, { severity: "low" }])).toBe(3);
  });

  test("any low (no medium+) -> 4", () => {
    expect(overallScore0to5([{ severity: "low" }])).toBe(4);
  });

  test("only informational -> 5", () => {
    expect(overallScore0to5([{ severity: "informational" }])).toBe(5);
  });

  test("low-confidence findings are NOT counted", () => {
    expect(overallScore0to5([{ severity: "critical", confidence: "low" }])).toBe(5);
  });

  test("undefined confidence is treated as medium (counted)", () => {
    expect(overallScore0to5([{ severity: "critical" }])).toBe(0);
  });

  test("verified/high/medium confidence are counted", () => {
    expect(overallScore0to5([{ severity: "high", confidence: "verified" }])).toBe(2);
    expect(overallScore0to5([{ severity: "high", confidence: "high" }])).toBe(2);
    expect(overallScore0to5([{ severity: "high", confidence: "medium" }])).toBe(2);
  });

  test("reachable === false findings are NOT counted", () => {
    expect(
      overallScore0to5([{ severity: "critical", reachable: false }]),
    ).toBe(5);
  });

  test("reachable === true and undefined are counted", () => {
    expect(overallScore0to5([{ severity: "high", reachable: true }])).toBe(2);
    expect(overallScore0to5([{ severity: "high" }])).toBe(2);
  });

  test("mixed: only the counted findings gate the score", () => {
    // critical is filtered out (low confidence); high is filtered out (unreachable);
    // medium counts -> 3
    expect(
      overallScore0to5([
        { severity: "critical", confidence: "low" },
        { severity: "high", reachable: false },
        { severity: "medium", confidence: "high" },
      ]),
    ).toBe(3);
  });

  test("does not mutate the input array", () => {
    const findings = [{ severity: "high" as const }];
    const before = [...findings];
    overallScore0to5(findings);
    expect(findings).toEqual(before);
  });
});
