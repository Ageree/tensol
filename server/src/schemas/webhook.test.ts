import { describe, expect, it } from "bun:test";

import {
  FindingSeverityEnum,
  FindingSchema,
  ScanProgressCallbackSchema,
  WebhookStatusEnum,
} from "./webhook";

const VALID_ULID = "01HZX5QK9V7Y3W2P8N6M4J0KAB";

const VALID_FINDING = {
  severity: "high" as const,
  title: "Reflected XSS on /search?q=",
  body_md: "## XSS\nPayload reflected unescaped.",
  evidence: { request: "GET /search?q=<x>", response: "<x>" },
};

describe("FindingSeverityEnum", () => {
  it("accepts every defined severity in the data-model order", () => {
    for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
      expect(FindingSeverityEnum.parse(sev)).toBe(sev);
    }
  });

  it("rejects an unknown severity", () => {
    expect(() => FindingSeverityEnum.parse("catastrophic")).toThrow();
  });

  it("rejects a numeric value", () => {
    expect(() => FindingSeverityEnum.parse(3)).toThrow();
  });
});

describe("WebhookStatusEnum", () => {
  it("accepts done", () => {
    expect(WebhookStatusEnum.parse("done")).toBe("done");
  });

  it("accepts failed", () => {
    expect(WebhookStatusEnum.parse("failed")).toBe("failed");
  });

  it("rejects running (not a terminal callback)", () => {
    expect(() => WebhookStatusEnum.parse("running")).toThrow();
  });

  it("rejects completed (use 'done' per webhook contract)", () => {
    expect(() => WebhookStatusEnum.parse("completed")).toThrow();
  });
});

describe("FindingSchema", () => {
  it("accepts a fully populated finding", () => {
    const parsed = FindingSchema.parse(VALID_FINDING);
    expect(parsed.severity).toBe("high");
    expect(parsed.title).toBe(VALID_FINDING.title);
  });

  it("accepts a finding without optional evidence", () => {
    const { evidence: _evidence, ...minimal } = VALID_FINDING;
    const parsed = FindingSchema.parse(minimal);
    expect(parsed.evidence).toBeUndefined();
  });

  it("rejects an empty title", () => {
    expect(() =>
      FindingSchema.parse({ ...VALID_FINDING, title: "" }),
    ).toThrow();
  });

  it("rejects body_md exceeding 50000 chars", () => {
    expect(() =>
      FindingSchema.parse({
        ...VALID_FINDING,
        body_md: "x".repeat(50_001),
      }),
    ).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() =>
      FindingSchema.parse({ ...VALID_FINDING, severity: "fatal" }),
    ).toThrow();
  });

  it("rejects a missing severity", () => {
    const { severity: _sev, ...rest } = VALID_FINDING;
    expect(() => FindingSchema.parse(rest)).toThrow();
  });
});

describe("ScanProgressCallbackSchema — status='done'", () => {
  it("accepts a done callback with findings", () => {
    const parsed = ScanProgressCallbackSchema.parse({
      scan_id: VALID_ULID,
      status: "done",
      failure_reason: null,
      usage: { tokens: 12345, usd_cents: 87 },
      findings: [VALID_FINDING],
    });
    if (parsed.status !== "done") throw new Error("expected done");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.usage?.tokens).toBe(12345);
  });

  it("accepts a done callback with empty findings array", () => {
    const parsed = ScanProgressCallbackSchema.parse({
      scan_id: VALID_ULID,
      status: "done",
      failure_reason: null,
      usage: null,
      findings: [],
    });
    if (parsed.status !== "done") throw new Error("expected done");
    expect(parsed.findings).toEqual([]);
    expect(parsed.usage).toBeNull();
  });

  it("defaults findings to [] when omitted on done", () => {
    const parsed = ScanProgressCallbackSchema.parse({
      scan_id: VALID_ULID,
      status: "done",
      failure_reason: null,
      usage: null,
    });
    if (parsed.status !== "done") throw new Error("expected done");
    expect(parsed.findings).toEqual([]);
  });

  it("rejects findings array exceeding 1000 entries", () => {
    const tooMany = Array.from({ length: 1001 }, () => VALID_FINDING);
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: VALID_ULID,
        status: "done",
        failure_reason: null,
        usage: null,
        findings: tooMany,
      }),
    ).toThrow();
  });
});

describe("ScanProgressCallbackSchema — status='failed'", () => {
  it("accepts a failed callback with reason string + null usage + no findings", () => {
    const parsed = ScanProgressCallbackSchema.parse({
      scan_id: VALID_ULID,
      status: "failed",
      failure_reason: "agent_timeout",
      usage: null,
    });
    if (parsed.status !== "failed") throw new Error("expected failed");
    expect(parsed.failure_reason).toBe("agent_timeout");
    expect(parsed.findings).toEqual([]);
  });

  it("accepts a failed callback with null failure_reason", () => {
    const parsed = ScanProgressCallbackSchema.parse({
      scan_id: VALID_ULID,
      status: "failed",
      failure_reason: null,
      usage: null,
    });
    if (parsed.status !== "failed") throw new Error("expected failed");
    expect(parsed.failure_reason).toBeNull();
  });

  it("rejects an empty failure_reason string", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: VALID_ULID,
        status: "failed",
        failure_reason: "",
        usage: null,
      }),
    ).toThrow();
  });
});

describe("ScanProgressCallbackSchema — structural validation", () => {
  it("rejects a missing scan_id", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        status: "done",
        failure_reason: null,
        usage: null,
        findings: [],
      }),
    ).toThrow();
  });

  it("rejects a non-ULID scan_id", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: "not-a-ulid",
        status: "done",
        failure_reason: null,
        usage: null,
        findings: [],
      }),
    ).toThrow();
  });

  it("rejects an unknown status (e.g. 'running')", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: VALID_ULID,
        status: "running",
        failure_reason: null,
        usage: null,
        findings: [],
      }),
    ).toThrow();
  });

  it("rejects usage with negative tokens", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: VALID_ULID,
        status: "done",
        failure_reason: null,
        usage: { tokens: -1, usd_cents: 0 },
        findings: [],
      }),
    ).toThrow();
  });

  it("rejects usage with non-integer tokens", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: VALID_ULID,
        status: "done",
        failure_reason: null,
        usage: { tokens: 1.5, usd_cents: 0 },
        findings: [],
      }),
    ).toThrow();
  });

  it("rejects a finding with invalid severity nested in a done callback", () => {
    expect(() =>
      ScanProgressCallbackSchema.parse({
        scan_id: VALID_ULID,
        status: "done",
        failure_reason: null,
        usage: null,
        findings: [{ ...VALID_FINDING, severity: "catastrophic" }],
      }),
    ).toThrow();
  });
});
