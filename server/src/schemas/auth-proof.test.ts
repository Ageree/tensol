import { describe, expect, it } from "bun:test";

import {
  ChallengeMethodEnum,
  TargetIdParamSchema,
  VerifyChallengeBodySchema,
} from "./auth-proof";

describe("TargetIdParamSchema", () => {
  it("accepts a valid Crockford ULID", () => {
    const ulid = "01HZX5QK9V7Y3W2P8N6M4J0KAB";
    const parsed = TargetIdParamSchema.parse({ id: ulid });
    expect(parsed.id).toBe(ulid);
  });

  it("rejects a lowercase ULID", () => {
    expect(() =>
      TargetIdParamSchema.parse({ id: "01hzx5qk9v7y3w2p8n6m4j0kab" }),
    ).toThrow();
  });

  it("rejects an ID with the wrong length", () => {
    expect(() => TargetIdParamSchema.parse({ id: "01HZX5QK9V" })).toThrow();
  });

  it("rejects a ULID containing forbidden Crockford letters (I, L, O, U)", () => {
    // Replace last char with 'I' which is not in the Crockford alphabet.
    expect(() =>
      TargetIdParamSchema.parse({ id: "01HZX5QK9V7Y3W2P8N6M4J0KAI" }),
    ).toThrow();
  });

  it("rejects a missing id field", () => {
    expect(() => TargetIdParamSchema.parse({})).toThrow();
  });
});

describe("ChallengeMethodEnum", () => {
  it("accepts dns_txt", () => {
    expect(ChallengeMethodEnum.parse("dns_txt")).toBe("dns_txt");
  });

  it("accepts well_known_file", () => {
    expect(ChallengeMethodEnum.parse("well_known_file")).toBe("well_known_file");
  });

  it("accepts meta_tag", () => {
    expect(ChallengeMethodEnum.parse("meta_tag")).toBe("meta_tag");
  });

  it("rejects an unknown method", () => {
    expect(() => ChallengeMethodEnum.parse("smtp")).toThrow();
  });

  it("rejects a non-string value", () => {
    expect(() => ChallengeMethodEnum.parse(42)).toThrow();
  });
});

describe("VerifyChallengeBodySchema", () => {
  it("accepts an empty object", () => {
    const parsed = VerifyChallengeBodySchema.parse({});
    expect(parsed.prefer_method).toBeUndefined();
  });

  it("accepts undefined input via default", () => {
    const parsed = VerifyChallengeBodySchema.parse(undefined);
    // Default kicks in -> empty object.
    expect(parsed.prefer_method).toBeUndefined();
  });

  it("accepts a body with a valid prefer_method", () => {
    const parsed = VerifyChallengeBodySchema.parse({ prefer_method: "dns_txt" });
    expect(parsed.prefer_method).toBe("dns_txt");
  });

  it("accepts well_known_file as prefer_method", () => {
    const parsed = VerifyChallengeBodySchema.parse({
      prefer_method: "well_known_file",
    });
    expect(parsed.prefer_method).toBe("well_known_file");
  });

  it("accepts meta_tag as prefer_method", () => {
    const parsed = VerifyChallengeBodySchema.parse({
      prefer_method: "meta_tag",
    });
    expect(parsed.prefer_method).toBe("meta_tag");
  });

  it("rejects an invalid prefer_method", () => {
    expect(() =>
      VerifyChallengeBodySchema.parse({ prefer_method: "smtp" }),
    ).toThrow();
  });

  it("rejects a non-string prefer_method", () => {
    expect(() =>
      VerifyChallengeBodySchema.parse({ prefer_method: 42 }),
    ).toThrow();
  });
});
