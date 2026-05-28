import { describe, expect, it } from "bun:test";

import { CreateTargetBodySchema, TargetIdParamSchema } from "./targets";

describe("CreateTargetBodySchema", () => {
  it("accepts a well-formed https URL", () => {
    const parsed = CreateTargetBodySchema.parse({ url: "https://example.com" });
    expect(parsed.url).toBe("https://example.com");
  });

  it("accepts an http URL with path and query", () => {
    const parsed = CreateTargetBodySchema.parse({
      url: "http://example.com/path?q=1",
    });
    expect(parsed.url).toBe("http://example.com/path?q=1");
  });

  it("trims whitespace around the URL", () => {
    const parsed = CreateTargetBodySchema.parse({
      url: "  https://example.com  ",
    });
    expect(parsed.url).toBe("https://example.com");
  });

  it("rejects a malformed URL", () => {
    expect(() =>
      CreateTargetBodySchema.parse({ url: "not a url" }),
    ).toThrow();
  });

  it("rejects a URL longer than 2048 characters", () => {
    const tooLong = `https://example.com/${"a".repeat(2048)}`;
    expect(() => CreateTargetBodySchema.parse({ url: tooLong })).toThrow();
  });

  it("rejects a missing url field", () => {
    expect(() => CreateTargetBodySchema.parse({})).toThrow();
  });

  it("rejects a non-string url", () => {
    expect(() => CreateTargetBodySchema.parse({ url: 42 })).toThrow();
  });
});

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

  it("rejects a missing id field", () => {
    expect(() => TargetIdParamSchema.parse({})).toThrow();
  });
});
