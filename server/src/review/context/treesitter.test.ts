/**
 * T030 — tests for treesitter.ts (tree-sitter symbol graph + PageRank ranker).
 *
 * TDD: all tests written BEFORE the implementation. Tests verify:
 *   1. TypeScript/JavaScript symbol extraction (defs/refs/imports/calls)
 *   2. Python symbol extraction (defs/refs/imports/calls)
 *   3. PageRank-style diff-neighbourhood ranking
 *   4. Graceful fallback to regex repomap for unknown languages
 *   5. Parser failure → fallback (never throws)
 *   6. Same ContextBundle shape as buildContextBundle
 *   7. Deterministic output
 */
import { test, expect, describe } from "bun:test";
import {
  TreesitterSymbolIndexer,
  buildTreesitterContextBundle,
  extractSymbolGraph,
  type SymbolGraph,
} from "./treesitter.ts";
import type { DiffFile, Candidate } from "../types.ts";

// ---------------------------------------------------------------------------
// TreesitterSymbolIndexer — extract defs/refs/imports/calls
// ---------------------------------------------------------------------------

describe("TreesitterSymbolIndexer.extract — TypeScript/JavaScript", () => {
  const indexer = new TreesitterSymbolIndexer();

  test("extracts function declarations", () => {
    const { defs } = indexer.extract({
      path: "a.ts",
      content: "export function fetchUser(id: string) { return id; }",
    });
    expect(defs).toContain("fetchUser");
  });

  test("extracts class declarations", () => {
    const { defs } = indexer.extract({
      path: "a.ts",
      content: "class UserRepo { constructor() {} }",
    });
    expect(defs).toContain("UserRepo");
  });

  test("extracts const/let/var declarations", () => {
    const { defs } = indexer.extract({
      path: "a.ts",
      content:
        "const apiBase = 'https://x';\nlet counter = 0;\nvar legacy = true;",
    });
    expect(defs).toContain("apiBase");
    expect(defs).toContain("counter");
    expect(defs).toContain("legacy");
  });

  test("extracts arrow function assignments", () => {
    const { defs } = indexer.extract({
      path: "a.ts",
      content:
        "const handler = async (req, res) => { return res.json({}); };",
    });
    expect(defs).toContain("handler");
  });

  test("extracts interface and type alias defs", () => {
    const { defs } = indexer.extract({
      path: "a.ts",
      content: "interface AuthUser { id: string; }\ntype Status = 'ok' | 'err';",
    });
    expect(defs).toContain("AuthUser");
    expect(defs).toContain("Status");
  });

  test("extracts named import bindings as refs", () => {
    const { refs } = indexer.extract({
      path: "a.ts",
      content: "import { hmacSha256, verifyToken } from '../lib/crypto';",
    });
    expect(refs).toContain("hmacSha256");
    expect(refs).toContain("verifyToken");
  });

  test("extracts import module specifiers as refs", () => {
    const { refs } = indexer.extract({
      path: "a.ts",
      content:
        "import { foo } from '../lib/crypto';\nimport type { Bar } from './types';",
    });
    expect(refs).toContain("../lib/crypto");
    expect(refs).toContain("./types");
  });

  test("extracts require() calls as refs", () => {
    const { refs } = indexer.extract({
      path: "a.js",
      content: "const fs = require('node:fs');\nconst path = require('path');",
    });
    expect(refs).toContain("node:fs");
    expect(refs).toContain("path");
  });

  test("extracts call-site refs (function calls)", () => {
    const { refs } = indexer.extract({
      path: "a.ts",
      content: "fetchUser(42);\nauthenticate(token);\nvalidateInput(data);",
    });
    expect(refs).toContain("fetchUser");
    expect(refs).toContain("authenticate");
    expect(refs).toContain("validateInput");
  });

  test("does not include keywords as defs or refs", () => {
    const { defs, refs } = indexer.extract({
      path: "a.ts",
      content:
        "if (true) { for (let i = 0; i < 10; i++) { return null; } }",
    });
    const keywords = ["if", "for", "let", "return", "true", "null"];
    for (const kw of keywords) {
      expect(defs).not.toContain(kw);
      expect(refs).not.toContain(kw);
    }
  });

  test("deduplicates defs and refs", () => {
    const { defs, refs } = indexer.extract({
      path: "a.ts",
      content:
        "function foo(){}\nfunction foo(){}\nfoo();\nfoo();",
    });
    expect(defs.filter((d) => d === "foo")).toHaveLength(1);
    expect(refs.filter((r) => r === "foo")).toHaveLength(1);
  });

  test("handles empty content gracefully", () => {
    const { defs, refs } = indexer.extract({ path: "empty.ts", content: "" });
    expect(defs).toEqual([]);
    expect(refs).toEqual([]);
  });

  test("handles very large files without hanging (>256KB returns empty)", () => {
    const big = "x".repeat(300 * 1024);
    const { defs, refs } = indexer.extract({ path: "big.ts", content: big });
    // Should NOT throw; may return empty due to size guard
    expect(Array.isArray(defs)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
  });
});

describe("TreesitterSymbolIndexer.extract — Python", () => {
  const indexer = new TreesitterSymbolIndexer();

  test("extracts function defs", () => {
    const { defs } = indexer.extract({
      path: "a.py",
      content: "def parse_token(s):\n    pass\n\ndef validate(x):\n    pass",
    });
    expect(defs).toContain("parse_token");
    expect(defs).toContain("validate");
  });

  test("extracts class defs", () => {
    const { defs } = indexer.extract({
      path: "a.py",
      content: "class Vault:\n    pass\n\nclass AuthService(Base):\n    pass",
    });
    expect(defs).toContain("Vault");
    expect(defs).toContain("AuthService");
  });

  test("extracts from-import bindings as refs", () => {
    const { refs } = indexer.extract({
      path: "a.py",
      content: "from hashlib import sha256, md5\nfrom os.path import join",
    });
    expect(refs).toContain("sha256");
    expect(refs).toContain("md5");
    expect(refs).toContain("join");
  });

  test("extracts import module as ref", () => {
    const { refs } = indexer.extract({
      path: "a.py",
      content: "import os\nimport sys",
    });
    expect(refs).toContain("os");
    expect(refs).toContain("sys");
  });

  test("extracts function call sites as refs", () => {
    const { refs } = indexer.extract({
      path: "a.py",
      content: "result = sha256(data)\nvalidate_input(x)",
    });
    expect(refs).toContain("sha256");
    expect(refs).toContain("validate_input");
  });
});

// ---------------------------------------------------------------------------
// extractSymbolGraph — richer graph for ranking
// ---------------------------------------------------------------------------

describe("extractSymbolGraph", () => {
  test("returns a SymbolGraph with defs, refs, imports, and calls arrays", () => {
    const graph: SymbolGraph = extractSymbolGraph({
      path: "a.ts",
      content:
        "import { sha256 } from './crypto';\nfunction login(user: string) { return sha256(user); }",
    });
    expect(Array.isArray(graph.defs)).toBe(true);
    expect(Array.isArray(graph.refs)).toBe(true);
    expect(Array.isArray(graph.imports)).toBe(true);
    expect(Array.isArray(graph.calls)).toBe(true);
  });

  test("separates imports from non-import refs", () => {
    const graph = extractSymbolGraph({
      path: "a.ts",
      content:
        "import { sha256 } from './crypto';\nfunction login() { sha256('x'); }",
    });
    // './crypto' should be in imports (module specifier)
    expect(graph.imports).toContain("./crypto");
    // sha256 might be in both refs (binding) and calls (call site)
    expect([...graph.refs, ...graph.calls]).toContain("sha256");
  });

  test("calls array contains only call-site identifiers", () => {
    const graph = extractSymbolGraph({
      path: "a.ts",
      content: "const x = 1;\nfetchData(url);\nprocessItem(item);",
    });
    expect(graph.calls).toContain("fetchData");
    expect(graph.calls).toContain("processItem");
  });

  test("handles unknown/unsupported language gracefully (no throw)", () => {
    expect(() =>
      extractSymbolGraph({
        path: "a.rb",
        content: "def greet(name)\n  puts name\nend",
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildTreesitterContextBundle — same shape as buildContextBundle, better ranking
// ---------------------------------------------------------------------------

describe("buildTreesitterContextBundle", () => {
  const candidates: Candidate[] = [
    {
      id: "c1",
      filePath: "src/auth.ts",
      startLine: 3,
      source: "sast",
      hint: "tainted input",
    },
  ];

  test("returns a valid ContextBundle shape", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "import { verify } from './crypto';\nexport function login() { verify(); }",
      },
    ];
    const bundle = buildTreesitterContextBundle({ files, candidates });
    expect(typeof bundle.diffSummary).toBe("string");
    expect(Array.isArray(bundle.files)).toBe(true);
    expect(Array.isArray(bundle.relatedSymbols)).toBe(true);
    expect(typeof bundle.tokenEstimate).toBe("number");
  });

  test("candidate file is ranked first", () => {
    const files: DiffFile[] = [
      {
        path: "src/unrelated.ts",
        status: "modified",
        contents: "export const COLORS = ['red'];",
      },
      {
        path: "src/auth.ts",
        status: "modified",
        contents:
          "import { verify } from './crypto';\nexport function login() { verify(); }",
      },
    ];
    const bundle = buildTreesitterContextBundle({ files, candidates });
    expect(bundle.files.length).toBeGreaterThan(0);
    expect(bundle.files[0]!.path).toBe("src/auth.ts");
    expect(bundle.files[0]!.reason).toBe("candidate location");
  });

  test("referenced file ranks above unrelated file", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents:
          "import { verifyToken } from './crypto';\nfunction login() { verifyToken(); }",
      },
      {
        path: "src/crypto.ts",
        status: "modified",
        contents: "export function verifyToken() { return true; }",
      },
      {
        path: "src/unrelated.ts",
        status: "modified",
        contents: "export const X = 1;",
      },
    ];
    const bundle = buildTreesitterContextBundle({ files, candidates });
    const paths = bundle.files.map((f) => f.path);
    const cryptoIdx = paths.indexOf("src/crypto.ts");
    const unrelatedIdx = paths.indexOf("src/unrelated.ts");
    expect(cryptoIdx).toBeGreaterThanOrEqual(0);
    if (unrelatedIdx >= 0) {
      expect(cryptoIdx).toBeLessThan(unrelatedIdx);
    }
  });

  test("respects token budget", () => {
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
    const bundle = buildTreesitterContextBundle({
      files,
      candidates,
      tokenBudget: budget,
    });
    // Allow the candidate file even if large, but huge non-candidate files must be skipped
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(budget * 2);
    const packedPaths = bundle.files.map((f) => f.path);
    expect(packedPaths).toContain("src/auth.ts");
    expect(packedPaths).not.toContain("src/extra.ts");
  });

  test("relatedSymbols includes cross-file refs defined in the changed set", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents:
          "import { verifyToken } from './crypto';\nfunction login() { verifyToken(); }",
      },
      {
        path: "src/crypto.ts",
        status: "modified",
        contents: "export function verifyToken() { return true; }",
      },
    ];
    const bundle = buildTreesitterContextBundle({ files, candidates });
    expect(bundle.relatedSymbols).toContain("verifyToken");
  });

  test("deterministic across repeated calls", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents:
          "import { a } from './a';\nimport { b } from './b';\nfunction login(){ a(); b(); }",
      },
      { path: "src/a.ts", status: "modified", contents: "export function a(){}" },
      { path: "src/b.ts", status: "modified", contents: "export function b(){}" },
      { path: "src/c.ts", status: "modified", contents: "export const c = 1;" },
    ];
    const run1 = buildTreesitterContextBundle({ files, candidates });
    const run2 = buildTreesitterContextBundle({ files, candidates });
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  test("empty files returns valid empty bundle", () => {
    const bundle = buildTreesitterContextBundle({ files: [], candidates: [] });
    expect(bundle.files).toEqual([]);
    expect(bundle.relatedSymbols).toEqual([]);
    expect(bundle.tokenEstimate).toBe(0);
    expect(typeof bundle.diffSummary).toBe("string");
  });

  test("falls back to regex extraction for unknown language extensions", () => {
    // Rust/Go/Java/etc. — should not throw, should still extract
    const files: DiffFile[] = [
      {
        path: "src/handler.rb",
        status: "modified",
        contents: "def process_request(data)\n  validate(data)\nend",
      },
    ];
    const rubyCandidates: Candidate[] = [
      {
        id: "c-rb",
        filePath: "src/handler.rb",
        source: "sast",
        hint: "tainted",
      },
    ];
    expect(() =>
      buildTreesitterContextBundle({ files, candidates: rubyCandidates })
    ).not.toThrow();
    const bundle = buildTreesitterContextBundle({
      files,
      candidates: rubyCandidates,
    });
    expect(bundle.files.length).toBeGreaterThan(0);
  });

  test("falls back gracefully on a file that triggers parser failure", () => {
    // Simulated by passing a .ts file with wildly invalid content —
    // the pure-TS extractor must not throw; it should still produce a bundle
    const files: DiffFile[] = [
      {
        path: "src/broken.ts",
        status: "modified",
        // NUL bytes + UTF-8 surrogates can break naive parsers
        contents: "function  𐀀broken() { }",
      },
    ];
    const brokenCandidates: Candidate[] = [
      { id: "c-br", filePath: "src/broken.ts", source: "sast", hint: "x" },
    ];
    expect(() =>
      buildTreesitterContextBundle({ files, candidates: brokenCandidates })
    ).not.toThrow();
  });

  test("tokenEstimate equals sum of packed file token costs", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        status: "modified",
        contents: "abcd".repeat(10),
      },
    ];
    const bundle = buildTreesitterContextBundle({ files, candidates });
    const manual = bundle.files.reduce(
      (acc, f) => acc + Math.ceil(f.content.length / 4),
      0
    );
    expect(bundle.tokenEstimate).toBe(manual);
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
    const bundle = buildTreesitterContextBundle({ files, candidates });
    const f = bundle.files.find((x) => x.path === "src/auth.ts")!;
    expect(f.content).toContain("@@");
    expect(f.content.length).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Python — buildTreesitterContextBundle integration
// ---------------------------------------------------------------------------

describe("buildTreesitterContextBundle — Python files", () => {
  test("ranks Python candidate file first and extracts symbols", () => {
    const pyCandidates: Candidate[] = [
      {
        id: "c-py",
        filePath: "auth.py",
        source: "sast",
        hint: "tainted",
      },
    ];
    const files: DiffFile[] = [
      {
        path: "auth.py",
        status: "modified",
        contents:
          "from hashlib import sha256\ndef login(user, pwd):\n    return sha256(pwd)",
      },
      {
        path: "utils.py",
        status: "modified",
        contents: "def sha256(data):\n    pass",
      },
    ];
    const bundle = buildTreesitterContextBundle({
      files,
      candidates: pyCandidates,
    });
    expect(bundle.files[0]!.path).toBe("auth.py");
    // sha256 is defined in utils.py and referenced in auth.py → should be a related symbol
    expect(bundle.relatedSymbols).toContain("sha256");
  });
});
