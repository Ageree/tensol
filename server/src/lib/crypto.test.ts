import { describe, it, expect } from "bun:test";
import { hmacSha256, timingSafeEqual, randomToken } from "./crypto.ts";

describe("hmacSha256", () => {
  // RFC 4231 test vectors for HMAC-SHA256
  it("RFC 4231 test case 1: key=0x0b*20, data='Hi There'", () => {
    const key = new Uint8Array(20).fill(0x0b);
    const data = "Hi There";
    expect(hmacSha256(key, data)).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("RFC 4231 test case 2: key='Jefe', data='what do ya want for nothing?'", () => {
    expect(hmacSha256("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("is deterministic for the same inputs", () => {
    const a = hmacSha256("key", "msg");
    const b = hmacSha256("key", "msg");
    expect(a).toBe(b);
  });

  it("produces different output for different keys", () => {
    expect(hmacSha256("k1", "msg")).not.toBe(hmacSha256("k2", "msg"));
  });

  it("accepts Uint8Array message", () => {
    const msg = new TextEncoder().encode("Hi There");
    const key = new Uint8Array(20).fill(0x0b);
    const hex = hmacSha256(key, msg);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("randomToken", () => {
  it("returns ~43 base64url chars for default 32 bytes", () => {
    const t = randomToken();
    expect(t.length).toBe(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("respects byte length parameter", () => {
    const t16 = randomToken(16);
    expect(t16.length).toBe(22);
    expect(t16).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique tokens (100 unique samples)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(randomToken());
    }
    expect(tokens.size).toBe(100);
  });
});
