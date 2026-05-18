import { randomBytes } from "node:crypto";

/**
 * Crockford Base32 alphabet (excludes I, L, O, U to avoid ambiguity).
 * Reference: https://github.com/ulid/spec
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;
const RAND_BYTES = 10; // 80 bits → 16 Crockford chars

let lastMs = -1;
let lastRand: Uint8Array = new Uint8Array(RAND_BYTES);

function encodeTime(ms: number): string {
  let n = ms;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const idx = n % 32;
    out[i] = ALPHABET[idx]!;
    n = Math.floor(n / 32);
  }
  return out.join("");
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes = 80 bits → 16 chars of base32 (5 bits each).
  // Read as a bit stream MSB-first.
  let bits = 0;
  let value = 0;
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i]! & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const idx = (value >>> bits) & 0x1f;
      out.push(ALPHABET[idx]!);
    }
  }
  // 80 bits / 5 = 16 chars exactly, no remainder.
  return out.join("");
}

function incrementRandom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 0xff) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0;
  }
  // Overflow — extremely unlikely (2^80 ids in same ms). Re-seed.
  return new Uint8Array(randomBytes(RAND_BYTES));
}

/**
 * Generate a ULID: 26 chars, Crockford Base32, lexicographically sortable.
 * Monotonic within the same millisecond in this process.
 */
export function ulid(now?: number): string {
  const ms = now ?? Date.now();
  let rand: Uint8Array;
  if (ms === lastMs) {
    rand = incrementRandom(lastRand);
  } else {
    rand = new Uint8Array(randomBytes(RAND_BYTES));
  }
  lastMs = ms;
  lastRand = rand;
  const timePart = encodeTime(ms);
  const randPart = encodeRandom(rand);
  // Defensive: shouldn't happen but guards against future tweaks.
  if (timePart.length !== TIME_LEN || randPart.length !== RAND_LEN) {
    throw new Error("ulid: invalid internal encoding length");
  }
  return timePart + randPart;
}
