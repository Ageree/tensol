/**
 * Tests for sarif.ts — defensive SARIF 2.1.0 normalization.
 *
 * Three inline fixtures mirror the real on-disk SARIF emitted by Opengrep
 * (Semgrep-compatible), Trivy, and Gitleaks. We assert filePath / line /
 * severity / cwe extraction plus the defensive contract: any non-SARIF or
 * garbage input yields [] (never throws).
 */

import { describe, expect, test } from "bun:test";
import { normalizeSarif } from "./sarif.ts";
import type { RawFinding } from "./types.ts";

/**
 * Opengrep / Semgrep SARIF: ruleId = check_id, CWE + security-severity live in
 * the driver rule's `properties` (CWE as an array of "CWE-89: ..." strings),
 * and the result references the rule by `ruleIndex`. Note the result here has
 * NO inline `rule.id` — metadata must be resolved from `tool.driver.rules`.
 */
const opengrepSarif = {
  version: "2.1.0",
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [
    {
      tool: {
        driver: {
          name: "Semgrep OSS",
          rules: [
            {
              id: "javascript.express.security.injection.tainted-sql-string",
              name: "tainted-sql-string",
              properties: {
                "security-severity": "8.5",
                cwe: [
                  "CWE-89: Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')",
                ],
                tags: ["security", "owasp-a03"],
              },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "javascript.express.security.injection.tainted-sql-string",
          ruleIndex: 0,
          level: "warning",
          message: { text: "Detected a tainted value flowing into a SQL string." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db/users.js" },
                region: {
                  startLine: 42,
                  endLine: 44,
                  snippet: { text: "db.query('SELECT * FROM u WHERE id=' + req.params.id)" },
                },
              },
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Trivy SARIF: ruleId = vulnerability/check ID, severity comes from the
 * numeric `security-severity` string in rule.properties (preferred over
 * level), tags array carries the title + "security" + severity word. Region
 * uses startLine/endLine (no snippet).
 */
const trivySarif = {
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "Trivy",
          rules: [
            {
              id: "CVE-2023-1234",
              name: "OsPackageVulnerability",
              properties: {
                tags: ["openssl: CVE-2023-1234", "security", "HIGH"],
                precision: "very-high",
                "security-severity": "7.5",
                cwe: "CWE-787",
              },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "CVE-2023-1234",
          ruleIndex: 0,
          level: "error",
          message: {
            text: "Package: openssl\nInstalled Version: 1.1.1\nVulnerability CVE-2023-1234\nSeverity: HIGH",
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "usr/lib/openssl.so", uriBaseId: "ROOTPATH" },
                region: { startLine: 1, endLine: 1 },
              },
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Gitleaks SARIF: ruleId = rule name, message is a sentence, the leaked secret
 * is the region snippet, tags live in result-level `properties.tags`. No CWE,
 * no security-severity — level defaults absent so we fall back to the
 * informational/low mapping via level when present.
 */
const gitleaksSarif = {
  version: "2.1.0",
  $schema: "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json",
  runs: [
    {
      tool: {
        driver: {
          name: "gitleaks",
          rules: [
            {
              id: "aws-access-token",
              name: "aws-access-token",
              shortDescription: { text: "AWS Access Token" },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "aws-access-token",
          level: "error",
          message: {
            text: "aws-access-token has detected secret for file config.env at commit abc123.",
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "file://./config.env" },
                region: {
                  startLine: 7,
                  endLine: 7,
                  startColumn: 12,
                  endColumn: 52,
                  snippet: { text: "AKIAIOSFODNN7EXAMPLE" },
                },
              },
            },
          ],
          properties: { tags: ["secret", "CWE-798"] },
          partialFingerprints: { commitSha: "abc123" },
        },
      ],
    },
  ],
};

describe("normalizeSarif — Opengrep/Semgrep", () => {
  test("extracts a single finding with resolved rule metadata", () => {
    const out = normalizeSarif(opengrepSarif, "sast");
    expect(out).toHaveLength(1);
    const f = out[0] as RawFinding;
    expect(f.source).toBe("sast");
    expect(f.ruleId).toBe(
      "javascript.express.security.injection.tainted-sql-string",
    );
    expect(f.filePath).toBe("src/db/users.js");
    expect(f.startLine).toBe(42);
    expect(f.endLine).toBe(44);
    expect(f.message).toBe(
      "Detected a tainted value flowing into a SQL string.",
    );
    expect(f.snippet).toBe(
      "db.query('SELECT * FROM u WHERE id=' + req.params.id)",
    );
  });

  test("prefers numeric security-severity (8.5 -> high) over level", () => {
    const out = normalizeSarif(opengrepSarif, "sast");
    expect(out[0]!.severity).toBe("high");
  });

  test("normalizes CWE from 'CWE-89: ...' string to canonical CWE-89", () => {
    const out = normalizeSarif(opengrepSarif, "sast");
    expect(out[0]!.cwe).toEqual(["CWE-89"]);
  });
});

describe("normalizeSarif — Trivy", () => {
  test("extracts vulnerability id, path, severity from security-severity", () => {
    const out = normalizeSarif(trivySarif, "sca");
    expect(out).toHaveLength(1);
    const f = out[0] as RawFinding;
    expect(f.source).toBe("sca");
    expect(f.ruleId).toBe("CVE-2023-1234");
    expect(f.filePath).toBe("usr/lib/openssl.so");
    expect(f.startLine).toBe(1);
    // security-severity 7.5 -> high (7-8.9), preferred over level=error
    expect(f.severity).toBe("high");
    expect(f.message).toContain("Package: openssl");
  });

  test("normalizes CWE provided as a bare string property", () => {
    const out = normalizeSarif(trivySarif, "sca");
    expect(out[0]!.cwe).toEqual(["CWE-787"]);
  });
});

describe("normalizeSarif — Gitleaks", () => {
  test("extracts secret rule, strips file:// and ./ from uri", () => {
    const out = normalizeSarif(gitleaksSarif, "secrets");
    expect(out).toHaveLength(1);
    const f = out[0] as RawFinding;
    expect(f.source).toBe("secrets");
    expect(f.ruleId).toBe("aws-access-token");
    expect(f.filePath).toBe("config.env");
    expect(f.startLine).toBe(7);
    expect(f.snippet).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  test("maps level error -> high when no security-severity present", () => {
    const out = normalizeSarif(gitleaksSarif, "secrets");
    expect(out[0]!.severity).toBe("high");
  });

  test("collects CWE from result-level properties.tags", () => {
    const out = normalizeSarif(gitleaksSarif, "secrets");
    expect(out[0]!.cwe).toEqual(["CWE-798"]);
  });
});

describe("normalizeSarif — level mapping", () => {
  function single(level: string, secSeverity?: string) {
    const props = secSeverity
      ? { properties: { "security-severity": secSeverity } }
      : {};
    return {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "t", rules: [{ id: "r", ...props }] } },
          results: [
            {
              ruleId: "r",
              ruleIndex: 0,
              level,
              message: { text: "m" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "a.js" } } },
              ],
            },
          ],
        },
      ],
    };
  }

  test("error -> high", () => {
    expect(normalizeSarif(single("error"), "sast")[0]!.severity).toBe("high");
  });
  test("warning -> medium", () => {
    expect(normalizeSarif(single("warning"), "sast")[0]!.severity).toBe(
      "medium",
    );
  });
  test("note -> low", () => {
    expect(normalizeSarif(single("note"), "sast")[0]!.severity).toBe("low");
  });
  test("none -> informational", () => {
    expect(normalizeSarif(single("none"), "sast")[0]!.severity).toBe(
      "informational",
    );
  });
  test("missing level -> undefined severity", () => {
    const out = normalizeSarif(single(""), "sast");
    expect(out[0]!.severity).toBeUndefined();
  });

  test("security-severity numeric bands: >=9 critical", () => {
    expect(normalizeSarif(single("note", "9.8"), "sast")[0]!.severity).toBe(
      "critical",
    );
  });
  test("security-severity 7-8.9 high", () => {
    expect(normalizeSarif(single("note", "7.0"), "sast")[0]!.severity).toBe(
      "high",
    );
  });
  test("security-severity 4-6.9 medium", () => {
    expect(normalizeSarif(single("error", "5.5"), "sast")[0]!.severity).toBe(
      "medium",
    );
  });
  test("security-severity 0.1-3.9 low", () => {
    expect(normalizeSarif(single("error", "2.0"), "sast")[0]!.severity).toBe(
      "low",
    );
  });
  test("security-severity 0 falls through to level mapping", () => {
    expect(normalizeSarif(single("warning", "0"), "sast")[0]!.severity).toBe(
      "medium",
    );
  });
  test("non-numeric security-severity ignored, level used", () => {
    expect(
      normalizeSarif(single("note", "n/a"), "sast")[0]!.severity,
    ).toBe("low");
  });
});

describe("normalizeSarif — rule resolution & cwe collection", () => {
  test("resolves rule by id when ruleIndex absent", () => {
    const sarif = {
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              rules: [
                { id: "other", properties: { cwe: ["CWE-1"] } },
                { id: "target", properties: { "security-severity": "9.9" } },
              ],
            },
          },
          results: [
            {
              ruleId: "target",
              message: { text: "m" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "x.py" } } },
              ],
            },
          ],
        },
      ],
    };
    expect(normalizeSarif(sarif, "sast")[0]!.severity).toBe("critical");
  });

  test("uses result.rule.id when present, ignoring top-level ruleId", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { rules: [] } },
          results: [
            {
              rule: { id: "from-rule-object" },
              message: { text: "m" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "x.py" } } },
              ],
            },
          ],
        },
      ],
    };
    expect(normalizeSarif(sarif, "sast")[0]!.ruleId).toBe("from-rule-object");
  });

  test("falls back to ruleId='unknown' when nothing identifies the rule", () => {
    const sarif = {
      runs: [
        {
          results: [
            {
              message: { text: "m" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "x.py" } } },
              ],
            },
          ],
        },
      ],
    };
    expect(normalizeSarif(sarif, "sast")[0]!.ruleId).toBe("unknown");
  });

  test("dedups and merges CWE from rule props, result props, and taxa/tags", () => {
    const sarif = {
      runs: [
        {
          tool: {
            driver: {
              rules: [
                {
                  id: "r",
                  properties: { cwe: ["CWE-89", "cwe-89"] },
                },
              ],
            },
          },
          results: [
            {
              ruleId: "r",
              ruleIndex: 0,
              message: { text: "m" },
              properties: { cwe: "CWE-79", tags: ["external/cwe/cwe-22"] },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "x.py" } } },
              ],
            },
          ],
        },
      ],
    };
    const cwe = normalizeSarif(sarif, "sast")[0]!.cwe!;
    expect([...cwe].sort()).toEqual(["CWE-22", "CWE-79", "CWE-89"]);
  });

  test("multiple results across multiple runs are all collected", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { rules: [] } },
          results: [
            {
              ruleId: "a",
              message: { text: "1" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "a.js" } } },
              ],
            },
          ],
        },
        {
          tool: { driver: { rules: [] } },
          results: [
            {
              ruleId: "b",
              message: { text: "2" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "b.js" } } },
              ],
            },
          ],
        },
      ],
    };
    const out = normalizeSarif(sarif, "sast");
    expect(out.map((f) => f.ruleId)).toEqual(["a", "b"]);
  });
});

describe("normalizeSarif — defensive / garbage input", () => {
  test("null -> []", () => {
    expect(normalizeSarif(null, "sast")).toEqual([]);
  });
  test("undefined -> []", () => {
    expect(normalizeSarif(undefined, "sast")).toEqual([]);
  });
  test("string -> []", () => {
    expect(normalizeSarif("not sarif", "sast")).toEqual([]);
  });
  test("number -> []", () => {
    expect(normalizeSarif(42, "sast")).toEqual([]);
  });
  test("array -> []", () => {
    expect(normalizeSarif([1, 2, 3], "sast")).toEqual([]);
  });
  test("empty object -> []", () => {
    expect(normalizeSarif({}, "sast")).toEqual([]);
  });
  test("object with non-array runs -> []", () => {
    expect(normalizeSarif({ runs: "nope" }, "sast")).toEqual([]);
  });
  test("runs with no results -> []", () => {
    expect(normalizeSarif({ runs: [{ tool: {} }] }, "sast")).toEqual([]);
  });
  test("result missing message/locations does not throw", () => {
    const out = normalizeSarif({ runs: [{ results: [{ ruleId: "x" }] }] }, "sast");
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleId).toBe("x");
    expect(out[0]!.message).toBe("");
    expect(out[0]!.filePath).toBe("");
    expect(out[0]!.startLine).toBeUndefined();
  });
  test("result with malformed location entries does not throw", () => {
    const out = normalizeSarif(
      {
        runs: [
          {
            results: [
              {
                ruleId: "x",
                message: { text: "m" },
                locations: [null, "bad", { physicalLocation: null }],
              },
            ],
          },
        ],
      },
      "sast",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("");
  });
  test("does not mutate the input object", () => {
    const input = JSON.parse(JSON.stringify(opengrepSarif));
    const snapshot = JSON.stringify(input);
    normalizeSarif(input, "sast");
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("percent-decodes the artifactLocation.uri so filePath matches the real path", () => {
    const out = normalizeSarif(
      {
        runs: [
          {
            results: [
              {
                ruleId: "r",
                message: { text: "m" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/my%20report.ts" },
                      region: { startLine: 3 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "sast",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("src/my report.ts");
  });

  test("malformed percent-escape in uri is left as-is (never throws)", () => {
    const out = normalizeSarif(
      {
        runs: [
          {
            results: [
              {
                ruleId: "r",
                message: { text: "m" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/100%done.ts" },
                      region: { startLine: 1 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "sast",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("src/100%done.ts");
  });
});
