import { test, expect } from "bun:test";
import { buildThreatModel, runReconPass } from "./threat-model.ts";
import type { RoutingUnit } from "../research/types.ts";

const unit = (over: Partial<RoutingUnit> = {}): RoutingUnit => ({
  id: "U001",
  kind: "sql",
  category: "sinks",
  filePath: "a.ts",
  line: 3,
  snippet: "db.query(x)",
  signals: ["sql"],
  ...over,
});

test("maps kind to lens and bounds count", () => {
  const units = [
    unit({}),
    unit({ id: "U002", kind: "secret", filePath: "b.ts", signals: ["apiKey"] }),
    unit({ id: "U003", kind: "identity", filePath: "c.ts", signals: ["login"] }),
  ];
  const out = buildThreatModel({ units, rawFindings: [], maxUnits: 2 });
  expect(out.length).toBe(2);
  expect(out[0]!.lens).toBeDefined();
  expect(out.every((u) => u.priority >= 0 && u.priority <= 1)).toBe(true);
});

test("sql kind → injection lens; secret → sensitive-information-exposure", () => {
  const out = buildThreatModel({
    units: [unit({ kind: "sql" }), unit({ id: "U2", kind: "secret", filePath: "s.ts" })],
    rawFindings: [],
    maxUnits: 10,
  });
  const byFile = Object.fromEntries(out.map((u) => [u.filePath, u.lens]));
  expect(byFile["a.ts"]).toBe("injection");
  expect(byFile["s.ts"]).toBe("sensitive-information-exposure");
});

test("git recency raises priority", () => {
  const units = [unit({ id: "h", filePath: "hot.ts" }), unit({ id: "c", filePath: "cold.ts" })];
  const out = buildThreatModel({ units, rawFindings: [], gitRecency: { "hot.ts": 1 }, maxUnits: 2 });
  expect(out[0]!.filePath).toBe("hot.ts");
});

test("SAST corroboration raises priority", () => {
  const units = [unit({ id: "x", filePath: "flagged.ts" }), unit({ id: "y", filePath: "plain.ts" })];
  const raw = [{ ruleId: "r", source: "sast" as const, filePath: "flagged.ts", message: "m" }];
  const out = buildThreatModel({ units, rawFindings: raw, maxUnits: 2 });
  expect(out[0]!.filePath).toBe("flagged.ts");
});

test("unknown kind falls back to insecure-design", () => {
  const out = buildThreatModel({ units: [unit({ kind: "nonsense" as never })], rawFindings: [], maxUnits: 5 });
  expect(out[0]!.lens).toBe("insecure-design");
});

test("runReconPass returns the model summary, tolerates failure", async () => {
  const ok = await runReconPass({ complete: async () => "## TM" } as never, "summary");
  expect(ok).toContain("TM");
  const fail = await runReconPass({ complete: async () => { throw new Error("down"); } } as never, "summary");
  expect(fail).toBe("");
});
