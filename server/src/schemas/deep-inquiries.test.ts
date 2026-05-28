import { describe, expect, it } from "bun:test";

import {
  BudgetBandEnum,
  CreateInquiryBodySchema,
  DeepInquiryResponseSchema,
  DeepInquiryStatusEnum,
} from "./deep-inquiries";

/**
 * Tests for `server/src/schemas/deep-inquiries.ts` — Zod schemas covering
 * the US2 Deep-inquiry lead-gen funnel.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/contracts/openapi.yaml`
 *     (paths./v1/deep-inquiries.post.requestBody + components.schemas.DeepInquiry)
 *   - `specs/002-blackbox-mvp/data-model.md` E6 (`deep_inquiries` table)
 *   - `docs/pivot-2026-05-19-telegram-auth.md` — email becomes OPTIONAL;
 *     phone (which may hold a Telegram @handle per data-model E6) stays
 *     required as the mandatory contact channel
 *
 * Per task brief (T095): ≥5 invalid cases per schema, including
 * consent-false, missing email (now valid per pivot), oversized scope_text,
 * bad budget_band, and strict-unknown-field rejection.
 */

const validUlid = "01HZX5QK9V7Y3W2P8N6M4J0KAB";

// ─────────────────────────────────────────────────────────────────────────────
// BudgetBandEnum — values per openapi enum + data-model E6 CHECK constraint.
// ─────────────────────────────────────────────────────────────────────────────

describe("BudgetBandEnum", () => {
  it("accepts each canonical budget band", () => {
    const bands = [
      "under_500k",
      "500k_1m",
      "1m_3m",
      "3m_plus",
      "open",
    ] as const;
    for (const b of bands) {
      expect(BudgetBandEnum.parse(b)).toBe(b);
    }
  });

  it("rejects unknown budget_band 'discuss' (not in openapi enum)", () => {
    expect(() => BudgetBandEnum.parse("discuss")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => BudgetBandEnum.parse("")).toThrow();
  });

  it("rejects numeric input", () => {
    expect(() => BudgetBandEnum.parse(500_000)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DeepInquiryStatusEnum — values per openapi + data-model E6.
// ─────────────────────────────────────────────────────────────────────────────

describe("DeepInquiryStatusEnum", () => {
  it("accepts each canonical status value", () => {
    const statuses = [
      "new",
      "contacted",
      "converted",
      "declined",
      "dropped",
    ] as const;
    for (const s of statuses) {
      expect(DeepInquiryStatusEnum.parse(s)).toBe(s);
    }
  });

  it("rejects unknown status value", () => {
    expect(() => DeepInquiryStatusEnum.parse("qualified")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CreateInquiryBodySchema — POST /v1/deep-inquiries body.
//
// Required (post-pivot): company, contact_name, phone, domains_text,
// scope_text, consent_accepted=true.
// Optional/nullable: email (pivot), position, desired_date, budget_band.
// ─────────────────────────────────────────────────────────────────────────────

describe("CreateInquiryBodySchema", () => {
  const baseValid = {
    company: "Acme Corp",
    contact_name: "Jane Smith",
    phone: "+71234567890",
    domains_text: "example.com\napi.example.com",
    scope_text: "Full perimeter — auth, billing, admin panel.",
    consent_accepted: true as const,
  };

  it("accepts a minimal valid body (no email per pivot)", () => {
    const parsed = CreateInquiryBodySchema.parse(baseValid);
    expect(parsed.company).toBe("Acme Corp");
    expect(parsed.consent_accepted).toBe(true);
    expect(parsed.email ?? null).toBeNull();
  });

  it("accepts a valid body with email present", () => {
    const parsed = CreateInquiryBodySchema.parse({
      ...baseValid,
      email: "jane@acme.example",
    });
    expect(parsed.email).toBe("jane@acme.example");
  });

  it("accepts a Telegram @-handle in the phone field (per data-model E6)", () => {
    const parsed = CreateInquiryBodySchema.parse({
      ...baseValid,
      phone: "@jane_smith",
    });
    expect(parsed.phone).toBe("@jane_smith");
  });

  it("accepts a full body with every optional field populated", () => {
    const parsed = CreateInquiryBodySchema.parse({
      ...baseValid,
      email: "jane@acme.example",
      position: "CISO",
      desired_date: 1_800_000_000_000,
      budget_band: "1m_3m",
    });
    expect(parsed.position).toBe("CISO");
    expect(parsed.budget_band).toBe("1m_3m");
  });

  it("accepts explicitly null email (pivot: email is nullable)", () => {
    const parsed = CreateInquiryBodySchema.parse({
      ...baseValid,
      email: null,
    });
    expect(parsed.email).toBeNull();
  });

  it("rejects consent_accepted=false (must be literal true)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({ ...baseValid, consent_accepted: false }),
    ).toThrow();
  });

  it("rejects consent_accepted as the string 'true' (must be boolean)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({ ...baseValid, consent_accepted: "true" }),
    ).toThrow();
  });

  it("rejects missing consent_accepted entirely", () => {
    const { consent_accepted: _c, ...rest } = baseValid;
    expect(() => CreateInquiryBodySchema.parse(rest)).toThrow();
  });

  it("rejects missing phone (required contact channel post-pivot)", () => {
    const { phone: _p, ...rest } = baseValid;
    expect(() => CreateInquiryBodySchema.parse(rest)).toThrow();
  });

  it("rejects missing company", () => {
    const { company: _c, ...rest } = baseValid;
    expect(() => CreateInquiryBodySchema.parse(rest)).toThrow();
  });

  it("rejects missing contact_name", () => {
    const { contact_name: _n, ...rest } = baseValid;
    expect(() => CreateInquiryBodySchema.parse(rest)).toThrow();
  });

  it("rejects empty scope_text", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({ ...baseValid, scope_text: "" }),
    ).toThrow();
  });

  it("rejects scope_text longer than 10,000 chars (openapi maxLength)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        scope_text: "x".repeat(10_001),
      }),
    ).toThrow();
  });

  it("rejects empty domains_text", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({ ...baseValid, domains_text: "" }),
    ).toThrow();
  });

  it("rejects domains_text longer than 10,000 chars (openapi maxLength)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        domains_text: "x".repeat(10_001),
      }),
    ).toThrow();
  });

  it("rejects company longer than 200 chars (openapi maxLength)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        company: "a".repeat(201),
      }),
    ).toThrow();
  });

  it("rejects contact_name longer than 200 chars (openapi maxLength)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        contact_name: "a".repeat(201),
      }),
    ).toThrow();
  });

  it("rejects position longer than 100 chars (openapi maxLength)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        position: "a".repeat(101),
      }),
    ).toThrow();
  });

  it("rejects phone longer than 50 chars (openapi maxLength)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        phone: "+".padEnd(51, "1"),
      }),
    ).toThrow();
  });

  it("rejects malformed email when email IS provided", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        email: "not-an-email",
      }),
    ).toThrow();
  });

  it("rejects unknown budget_band value", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        budget_band: "trillion_plus",
      }),
    ).toThrow();
  });

  it("rejects non-integer desired_date (must be unix-ms int)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        desired_date: "tomorrow",
      }),
    ).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      CreateInquiryBodySchema.parse({
        ...baseValid,
        secret_field: "leaked",
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DeepInquiryResponseSchema — full read shape returned by admin GET.
// Mirrors openapi `components.schemas.DeepInquiry`.
// ─────────────────────────────────────────────────────────────────────────────

describe("DeepInquiryResponseSchema", () => {
  const baseValid = {
    id: validUlid,
    company: "Acme Corp",
    contact_name: "Jane Smith",
    email: "jane@acme.example",
    phone: "+71234567890",
    domains_text: "example.com",
    scope_text: "Full perimeter test.",
    consent_accepted_at: 1_700_000_000_000,
    status: "new" as const,
    created_at: 1_700_000_000_000,
  };

  it("accepts a minimal valid read shape", () => {
    const parsed = DeepInquiryResponseSchema.parse(baseValid);
    expect(parsed.id).toBe(validUlid);
    expect(parsed.status).toBe("new");
  });

  it("accepts optional nullable fields when explicitly null", () => {
    const parsed = DeepInquiryResponseSchema.parse({
      ...baseValid,
      user_id: null,
      position: null,
      desired_date: null,
      budget_band: null,
    });
    expect(parsed.user_id).toBeNull();
    expect(parsed.budget_band).toBeNull();
  });

  it("accepts a populated user_id (authenticated submission)", () => {
    const parsed = DeepInquiryResponseSchema.parse({
      ...baseValid,
      user_id: validUlid,
    });
    expect(parsed.user_id).toBe(validUlid);
  });

  it("rejects missing required `id`", () => {
    const { id: _id, ...rest } = baseValid;
    expect(() => DeepInquiryResponseSchema.parse(rest)).toThrow();
  });

  it("rejects missing required `status`", () => {
    const { status: _s, ...rest } = baseValid;
    expect(() => DeepInquiryResponseSchema.parse(rest)).toThrow();
  });

  it("rejects unknown status enum value", () => {
    expect(() =>
      DeepInquiryResponseSchema.parse({ ...baseValid, status: "weird" }),
    ).toThrow();
  });

  it("rejects unknown budget_band on read shape", () => {
    expect(() =>
      DeepInquiryResponseSchema.parse({
        ...baseValid,
        budget_band: "discuss",
      }),
    ).toThrow();
  });

  it("rejects non-integer created_at", () => {
    expect(() =>
      DeepInquiryResponseSchema.parse({
        ...baseValid,
        created_at: "2026-05-19",
      }),
    ).toThrow();
  });
});
