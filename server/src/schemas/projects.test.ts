import { describe, expect, it } from "bun:test";

import { CreateProjectBodySchema, ProjectIdParamSchema } from "./projects";

describe("CreateProjectBodySchema", () => {
  it("accepts a well-formed name", () => {
    const parsed = CreateProjectBodySchema.parse({ name: "My Project" });
    expect(parsed.name).toBe("My Project");
  });

  it("trims whitespace from the name", () => {
    const parsed = CreateProjectBodySchema.parse({ name: "  Acme  " });
    expect(parsed.name).toBe("Acme");
  });

  it("rejects a whitespace-only name (post-trim empty)", () => {
    expect(() => CreateProjectBodySchema.parse({ name: "  " })).toThrow();
  });

  it("rejects a name longer than 100 characters", () => {
    const tooLong = "a".repeat(101);
    expect(() => CreateProjectBodySchema.parse({ name: tooLong })).toThrow();
  });

  it("accepts a name at the 100-character boundary", () => {
    const justRight = "a".repeat(100);
    const parsed = CreateProjectBodySchema.parse({ name: justRight });
    expect(parsed.name.length).toBe(100);
  });

  it("rejects a missing name field", () => {
    expect(() => CreateProjectBodySchema.parse({})).toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() => CreateProjectBodySchema.parse({ name: 42 })).toThrow();
  });
});

describe("ProjectIdParamSchema", () => {
  it("accepts a valid Crockford ULID", () => {
    const ulid = "01HZX5QK9V7Y3W2P8N6M4J0KAB";
    // 26 chars, Crockford alphabet
    const parsed = ProjectIdParamSchema.parse({ id: ulid });
    expect(parsed.id).toBe(ulid);
  });

  it("rejects a lowercase ULID", () => {
    expect(() =>
      ProjectIdParamSchema.parse({ id: "01hzx5qk9v7y3w2p8n6m4j0kab" }),
    ).toThrow();
  });

  it("rejects an ID with the wrong length", () => {
    expect(() => ProjectIdParamSchema.parse({ id: "01HZX5QK9V" })).toThrow();
  });

  it("rejects an ID containing forbidden Crockford chars (I, L, O, U)", () => {
    // 26 chars but contains 'I' — not in Crockford alphabet
    expect(() =>
      ProjectIdParamSchema.parse({ id: "01HZX5QK9V7Y3W2P8N6M4J0KAI" }),
    ).toThrow();
  });

  it("rejects a missing id field", () => {
    expect(() => ProjectIdParamSchema.parse({})).toThrow();
  });
});
