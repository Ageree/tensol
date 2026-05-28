import { describe, expect, it } from "bun:test";

import { RequestLinkBodySchema, VerifyLinkQuerySchema } from "./auth";

describe("RequestLinkBodySchema", () => {
  it("accepts a well-formed email", () => {
    const parsed = RequestLinkBodySchema.parse({ email: "user@example.com" });
    expect(parsed.email).toBe("user@example.com");
  });

  it("trims and lowercases the email", () => {
    const parsed = RequestLinkBodySchema.parse({ email: " USER@Example.COM " });
    expect(parsed.email).toBe("user@example.com");
  });

  it("rejects an invalid email", () => {
    expect(() => RequestLinkBodySchema.parse({ email: "not-email" })).toThrow();
  });

  it("rejects a missing email field", () => {
    expect(() => RequestLinkBodySchema.parse({})).toThrow();
  });

  it("rejects an email longer than 254 characters", () => {
    const local = "a".repeat(250);
    const tooLong = `${local}@x.com`;
    expect(() => RequestLinkBodySchema.parse({ email: tooLong })).toThrow();
  });

  it("rejects a non-string email", () => {
    expect(() => RequestLinkBodySchema.parse({ email: 123 })).toThrow();
  });
});

describe("VerifyLinkQuerySchema", () => {
  it("accepts a well-formed base64url-looking token", () => {
    const parsed = VerifyLinkQuerySchema.parse({ token: "abcDEF_123-456" });
    expect(parsed.token).toBe("abcDEF_123-456");
  });

  it("rejects an empty token", () => {
    expect(() => VerifyLinkQuerySchema.parse({ token: "" })).toThrow();
  });

  it("rejects a missing token field", () => {
    expect(() => VerifyLinkQuerySchema.parse({})).toThrow();
  });

  it("rejects a token longer than 128 characters", () => {
    const tooLong = "a".repeat(129);
    expect(() => VerifyLinkQuerySchema.parse({ token: tooLong })).toThrow();
  });
});
