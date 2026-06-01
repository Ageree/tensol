/**
 * Tests for deterministic recon (TASK 1.2) — buildRoutingUnits.
 *
 * Verifies the OpenHack source-inventory port: pattern detection, category
 * mapping, 1-indexed line numbers, zero-padded sequential IDs, and SKIP-path
 * filtering. No LLM involved — pure function over DiffFile[].
 */
import { expect, test } from "bun:test";
import { buildRoutingUnits } from "./recon.ts";
import type { DiffFile } from "../types.ts";

const file: DiffFile = {
  path: "src/handlers/users.ts",
  status: "modified",
  contents: [
    'export function list(req){',
    '  const rows = db.query("SELECT * FROM users WHERE id=" + req.id);',
    '  const meta = requests.get(req.url);',
    '  return rows;',
    '}',
  ].join("\n"),
};

test("detects a SQL sink and an SSRF sink with correct lines", () => {
  const units = buildRoutingUnits([file]);
  const sql = units.find(u => u.kind === "sql");
  const ssrf = units.find(u => u.kind === "ssrf");
  expect(sql).toBeDefined();
  expect(sql!.category).toBe("sinks");
  expect(sql!.filePath).toBe("src/handlers/users.ts");
  expect(sql!.line).toBe(2);
  expect(ssrf).toBeDefined();
  expect(ssrf!.category).toBe("sinks");
  expect(ssrf!.line).toBe(3);
  expect(units.every(u => /^U\d{3,}$/.test(u.id))).toBe(true);
});

test("detects Node sync command sinks (execSync / spawnSync / execFileSync)", () => {
  const file: DiffFile = {
    path: "src/ops.ts",
    status: "modified",
    contents: [
      'import { execSync, spawnSync, execFileSync } from "node:child_process";',
      'export const a = (h) => execSync("ping " + h);',
      'export const b = (h) => spawnSync("ping", [h]);',
      'export const c = (h) => execFileSync("ping", [h]);',
    ].join("\n"),
  };
  const cmd = buildRoutingUnits([file]).filter((u) => u.kind === "command");
  // execSync, spawnSync, execFileSync lines are all detected as command sinks.
  expect(cmd.length).toBeGreaterThanOrEqual(3);
  expect(cmd.every((u) => u.category === "sinks")).toBe(true);
});

test("skips node_modules paths", () => {
  const units = buildRoutingUnits([{ path: "node_modules/x/index.js", status: "added", contents: 'db.query("SELECT 1")' }]);
  expect(units).toEqual([]);
});
