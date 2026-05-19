import { describe, expect, it } from "bun:test";

import {
  AttackSurfaceEntrySchema,
  CreateScanOrderBodySchema,
  HostnameSchema,
  LaunchScanOrderResponseSchema,
  ScanOrderResponseSchema,
  ScanOrderStatusEnum,
  UpdateAttackSurfaceBodySchema,
  UpdateSafetyBodySchema,
} from "./scan-orders";

/**
 * Tests for `server/src/schemas/scan-orders.ts` — Zod schemas covering the US1
 * scan-order lifecycle (create / update-attack-surface / update-safety / launch
 * / read). Schemas mirror `specs/002-blackbox-mvp/contracts/openapi.yaml`
 * (components.schemas.ScanOrder, AttackSurfaceEntry, Hostname) and the field
 * constraints in `data-model.md` E2.
 *
 * Each schema gets ≥5 invalid cases (per T025 brief).
 */

const validUlid = "01HZX5QK9V7Y3W2P8N6M4J0KAB";
const otherUlid = "01HZX5QK9V7Y3W2P8N6M4J0KAC";

// ─────────────────────────────────────────────────────────────────────────────
// HostnameSchema — RFC 1035 lowercase host pattern per openapi `Hostname`.
// ─────────────────────────────────────────────────────────────────────────────

describe("HostnameSchema", () => {
  it("accepts a simple lowercase hostname", () => {
    expect(HostnameSchema.parse("example.com")).toBe("example.com");
  });

  it("accepts subdomains", () => {
    expect(HostnameSchema.parse("api.staging.example.com")).toBe(
      "api.staging.example.com",
    );
  });

  it("accepts hostnames with digits and hyphens", () => {
    expect(HostnameSchema.parse("scanme1-test.nmap.org")).toBe(
      "scanme1-test.nmap.org",
    );
  });

  it("rejects uppercase letters (must be normalized lowercase)", () => {
    expect(() => HostnameSchema.parse("Example.com")).toThrow();
  });

  it("rejects a leading hyphen in a label", () => {
    expect(() => HostnameSchema.parse("-bad.example.com")).toThrow();
  });

  it("rejects a trailing hyphen in a label", () => {
    expect(() => HostnameSchema.parse("bad-.example.com")).toThrow();
  });

  it("rejects spaces", () => {
    expect(() => HostnameSchema.parse("bad host.com")).toThrow();
  });

  it("rejects a URL scheme prefix", () => {
    expect(() => HostnameSchema.parse("http://example.com")).toThrow();
  });

  it("rejects a trailing dot", () => {
    expect(() => HostnameSchema.parse("example.com.")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => HostnameSchema.parse("")).toThrow();
  });

  it("rejects hostnames longer than 253 characters", () => {
    const tooLong = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`;
    expect(tooLong.length).toBeGreaterThan(253);
    expect(() => HostnameSchema.parse(tooLong)).toThrow();
  });

  it("rejects non-string values", () => {
    expect(() => HostnameSchema.parse(42)).toThrow();
    expect(() => HostnameSchema.parse(null)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AttackSurfaceEntrySchema — one row of the attack-surface array.
// Shape: { domain: Hostname, primary: boolean, headers: {k,v}[] (≤10) }.
// ─────────────────────────────────────────────────────────────────────────────

describe("AttackSurfaceEntrySchema", () => {
  it("accepts a minimal valid entry", () => {
    const parsed = AttackSurfaceEntrySchema.parse({
      domain: "example.com",
      primary: true,
      headers: [],
    });
    expect(parsed.domain).toBe("example.com");
    expect(parsed.primary).toBe(true);
    expect(parsed.headers).toEqual([]);
  });

  it("accepts up to 10 headers", () => {
    const headers = Array.from({ length: 10 }, (_, i) => ({
      k: `X-Hdr-${i}`,
      v: `val-${i}`,
    }));
    const parsed = AttackSurfaceEntrySchema.parse({
      domain: "example.com",
      primary: false,
      headers,
    });
    expect(parsed.headers.length).toBe(10);
  });

  it("rejects more than 10 headers", () => {
    const headers = Array.from({ length: 11 }, (_, i) => ({
      k: `X-Hdr-${i}`,
      v: `v`,
    }));
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "example.com",
        primary: false,
        headers,
      }),
    ).toThrow();
  });

  it("rejects invalid hostname in domain", () => {
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "NOT A HOST",
        primary: true,
        headers: [],
      }),
    ).toThrow();
  });

  it("rejects non-boolean primary", () => {
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "example.com",
        primary: "yes",
        headers: [],
      }),
    ).toThrow();
  });

  it("rejects missing headers array", () => {
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "example.com",
        primary: true,
      }),
    ).toThrow();
  });

  it("rejects header with key longer than 64 chars", () => {
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "example.com",
        primary: true,
        headers: [{ k: "x".repeat(65), v: "v" }],
      }),
    ).toThrow();
  });

  it("rejects header with value longer than 1024 chars", () => {
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "example.com",
        primary: true,
        headers: [{ k: "X-Hdr", v: "v".repeat(1025) }],
      }),
    ).toThrow();
  });

  it("rejects header missing required k field", () => {
    expect(() =>
      AttackSurfaceEntrySchema.parse({
        domain: "example.com",
        primary: true,
        headers: [{ v: "v" }],
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CreateScanOrderBodySchema — POST /v1/scan-orders body.
// Required: tier (only 'quick' in MVP), primary_domain (Hostname).
// ─────────────────────────────────────────────────────────────────────────────

describe("CreateScanOrderBodySchema", () => {
  it("accepts a minimal valid body", () => {
    const parsed = CreateScanOrderBodySchema.parse({
      tier: "quick",
      primary_domain: "example.com",
    });
    expect(parsed.tier).toBe("quick");
    expect(parsed.primary_domain).toBe("example.com");
  });

  it("rejects missing tier", () => {
    expect(() =>
      CreateScanOrderBodySchema.parse({ primary_domain: "example.com" }),
    ).toThrow();
  });

  it("rejects missing primary_domain", () => {
    expect(() =>
      CreateScanOrderBodySchema.parse({ tier: "quick" }),
    ).toThrow();
  });

  it("rejects tier='deep' (MVP allows only 'quick' per openapi enum)", () => {
    expect(() =>
      CreateScanOrderBodySchema.parse({
        tier: "deep",
        primary_domain: "example.com",
      }),
    ).toThrow();
  });

  it("rejects an invalid hostname in primary_domain", () => {
    expect(() =>
      CreateScanOrderBodySchema.parse({
        tier: "quick",
        primary_domain: "HAS SPACE",
      }),
    ).toThrow();
  });

  it("rejects a URL in primary_domain", () => {
    expect(() =>
      CreateScanOrderBodySchema.parse({
        tier: "quick",
        primary_domain: "https://example.com",
      }),
    ).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      CreateScanOrderBodySchema.parse({
        tier: "quick",
        primary_domain: "example.com",
        wat: "nope",
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UpdateAttackSurfaceBodySchema — PUT /v1/scan-orders/{id}/attack-surface body.
// Required: attack_surface (1–20 AttackSurfaceEntry items).
// ─────────────────────────────────────────────────────────────────────────────

describe("UpdateAttackSurfaceBodySchema", () => {
  const validEntry = {
    domain: "example.com",
    primary: true,
    headers: [],
  };

  it("accepts a body with one entry", () => {
    const parsed = UpdateAttackSurfaceBodySchema.parse({
      attack_surface: [validEntry],
    });
    expect(parsed.attack_surface.length).toBe(1);
  });

  it("accepts a body with 20 entries", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      domain: `host${i}.example.com`,
      primary: i === 0,
      headers: [],
    }));
    const parsed = UpdateAttackSurfaceBodySchema.parse({
      attack_surface: entries,
    });
    expect(parsed.attack_surface.length).toBe(20);
  });

  it("rejects an empty attack_surface array (minItems=1)", () => {
    expect(() =>
      UpdateAttackSurfaceBodySchema.parse({ attack_surface: [] }),
    ).toThrow();
  });

  it("rejects more than 20 entries (maxItems=20)", () => {
    const entries = Array.from({ length: 21 }, (_, i) => ({
      domain: `host${i}.example.com`,
      primary: i === 0,
      headers: [],
    }));
    expect(() =>
      UpdateAttackSurfaceBodySchema.parse({ attack_surface: entries }),
    ).toThrow();
  });

  it("rejects missing attack_surface field", () => {
    expect(() => UpdateAttackSurfaceBodySchema.parse({})).toThrow();
  });

  it("rejects when one entry has an invalid domain", () => {
    expect(() =>
      UpdateAttackSurfaceBodySchema.parse({
        attack_surface: [validEntry, { ...validEntry, domain: "NOPE" }],
      }),
    ).toThrow();
  });

  it("rejects non-array attack_surface", () => {
    expect(() =>
      UpdateAttackSurfaceBodySchema.parse({
        attack_surface: "not-array",
      }),
    ).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      UpdateAttackSurfaceBodySchema.parse({
        attack_surface: [validEntry],
        extra: 1,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UpdateSafetyBodySchema — PUT /v1/scan-orders/{id}/safety body.
// Required: safety_rps (integer 1–500).
// ─────────────────────────────────────────────────────────────────────────────

describe("UpdateSafetyBodySchema", () => {
  it("accepts safety_rps at lower bound (1)", () => {
    expect(UpdateSafetyBodySchema.parse({ safety_rps: 1 }).safety_rps).toBe(1);
  });

  it("accepts safety_rps at upper bound (500)", () => {
    expect(UpdateSafetyBodySchema.parse({ safety_rps: 500 }).safety_rps).toBe(
      500,
    );
  });

  it("accepts a mid-range integer", () => {
    expect(UpdateSafetyBodySchema.parse({ safety_rps: 50 }).safety_rps).toBe(
      50,
    );
  });

  it("rejects safety_rps=0 (below minimum)", () => {
    expect(() => UpdateSafetyBodySchema.parse({ safety_rps: 0 })).toThrow();
  });

  it("rejects negative safety_rps", () => {
    expect(() => UpdateSafetyBodySchema.parse({ safety_rps: -1 })).toThrow();
  });

  it("rejects safety_rps=501 (above maximum)", () => {
    expect(() => UpdateSafetyBodySchema.parse({ safety_rps: 501 })).toThrow();
  });

  it("rejects non-integer safety_rps (fractional)", () => {
    expect(() => UpdateSafetyBodySchema.parse({ safety_rps: 2.5 })).toThrow();
  });

  it("rejects missing safety_rps", () => {
    expect(() => UpdateSafetyBodySchema.parse({})).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      UpdateSafetyBodySchema.parse({ safety_rps: 50, extra: true }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LaunchScanOrderResponseSchema — 202 body of POST /v1/scan-orders/{id}/launch.
// Required: scan_id (ULID).
// ─────────────────────────────────────────────────────────────────────────────

describe("LaunchScanOrderResponseSchema", () => {
  it("accepts a body with a valid scan_id", () => {
    const parsed = LaunchScanOrderResponseSchema.parse({
      scan_id: validUlid,
    });
    expect(parsed.scan_id).toBe(validUlid);
  });

  it("rejects missing scan_id", () => {
    expect(() => LaunchScanOrderResponseSchema.parse({})).toThrow();
  });

  it("rejects scan_id with wrong length", () => {
    expect(() =>
      LaunchScanOrderResponseSchema.parse({ scan_id: "ABC" }),
    ).toThrow();
  });

  it("rejects scan_id with forbidden chars (lowercase / I / L / O / U)", () => {
    // contains 'I' which is excluded from Crockford alphabet
    expect(() =>
      LaunchScanOrderResponseSchema.parse({
        scan_id: "01HZX5QKIV7Y3W2P8N6M4J0KAB",
      }),
    ).toThrow();
  });

  it("rejects non-string scan_id", () => {
    expect(() =>
      LaunchScanOrderResponseSchema.parse({ scan_id: 12345 }),
    ).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      LaunchScanOrderResponseSchema.parse({
        scan_id: validUlid,
        extra: 1,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ScanOrderStatusEnum — values per openapi enum.
// ─────────────────────────────────────────────────────────────────────────────

describe("ScanOrderStatusEnum", () => {
  it("accepts each canonical status value", () => {
    const statuses = [
      "draft",
      "dns_pending",
      "dns_verified",
      "vm_provisioning",
      "running",
      "completed",
      "failed",
      "cancelled",
    ] as const;
    for (const s of statuses) {
      expect(ScanOrderStatusEnum.parse(s)).toBe(s);
    }
  });

  it("rejects unknown status values", () => {
    expect(() => ScanOrderStatusEnum.parse("scheduled")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ScanOrderResponseSchema — full read shape returned by GET /v1/scan-orders/{id}.
// Per openapi: required [id, user_id, status, tier, primary_domain,
// attack_surface, safety_rps, payment_kind, created_at, updated_at].
// ─────────────────────────────────────────────────────────────────────────────

describe("ScanOrderResponseSchema", () => {
  const baseValid = {
    id: validUlid,
    user_id: otherUlid,
    status: "draft" as const,
    tier: "quick" as const,
    primary_domain: "example.com",
    attack_surface: [
      { domain: "example.com", primary: true, headers: [] },
    ],
    safety_rps: 50,
    payment_kind: "free_quick" as const,
    created_at: 1700000000000,
    updated_at: 1700000000001,
  };

  it("accepts a minimal valid scan-order shape", () => {
    const parsed = ScanOrderResponseSchema.parse(baseValid);
    expect(parsed.id).toBe(validUlid);
    expect(parsed.status).toBe("draft");
    expect(parsed.dns_verify_token ?? null).toBeNull();
  });

  it("accepts optional nullable fields when explicitly null", () => {
    const parsed = ScanOrderResponseSchema.parse({
      ...baseValid,
      dns_verify_token: null,
      dns_verified_at: null,
      scan_id: null,
      failure_reason: null,
      amount_kopecks: null,
    });
    expect(parsed.scan_id).toBeNull();
  });

  it("accepts an empty attack_surface (server may return draft state)", () => {
    const parsed = ScanOrderResponseSchema.parse({
      ...baseValid,
      attack_surface: [],
    });
    expect(parsed.attack_surface.length).toBe(0);
  });

  it("accepts tier='deep' on read shape (orders may exist post-pivot)", () => {
    const parsed = ScanOrderResponseSchema.parse({
      ...baseValid,
      tier: "deep",
    });
    expect(parsed.tier).toBe("deep");
  });

  it("rejects missing required `id`", () => {
    const { id: _id, ...rest } = baseValid;
    expect(() => ScanOrderResponseSchema.parse(rest)).toThrow();
  });

  it("rejects missing required `status`", () => {
    const { status: _s, ...rest } = baseValid;
    expect(() => ScanOrderResponseSchema.parse(rest)).toThrow();
  });

  it("rejects unknown status enum value", () => {
    expect(() =>
      ScanOrderResponseSchema.parse({ ...baseValid, status: "weird" }),
    ).toThrow();
  });

  it("rejects safety_rps above 500", () => {
    expect(() =>
      ScanOrderResponseSchema.parse({ ...baseValid, safety_rps: 999 }),
    ).toThrow();
  });

  it("rejects unknown payment_kind", () => {
    expect(() =>
      ScanOrderResponseSchema.parse({
        ...baseValid,
        payment_kind: "crypto",
      }),
    ).toThrow();
  });

  it("rejects a non-Hostname primary_domain", () => {
    expect(() =>
      ScanOrderResponseSchema.parse({
        ...baseValid,
        primary_domain: "https://example.com",
      }),
    ).toThrow();
  });

  it("rejects non-integer timestamps", () => {
    expect(() =>
      ScanOrderResponseSchema.parse({
        ...baseValid,
        created_at: "2026-05-19",
      }),
    ).toThrow();
  });
});
