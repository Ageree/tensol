import { test, expect } from "bun:test";
import {
  LENS_BY_KIND,
  LENS_DIRECTIVE,
  REPO_TOOL_PROTOCOL,
  REFUTE_PROTOCOL,
} from "./lenses.ts";
import { EXPERT_KEYS } from "../research/types.ts";

test("every ExpertKey has a non-empty directive", () => {
  for (const k of EXPERT_KEYS) {
    expect(typeof LENS_DIRECTIVE[k]).toBe("string");
    expect(LENS_DIRECTIVE[k].length).toBeGreaterThan(0);
  }
});

test("every RoutingUnitKind maps to a valid ExpertKey lens", () => {
  const kinds = [
    "route", "sql", "command", "file", "upload", "ssrf", "secret",
    "parser", "state", "headers", "host", "identity", "object", "xss",
  ] as const;
  for (const kind of kinds) {
    expect(EXPERT_KEYS).toContain(LENS_BY_KIND[kind]);
  }
});

test("REPO_TOOL_PROTOCOL instructs a plain-JSON final answer, not a tool call", () => {
  expect(REPO_TOOL_PROTOCOL).toContain("NOT a tool call");
  expect(REPO_TOOL_PROTOCOL).toContain("read_file");
});

test("REFUTE_PROTOCOL asks for strict JSON with a refuted boolean", () => {
  expect(REFUTE_PROTOCOL).toContain("strict JSON");
  expect(REFUTE_PROTOCOL).toContain("refuted");
});
