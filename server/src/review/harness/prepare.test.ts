import { test, expect } from "bun:test";
import { runPrepare } from "./prepare.ts";
import type { DiffFile } from "../types.ts";
import type { LlmClient } from "../reviewer.ts";

const files: DiffFile[] = [
  {
    path: "a.ts",
    status: "added",
    contents: "const id = req.query.id; db.query(`SELECT * FROM users WHERE id=${id}`);",
  },
];
const reconLlm: LlmClient = { complete: async () => "## Threat model\n- entry: req.query" };

test("prepare returns candidates, units and a threat-model md", async () => {
  const r = await runPrepare({ files, rawFindings: [], reconLlm, maxAuditors: 12 });
  expect(Array.isArray(r.candidates)).toBe(true);
  expect(Array.isArray(r.units)).toBe(true);
  expect(typeof r.threatModelMd).toBe("string");
  expect(r.threatModelMd).toContain("Threat model");
});

test("prepare tolerates recon failure (empty threat model, still has units)", async () => {
  const downLlm: LlmClient = {
    complete: async () => {
      throw new Error("down");
    },
  };
  const r = await runPrepare({ files, rawFindings: [], reconLlm: downLlm, maxAuditors: 12 });
  expect(r.threatModelMd).toBe("");
  expect(Array.isArray(r.units)).toBe(true);
});
