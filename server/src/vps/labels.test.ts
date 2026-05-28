/**
 * Unit tests for `sanitizeLabels` — GCP Compute label sanitiser.
 *
 * Regression test for production bug found 2026-05-21:
 * ULID label values (uppercase Crockford-base32) were passed raw to
 * Compute API which enforces `[a-z0-9_-]*` on both keys AND values,
 * causing every real spawn to fail with HTTP 400.
 */

import { describe, expect, test } from "bun:test";

import { sanitizeLabels } from "./gcp";

describe("sanitizeLabels", () => {
  test("lowercases ULID keys and values", () => {
    const input = { "TENSOL-SCAN-ID": "01KS50MGVHBV0AX6Y7VJDKM5WA" };
    expect(sanitizeLabels(input)).toEqual({
      "tensol-scan-id": "01ks50mgvhbv0ax6y7vjdkm5wa",
    });
  });

  test("replaces invalid chars (dot, slash) with underscore", () => {
    const input = { foo: "bar.baz/quux" };
    expect(sanitizeLabels(input)).toEqual({ foo: "bar_baz_quux" });
  });

  test("empty input returns empty object", () => {
    expect(sanitizeLabels({})).toEqual({});
  });

  test("already-clean input is identity (lowercased)", () => {
    const input = {
      "tensol-scan-id": "abc123",
      "tensol-scan-order-id": "x_y-z",
    };
    expect(sanitizeLabels(input)).toEqual(input);
  });

  test("handles realistic scan-spawn metadata payload", () => {
    const input = {
      "tensol-scan-id": "01KS50MGVHBV0AX6Y7VJDKM5WA",
      "tensol-scan-order-id": "01KS50MGVHBV0AX6Y7VJDKM5WB",
    };
    expect(sanitizeLabels(input)).toEqual({
      "tensol-scan-id": "01ks50mgvhbv0ax6y7vjdkm5wa",
      "tensol-scan-order-id": "01ks50mgvhbv0ax6y7vjdkm5wb",
    });
  });
});
