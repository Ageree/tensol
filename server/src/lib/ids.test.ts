import { describe, it, expect } from "bun:test";
import { ulid } from "./ids.ts";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  it("returns 26-char Crockford Base32 string", () => {
    const id = ulid();
    expect(id).toMatch(CROCKFORD);
    expect(id.length).toBe(26);
  });

  it("is monotonically increasing within the same millisecond", () => {
    const fixed = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(ulid(fixed));
    }
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1]!;
      const cur = ids[i]!;
      expect(cur > prev).toBe(true);
    }
  });

  it("encodes the timestamp in the first 10 chars (decodable)", () => {
    const fixed = 1_700_000_000_000;
    const id = ulid(fixed);
    const prefix = id.slice(0, 10);
    // Decode Crockford Base32 timestamp
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ts = 0;
    for (const ch of prefix) {
      const v = alphabet.indexOf(ch);
      expect(v).toBeGreaterThanOrEqual(0);
      ts = ts * 32 + v;
    }
    expect(ts).toBe(fixed);
  });

  it("produces strictly increasing values across consecutive ms", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(b > a).toBe(true);
  });

  it("uses only Crockford-allowed characters (no I, L, O, U)", () => {
    for (let i = 0; i < 100; i++) {
      const id = ulid();
      expect(id).not.toMatch(/[ILOU]/);
    }
  });
});
