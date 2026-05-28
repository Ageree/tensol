/**
 * Tests for fingerprint.ts — stable, line-shift-invariant finding identity.
 */

import { test, expect, describe } from "bun:test";
import { fingerprint } from "./fingerprint.ts";

describe("fingerprint", () => {
  test("identical inputs produce identical fingerprint", () => {
    const input = {
      cwe: ["CWE-89"],
      filePath: "src/db/user.ts",
      snippet: "const q = `SELECT * FROM u WHERE id=${id}`;",
      category: "SQL Injection",
    };
    expect(fingerprint(input)).toBe(fingerprint(input));
  });

  test("returns a 16-char lowercase hex string", () => {
    const fp = fingerprint({ cwe: ["CWE-79"], filePath: "a.ts" });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  test("reordered cwe yields the same fingerprint", () => {
    const a = fingerprint({
      cwe: ["CWE-89", "CWE-79", "CWE-22"],
      filePath: "x.ts",
      snippet: "foo",
    });
    const b = fingerprint({
      cwe: ["CWE-22", "CWE-89", "CWE-79"],
      filePath: "x.ts",
      snippet: "foo",
    });
    expect(a).toBe(b);
  });

  test("snippet with different indentation/line breaks but same tokens is stable", () => {
    const a = fingerprint({
      cwe: ["CWE-89"],
      filePath: "q.ts",
      snippet: "if (x) {\n    doThing(x);\n}",
    });
    const b = fingerprint({
      cwe: ["CWE-89"],
      filePath: "q.ts",
      snippet: "  if (x) {        doThing(x);   }  ",
    });
    expect(a).toBe(b);
  });

  test("snippet case differences are normalized away", () => {
    const a = fingerprint({ cwe: ["CWE-89"], filePath: "q.ts", snippet: "SELECT x" });
    const b = fingerprint({ cwe: ["CWE-89"], filePath: "q.ts", snippet: "select x" });
    expect(a).toBe(b);
  });

  test("category case/whitespace differences are normalized away", () => {
    const a = fingerprint({ cwe: ["CWE-89"], filePath: "q.ts", category: "SQL Injection" });
    const b = fingerprint({ cwe: ["CWE-89"], filePath: "q.ts", category: "  sql injection  " });
    expect(a).toBe(b);
  });

  test("different filePath yields a different fingerprint", () => {
    const a = fingerprint({ cwe: ["CWE-89"], filePath: "a.ts", snippet: "x" });
    const b = fingerprint({ cwe: ["CWE-89"], filePath: "b.ts", snippet: "x" });
    expect(a).not.toBe(b);
  });

  test("different cwe set yields a different fingerprint", () => {
    const a = fingerprint({ cwe: ["CWE-89"], filePath: "a.ts" });
    const b = fingerprint({ cwe: ["CWE-79"], filePath: "a.ts" });
    expect(a).not.toBe(b);
  });

  test("different category yields a different fingerprint", () => {
    const a = fingerprint({ cwe: ["CWE-89"], filePath: "a.ts", category: "SQL Injection" });
    const b = fingerprint({ cwe: ["CWE-89"], filePath: "a.ts", category: "XSS" });
    expect(a).not.toBe(b);
  });

  test("missing optional fields (snippet/category) defaults are stable", () => {
    const a = fingerprint({ cwe: ["CWE-89"], filePath: "a.ts" });
    const b = fingerprint({ cwe: ["CWE-89"], filePath: "a.ts", snippet: "", category: "" });
    expect(a).toBe(b);
  });

  test("does not mutate the input cwe array", () => {
    const cwe = ["CWE-89", "CWE-22"];
    const before = [...cwe];
    fingerprint({ cwe, filePath: "a.ts" });
    expect(cwe).toEqual(before);
  });

  test("empty cwe array is handled", () => {
    const fp = fingerprint({ cwe: [], filePath: "a.ts" });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
