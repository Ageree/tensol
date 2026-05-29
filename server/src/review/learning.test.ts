/**
 * Tests for learning.ts — suppression derivation + rules.md application.
 * T043: N ignores of a style/nit category → suppression; security/correctness never suppressed.
 * T044: .sthrip/rules.md ignored-paths / trusted-sources applied; oversized file truncated.
 *
 * These tests exercise the PURE functions only (no DB; the actual DB read/write
 * of review_suppressions lives in service.ts).
 */

import { test, expect, describe } from "bun:test";
import type { ReviewFeedback } from "../db/schema.ts";
import type { ReviewFinding } from "./types.ts";
import {
  deriveSuppressions,
  applySuppressions,
  parseRulesMd,
  applyRulesMd,
  type SuppressionDecision,
  type ParsedRules,
} from "./learning.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReviewFeedback row for testing. */
function makeFeedback(
  overrides: Partial<ReviewFeedback> & { signal: ReviewFeedback["signal"] },
): ReviewFeedback {
  const base: ReviewFeedback = {
    id: "fb_" + Math.random().toString(36).slice(2),
    repoId: "repo_1",
    fingerprint: null,
    signal: overrides.signal,
    commentText: overrides.commentText ?? null,
    embeddingJson: null,
    createdAt: 1_700_000_000_000,
  };
  return { ...base, ...overrides };
}

/** Build a minimal ReviewFinding for suppression testing. */
function makeFinding(
  overrides: Partial<ReviewFinding> & { fingerprint: string },
): ReviewFinding {
  const base: ReviewFinding = {
    fingerprint: overrides.fingerprint,
    filePath: overrides.filePath ?? "src/foo.ts",
    side: "RIGHT",
    severity: overrides.severity ?? "medium",
    cwe: [],
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N",
    cvssScore: 0,
    confidence: overrides.confidence ?? "medium",
    reachable: false,
    category: overrides.category ?? "style",
    title: overrides.title ?? "Test finding",
    rationaleMd: "Because.",
    source: "llm",
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// T043 — deriveSuppressions: N ignores → suppression decision
// ---------------------------------------------------------------------------

describe("deriveSuppressions", () => {
  test("returns empty array when no feedback rows", () => {
    const result = deriveSuppressions({ feedback: [], threshold: 3 });
    expect(result).toEqual([]);
  });

  test("returns empty array when no 'ignored' signals", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "up", commentText: "style" }),
      makeFeedback({ signal: "down", commentText: "style" }),
      makeFeedback({ signal: "addressed", commentText: "nit" }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 2 });
    expect(result).toEqual([]);
  });

  test("does not suppress when ignore count is below threshold", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "style" }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 3 });
    expect(result).toEqual([]);
  });

  test("suppresses style category after N ignores (N=3)", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "style" }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 3 });
    expect(result).toHaveLength(1);
    const decision = result[0];
    expect(decision).toBeDefined();
    expect(decision).toMatchObject({
      category: "style",
      reason: "ignored_n_times",
      ignoreCount: 3,
    } satisfies SuppressionDecision);
  });

  test("suppresses nit category after N ignores (N=2)", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: "nit" }),
      makeFeedback({ signal: "ignored", commentText: "nit" }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 2 });
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({ category: "nit", reason: "ignored_n_times", ignoreCount: 2 });
  });

  test("suppresses multiple categories independently", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "nit" }),
      makeFeedback({ signal: "ignored", commentText: "nit" }),
      makeFeedback({ signal: "ignored", commentText: "nit" }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 3 });
    const categories = result.map((d) => d.category).sort();
    expect(categories).toEqual(["nit", "style"]);
  });

  test("NEVER suppresses 'security' category regardless of ignore count", () => {
    const feedback: ReviewFeedback[] = Array.from({ length: 100 }, () =>
      makeFeedback({ signal: "ignored", commentText: "security" }),
    );
    const result = deriveSuppressions({ feedback, threshold: 1 });
    expect(result).toEqual([]);
  });

  test("NEVER suppresses 'correctness' category regardless of ignore count", () => {
    const feedback: ReviewFeedback[] = Array.from({ length: 100 }, () =>
      makeFeedback({ signal: "ignored", commentText: "correctness" }),
    );
    const result = deriveSuppressions({ feedback, threshold: 1 });
    expect(result).toEqual([]);
  });

  test("never suppresses security even when mixed with suppressible categories", () => {
    const feedback: ReviewFeedback[] = [
      ...Array.from({ length: 5 }, () =>
        makeFeedback({ signal: "ignored", commentText: "security" }),
      ),
      ...Array.from({ length: 5 }, () =>
        makeFeedback({ signal: "ignored", commentText: "style" }),
      ),
    ];
    const result = deriveSuppressions({ feedback, threshold: 3 });
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("style");
  });

  test("ignores feedback rows with null/missing commentText", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: null }),
      makeFeedback({ signal: "ignored", commentText: null }),
      makeFeedback({ signal: "ignored", commentText: null }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 3 });
    // no category can be derived from null commentText
    expect(result).toEqual([]);
  });

  test("counts only ignored signals, not other signals", () => {
    // 2 ignored + 2 up = 2 ignored total for "style" (threshold 3)
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "ignored", commentText: "style" }),
      makeFeedback({ signal: "up", commentText: "style" }),
      makeFeedback({ signal: "down", commentText: "style" }),
    ];
    const result = deriveSuppressions({ feedback, threshold: 3 });
    expect(result).toEqual([]);
  });

  test("does not mutate the input feedback array", () => {
    const feedback: ReviewFeedback[] = [
      makeFeedback({ signal: "ignored", commentText: "style" }),
    ];
    const before = [...feedback];
    deriveSuppressions({ feedback, threshold: 3 });
    expect(feedback).toEqual(before);
  });

  test("reports the exact ignoreCount at threshold", () => {
    const N = 7;
    const feedback: ReviewFeedback[] = Array.from({ length: N }, () =>
      makeFeedback({ signal: "ignored", commentText: "performance" }),
    );
    const result = deriveSuppressions({ feedback, threshold: N });
    expect(result[0]!.ignoreCount).toBe(N);
  });

  test("reports the actual ignoreCount even when above threshold", () => {
    const feedback: ReviewFeedback[] = Array.from({ length: 10 }, () =>
      makeFeedback({ signal: "ignored", commentText: "style" }),
    );
    const result = deriveSuppressions({ feedback, threshold: 3 });
    expect(result[0]!.ignoreCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// T043 — applySuppressions: filter out suppressed category findings
// ---------------------------------------------------------------------------

describe("applySuppressions", () => {
  test("returns all findings when suppressed set is empty", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", category: "style" }),
      makeFinding({ fingerprint: "fp2", category: "security" }),
    ];
    const result = applySuppressions(findings, new Set());
    expect(result).toHaveLength(2);
  });

  test("filters out findings whose category is in the suppressed set", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", category: "style" }),
      makeFinding({ fingerprint: "fp2", category: "nit" }),
      makeFinding({ fingerprint: "fp3", category: "security" }),
    ];
    const result = applySuppressions(findings, new Set(["style", "nit"]));
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe("fp3");
  });

  test("returns findings with undefined/null category unchanged", () => {
    const finding: ReviewFinding = {
      ...makeFinding({ fingerprint: "fp1" }),
      category: undefined as unknown as string,
    };
    const result = applySuppressions([finding], new Set(["style"]));
    expect(result).toHaveLength(1);
  });

  test("does not mutate the input findings array", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", category: "style" }),
    ];
    const before = [...findings];
    applySuppressions(findings, new Set(["style"]));
    expect(findings).toEqual(before);
  });

  test("returns empty array when all findings are suppressed", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", category: "style" }),
      makeFinding({ fingerprint: "fp2", category: "nit" }),
    ];
    const result = applySuppressions(findings, new Set(["style", "nit"]));
    expect(result).toHaveLength(0);
  });

  test("works with generic objects (not just ReviewFinding)", () => {
    const items = [
      { category: "style", value: 1 },
      { category: "security", value: 2 },
      { category: null, value: 3 },
    ];
    const result = applySuppressions(items, new Set(["style"]));
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.value)).toEqual([2, 3]);
  });
});

// ---------------------------------------------------------------------------
// T044 — parseRulesMd: parse .sthrip/rules.md
// ---------------------------------------------------------------------------

describe("parseRulesMd", () => {
  test("returns empty rules for empty/null input", () => {
    expect(parseRulesMd("")).toEqual<ParsedRules>({
      ignoredPaths: [],
      trustedSources: [],
    });
    expect(parseRulesMd(null)).toEqual<ParsedRules>({
      ignoredPaths: [],
      trustedSources: [],
    });
  });

  test("parses ignored-paths section", () => {
    const md = `
## ignored-paths
- vendor/
- generated/
- **/*.min.js
`;
    const result = parseRulesMd(md);
    expect(result.ignoredPaths).toEqual(["vendor/", "generated/", "**/*.min.js"]);
  });

  test("parses trusted-sources section", () => {
    const md = `
## trusted-sources
- oauth2
- jwt-library
`;
    const result = parseRulesMd(md);
    expect(result.trustedSources).toEqual(["oauth2", "jwt-library"]);
  });

  test("parses both sections in any order", () => {
    const md = `
# Sthrip Rules

## trusted-sources
- library-a

## ignored-paths
- dist/
`;
    const result = parseRulesMd(md);
    expect(result.ignoredPaths).toEqual(["dist/"]);
    expect(result.trustedSources).toEqual(["library-a"]);
  });

  test("ignores non-list content in sections", () => {
    const md = `
## ignored-paths
Some plain text here.
- vendor/
Another paragraph.
- node_modules/
`;
    const result = parseRulesMd(md);
    expect(result.ignoredPaths).toEqual(["vendor/", "node_modules/"]);
  });

  test("is case-insensitive for section headers", () => {
    const md = `
## Ignored-Paths
- dist/
## Trusted-Sources
- auth-lib
`;
    const result = parseRulesMd(md);
    expect(result.ignoredPaths).toEqual(["dist/"]);
    expect(result.trustedSources).toEqual(["auth-lib"]);
  });

  test("truncates input above 64KB cap", () => {
    // Build a string > 64 * 1024 bytes
    const oversized = "## ignored-paths\n" + "- path/\n".repeat(10_000);
    const result = parseRulesMd(oversized);
    // Should not throw; may return partial results but no crash
    expect(result).toBeDefined();
    expect(Array.isArray(result.ignoredPaths)).toBe(true);
  });

  test("does not throw on completely malformed input", () => {
    const junk = "!!@#$%^&*() not a valid markdown file at all ===";
    expect(() => parseRulesMd(junk)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T044 — applyRulesMd: apply parsed rules to filter findings
// ---------------------------------------------------------------------------

describe("applyRulesMd", () => {
  test("returns all findings when rules are empty", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "src/auth.ts" }),
    ];
    const result = applyRulesMd(findings, { ignoredPaths: [], trustedSources: [] });
    expect(result).toHaveLength(1);
  });

  test("suppresses findings under ignored paths (exact prefix match)", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "vendor/lodash.js" }),
      makeFinding({ fingerprint: "fp2", filePath: "src/app.ts" }),
    ];
    const result = applyRulesMd(findings, {
      ignoredPaths: ["vendor/"],
      trustedSources: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe("fp2");
  });

  test("suppresses findings under nested ignored paths", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "generated/types/index.ts" }),
      makeFinding({ fingerprint: "fp2", filePath: "src/types.ts" }),
    ];
    const result = applyRulesMd(findings, {
      ignoredPaths: ["generated/"],
      trustedSources: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe("fp2");
  });

  test("handles glob-style **/ prefix patterns", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "some/deep/path/file.min.js" }),
      makeFinding({ fingerprint: "fp2", filePath: "src/main.ts" }),
    ];
    const result = applyRulesMd(findings, {
      ignoredPaths: ["**/*.min.js"],
      trustedSources: [],
    });
    // We check that findings matching *.min.js suffix are dropped
    expect(result.some((f) => f.fingerprint === "fp1")).toBe(false);
    expect(result.some((f) => f.fingerprint === "fp2")).toBe(true);
  });

  test("does not suppress findings not matching any ignored path", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "src/secure.ts" }),
    ];
    const result = applyRulesMd(findings, {
      ignoredPaths: ["vendor/", "dist/"],
      trustedSources: [],
    });
    expect(result).toHaveLength(1);
  });

  test("does not mutate the input findings array", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "vendor/lib.js" }),
    ];
    const before = [...findings];
    applyRulesMd(findings, { ignoredPaths: ["vendor/"], trustedSources: [] });
    expect(findings).toEqual(before);
  });

  test("multiple ignored paths all applied", () => {
    const findings: ReviewFinding[] = [
      makeFinding({ fingerprint: "fp1", filePath: "vendor/a.js" }),
      makeFinding({ fingerprint: "fp2", filePath: "dist/b.js" }),
      makeFinding({ fingerprint: "fp3", filePath: "src/c.ts" }),
    ];
    const result = applyRulesMd(findings, {
      ignoredPaths: ["vendor/", "dist/"],
      trustedSources: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.fingerprint).toBe("fp3");
  });
});
