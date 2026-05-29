/**
 * Candidate-derivation tests — diff hunk parsing, whole-repo splitting, and
 * candidate assembly (SAST + changed code).
 */
import { test, expect, describe } from "bun:test";
import {
  deriveCandidates,
  parseAddedHunks,
  splitUnifiedDiff,
} from "./candidates.ts";
import type { DiffFile, RawFinding } from "./types.ts";

describe("parseAddedHunks", () => {
  test("extracts added runs with correct new-file line numbers", () => {
    const patch = [
      "@@ -10,3 +10,4 @@ ctx",
      " const id = req.query.id;",
      '+const sql = "SELECT " + id;',
      "+return db.exec(sql);",
      " }",
    ].join("\n");
    const hunks = parseAddedHunks(patch);
    expect(hunks.length).toBe(1);
    // context line at new line 10, additions start at 11.
    expect(hunks[0]!.newStart).toBe(11);
    expect(hunks[0]!.endLine).toBe(12);
    expect(hunks[0]!.snippet).toContain("SELECT");
  });

  test("removed lines do not advance the new-file cursor", () => {
    const patch = [
      "@@ -1,3 +1,2 @@",
      "-old line a",
      "-old line b",
      "+new line",
    ].join("\n");
    const hunks = parseAddedHunks(patch);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.newStart).toBe(1);
  });

  test("empty/undefined patch yields no hunks", () => {
    expect(parseAddedHunks(undefined).length).toBe(0);
    expect(parseAddedHunks("").length).toBe(0);
  });
});

describe("splitUnifiedDiff", () => {
  test("splits a multi-file git diff into per-file DiffFiles", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const x = 1;",
      "+const y = 2;",
      " export {};",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 000..333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const z = 3;",
      "+console.log(z);",
    ].join("\n");
    const files = splitUnifiedDiff(diff);
    expect(files.length).toBe(2);
    const a = files.find((f) => f.path === "src/a.ts")!;
    expect(a.status).toBe("modified");
    expect(a.patch).toContain("@@ -1,2 +1,3 @@");
    const n = files.find((f) => f.path === "src/new.ts")!;
    expect(n.status).toBe("added");
  });

  test("detects deletions and empty input", () => {
    const del = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n");
    const files = splitUnifiedDiff(del);
    expect(files.length).toBe(1);
    expect(files[0]!.status).toBe("removed");
    expect(splitUnifiedDiff("").length).toBe(0);
  });
});

describe("deriveCandidates", () => {
  test("orders SAST candidates before changed-code candidates", () => {
    const files: DiffFile[] = [
      {
        path: "src/a.ts",
        status: "modified",
        patch: ["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"),
      },
    ];
    const raw: RawFinding[] = [
      {
        ruleId: "r1",
        source: "sast",
        filePath: "src/a.ts",
        startLine: 2,
        message: "tainted",
      },
    ];
    const cands = deriveCandidates({ files, rawFindings: raw });
    expect(cands.length).toBe(2);
    expect(cands[0]!.source).toBe("sast");
    expect(cands[1]!.source).toBe("llm");
    // deterministic ids
    expect(cands[0]!.id.startsWith("sast:")).toBe(true);
    expect(cands[1]!.id.startsWith("diff:")).toBe(true);
  });

  test("skips removed files for diff candidates", () => {
    const files: DiffFile[] = [{ path: "gone.ts", status: "removed" }];
    expect(deriveCandidates({ files }).length).toBe(0);
  });
});
