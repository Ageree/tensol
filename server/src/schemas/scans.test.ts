import { describe, expect, it } from "bun:test";

import {
  ScanIdParamSchema,
  ScanProfileEnum,
  StartScanBodySchema,
} from "./scans";

describe("ScanProfileEnum", () => {
  it("accepts recon", () => {
    expect(ScanProfileEnum.parse("recon")).toBe("recon");
  });

  it("accepts standard", () => {
    expect(ScanProfileEnum.parse("standard")).toBe("standard");
  });

  it("accepts max", () => {
    expect(ScanProfileEnum.parse("max")).toBe("max");
  });

  it("rejects an unknown profile", () => {
    expect(() => ScanProfileEnum.parse("extreme")).toThrow();
  });

  it("rejects a non-string value", () => {
    expect(() => ScanProfileEnum.parse(7)).toThrow();
  });
});

describe("StartScanBodySchema", () => {
  const validUlid = "01HZX5QK9V7Y3W2P8N6M4J0KAB";

  it("accepts a valid target_id + profile body", () => {
    const parsed = StartScanBodySchema.parse({
      target_id: validUlid,
      profile: "standard",
    });
    expect(parsed.target_id).toBe(validUlid);
    expect(parsed.profile).toBe("standard");
  });

  it("accepts each profile value paired with a valid target_id", () => {
    for (const profile of ["recon", "standard", "max"] as const) {
      const parsed = StartScanBodySchema.parse({
        target_id: validUlid,
        profile,
      });
      expect(parsed.profile).toBe(profile);
    }
  });

  it("rejects a missing target_id", () => {
    expect(() =>
      StartScanBodySchema.parse({ profile: "standard" }),
    ).toThrow();
  });

  it("rejects a missing profile (required by OpenAPI contract)", () => {
    expect(() =>
      StartScanBodySchema.parse({ target_id: validUlid }),
    ).toThrow();
  });

  it("rejects an invalid profile value", () => {
    expect(() =>
      StartScanBodySchema.parse({ target_id: validUlid, profile: "extreme" }),
    ).toThrow();
  });

  it("rejects a non-ULID target_id (too short)", () => {
    expect(() =>
      StartScanBodySchema.parse({ target_id: "abc", profile: "standard" }),
    ).toThrow();
  });

  it("rejects a lowercase target_id", () => {
    expect(() =>
      StartScanBodySchema.parse({
        target_id: "01hzx5qk9v7y3w2p8n6m4j0kab",
        profile: "standard",
      }),
    ).toThrow();
  });

  it("rejects a target_id containing forbidden Crockford letters (I, L, O, U)", () => {
    // Replace last char with 'I' which is not in the Crockford alphabet.
    expect(() =>
      StartScanBodySchema.parse({
        target_id: "01HZX5QK9V7Y3W2P8N6M4J0KAI",
        profile: "standard",
      }),
    ).toThrow();
  });
});

describe("ScanIdParamSchema", () => {
  it("accepts a valid Crockford ULID", () => {
    const ulid = "01HZX5QK9V7Y3W2P8N6M4J0KAB";
    const parsed = ScanIdParamSchema.parse({ id: ulid });
    expect(parsed.id).toBe(ulid);
  });

  it("rejects a missing id field", () => {
    expect(() => ScanIdParamSchema.parse({})).toThrow();
  });

  it("rejects a ULID with the wrong length", () => {
    expect(() => ScanIdParamSchema.parse({ id: "01HZX5QK9V" })).toThrow();
  });

  it("rejects a ULID containing forbidden Crockford letter U", () => {
    // 'U' is excluded from Crockford alphabet.
    expect(() =>
      ScanIdParamSchema.parse({ id: "01HZX5QK9V7Y3W2P8N6M4J0KAU" }),
    ).toThrow();
  });
});
