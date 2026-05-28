/**
 * Tests for repomap.ts — symbol extraction + token-budgeted context bundling.
 *
 * Covers the contract guarantees: candidate file ranked first, referenced
 * files preferred over unrelated, token budget respected, relatedSymbols
 * populated, and full determinism across repeated runs.
 */
import { test, expect, describe } from "bun:test";
import {
  RegexSymbolIndexer,
  buildContextBundle,
  estimateTokens,
} from "./repomap.ts";
import type { DiffFile, Candidate } from "../types.ts";

describe("estimateTokens", () => {
  test("estimates ~ ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("RegexSymbolIndexer.extract", () => {
  const indexer = new RegexSymbolIndexer();

  test("extracts JS/TS function and class and const defs", () => {
    const { defs } = indexer.extract({
      path: "a.ts",
      content: [
        "export function fetchUser(id) { return db.get(id); }",
        "class UserRepo {}",
        "const apiBase = 'https://x';",
        "export const handler = () => {};",
      ].join("\n"),
    });
    expect(defs).toContain("fetchUser");
    expect(defs).toContain("UserRepo");
    expect(defs).toContain("apiBase");
    expect(defs).toContain("handler");
  });

  test("extracts Python def/class defs", () => {
    const { defs } = indexer.extract({
      path: "a.py",
      content: ["def parse_token(s):", "    pass", "class Vault:", "    pass"].join("\n"),
    });
    expect(defs).toContain("parse_token");
    expect(defs).toContain("Vault");
  });

  test("extracts Go func defs", () => {
    const { defs } = indexer.extract({
      path: "a.go",
      content: ["func HandleRequest(w http.ResponseWriter) {", "}"].join("\n"),
    });
    expect(defs).toContain("HandleRequest");
  });

  test("extracts Java method/class defs", () => {
    const { defs } = indexer.extract({
      path: "A.java",
      content: ["public class AuthService {", "  public void login() {}", "}"].join("\n"),
    });
    expect(defs).toContain("AuthService");
    expect(defs).toContain("login");
  });

  test("extracts import module specifiers and identifiers as refs", () => {
    const { refs } = indexer.extract({
      path: "a.ts",
      content: [
        "import { hmacSha256 } from '../lib/crypto';",
        "const x = require('node:fs');",
        "import sha from 'hash-lib';",
        "fetchUser(42);",
      ].join("\n"),
    });
    expect(refs).toContain("../lib/crypto");
    expect(refs).toContain("node:fs");
    expect(refs).toContain("hash-lib");
    expect(refs).toContain("hmacSha256");
    expect(refs).toContain("fetchUser");
  });

  test("dedups defs and refs", () => {
    const { defs, refs } = indexer.extract({
      path: "a.ts",
      content: ["function foo(){}", "function foo(){}", "foo(); foo();"].join("\n"),
    });
    expect(defs.filter((d) => d === "foo")).toHaveLength(1);
    expect(refs.filter((r) => r === "foo")).toHaveLength(1);
  });

  test("empty content yields empty arrays", () => {
    const { defs, refs } = indexer.extract({ path: "empty.ts", content: "" });
    expect(defs).toEqual([]);
    expect(refs).toEqual([]);
  });
});

describe("buildContextBundle", () => {
  const candidates: Candidate[] = [
    {
      id: "c1",
      filePath: "src/auth.ts",
      startLine: 3,
      source: "sast",
      hint: "tainted input",
    },
  ];

  test("candidate file is always included first", () => {
    const files: DiffFile[] = [
      {
        path: "src/unrelated.ts",
        status: "modified",
        contents: "export function noop() { return 0; }",
      },
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "import { verify } from './crypto';\nexport function login() { verify(); }",
      },
    ];
    const bundle = buildContextBundle({ files, candidates });
    expect(bundle.files.length).toBeGreaterThan(0);
    expect(bundle.files[0]!.path).toBe("src/auth.ts");
    expect(bundle.files[0]!.reason).toBe("candidate location");
  });

  test("referenced file is included before an unrelated file", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "import { verifyToken } from './crypto';\nexport function login() { verifyToken(); }",
      },
      {
        path: "src/crypto.ts",
        status: "modified",
        contents: "export function verifyToken() { return true; }",
      },
      {
        path: "src/totally-unrelated.ts",
        status: "modified",
        contents: "export const COLORS = ['red', 'green'];",
      },
    ];
    const bundle = buildContextBundle({ files, candidates });
    const paths = bundle.files.map((f) => f.path);
    const cryptoIdx = paths.indexOf("src/crypto.ts");
    const unrelatedIdx = paths.indexOf("src/totally-unrelated.ts");
    expect(cryptoIdx).toBeGreaterThanOrEqual(0);
    // crypto (referenced by candidate file) should rank above unrelated
    if (unrelatedIdx >= 0) {
      expect(cryptoIdx).toBeLessThan(unrelatedIdx);
    }
    // the referenced file gets a "referenced by" reason
    const cryptoFile = bundle.files.find((f) => f.path === "src/crypto.ts");
    expect(cryptoFile!.reason).toContain("referenced by");
  });

  test("respects token budget — never materially exceeds it", () => {
    const big = "x".repeat(40000); // ~10000 tokens
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "import { big } from './big';\n" + "a".repeat(2000),
      },
      { path: "src/big.ts", status: "modified", contents: big },
      { path: "src/extra.ts", status: "modified", contents: "z".repeat(40000) },
    ];
    const budget = 1000;
    const bundle = buildContextBundle({ files, candidates, tokenBudget: budget });
    // estimate should not blow far past budget; allow the candidate file even if it alone is large,
    // but huge non-candidate files must be skipped.
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(budget * 2);
    // the 40k-char non-candidate files must not all be packed
    const packedPaths = bundle.files.map((f) => f.path);
    expect(packedPaths).toContain("src/auth.ts");
    expect(packedPaths).not.toContain("src/extra.ts");
  });

  test("tokenEstimate equals sum of packed file token estimates", () => {
    const files: DiffFile[] = [
      { path: "src/auth.ts", status: "modified", contents: "abcd".repeat(10) },
    ];
    const bundle = buildContextBundle({ files, candidates });
    const manual = bundle.files.reduce((acc, f) => acc + estimateTokens(f.content), 0);
    expect(bundle.tokenEstimate).toBe(manual);
  });

  test("relatedSymbols populated from candidate file refs that are defined elsewhere", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "import { verifyToken } from './crypto';\nfunction login() { verifyToken(); }",
      },
      {
        path: "src/crypto.ts",
        status: "modified",
        contents: "export function verifyToken() { return true; }",
      },
    ];
    const bundle = buildContextBundle({ files, candidates });
    expect(bundle.relatedSymbols).toContain("verifyToken");
  });

  test("diffSummary lists changed paths + statuses", () => {
    const files: DiffFile[] = [
      { path: "src/auth.ts", status: "modified", contents: "function login(){}" },
      { path: "src/new.ts", status: "added", contents: "function fresh(){}" },
    ];
    const bundle = buildContextBundle({ files, candidates });
    expect(bundle.diffSummary).toContain("src/auth.ts");
    expect(bundle.diffSummary).toContain("modified");
    expect(bundle.diffSummary).toContain("src/new.ts");
    expect(bundle.diffSummary).toContain("added");
  });

  test("prefers patch over contents when patch is shorter", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-old\n+new",
        contents: "x".repeat(5000),
      },
    ];
    const bundle = buildContextBundle({ files, candidates });
    const f = bundle.files.find((x) => x.path === "src/auth.ts")!;
    expect(f.content).toContain("@@");
    expect(f.content.length).toBeLessThan(5000);
  });

  test("deterministic across repeated runs", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "import { a } from './a';\nimport { b } from './b';\nfunction login(){ a(); b(); }",
      },
      { path: "src/a.ts", status: "modified", contents: "export function a(){}" },
      { path: "src/b.ts", status: "modified", contents: "export function b(){}" },
      { path: "src/c.ts", status: "modified", contents: "export const c = 1;" },
    ];
    const run1 = buildContextBundle({ files, candidates });
    const run2 = buildContextBundle({ files, candidates });
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  test("empty files yields empty bundle but valid shape", () => {
    const bundle = buildContextBundle({ files: [], candidates: [] });
    expect(bundle.files).toEqual([]);
    expect(bundle.relatedSymbols).toEqual([]);
    expect(bundle.tokenEstimate).toBe(0);
    expect(typeof bundle.diffSummary).toBe("string");
  });

  test("candidate file with no contents/patch but snippet uses snippet", () => {
    const candWithSnippet: Candidate[] = [
      {
        id: "c2",
        filePath: "src/only-snippet.ts",
        source: "llm",
        hint: "h",
        snippet: "function vuln(){ eval(x); }",
      },
    ];
    const files: DiffFile[] = [
      { path: "src/only-snippet.ts", status: "modified" },
    ];
    const bundle = buildContextBundle({ files, candidates: candWithSnippet });
    const f = bundle.files.find((x) => x.path === "src/only-snippet.ts");
    expect(f).toBeDefined();
    expect(f!.content).toContain("vuln");
  });
});
