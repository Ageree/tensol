import { describe, it, expect } from "bun:test";
import { renderMagicLinkEmail } from "./magic-link.ts";

const baseArgs = {
  email: "user@example.com",
  verifyUrl: "https://tensol.io/api/auth/verify?token=abc123",
  expiresAtMs: Date.now() + 15 * 60 * 1000,
};

describe("renderMagicLinkEmail — html body", () => {
  it("contains the verifyUrl as the CTA href", () => {
    const { html } = renderMagicLinkEmail(baseArgs);
    expect(html).toContain(baseArgs.verifyUrl);
  });

  it("contains the recipient email", () => {
    const { html } = renderMagicLinkEmail(baseArgs);
    expect(html).toContain(baseArgs.email);
  });

  it("contains the brand name (default = Tensol)", () => {
    const { html } = renderMagicLinkEmail(baseArgs);
    expect(html).toContain("Tensol");
  });

  it("respects a custom brand name", () => {
    const { html } = renderMagicLinkEmail({
      ...baseArgs,
      brand: { name: "Acme" },
    });
    expect(html).toContain("Acme");
  });

  it("escapes HTML-special characters in the email field", () => {
    const { html } = renderMagicLinkEmail({
      ...baseArgs,
      email: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes an expiry hint mentioning minutes", () => {
    const { html } = renderMagicLinkEmail(baseArgs);
    expect(html.toLowerCase()).toMatch(/15|минут|minute/);
  });
});

describe("renderMagicLinkEmail — text fallback", () => {
  it("contains the raw verify URL", () => {
    const { text } = renderMagicLinkEmail(baseArgs);
    expect(text).toContain(baseArgs.verifyUrl);
  });

  it("is non-empty plain text (no html tags)", () => {
    const { text } = renderMagicLinkEmail(baseArgs);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/<[a-z]/i);
  });
});

describe("renderMagicLinkEmail — subject", () => {
  it("returns a non-empty subject line", () => {
    const { subject } = renderMagicLinkEmail(baseArgs);
    expect(subject).toBeTruthy();
    expect(subject.length).toBeGreaterThan(3);
  });

  it("references Tensol by default", () => {
    const { subject } = renderMagicLinkEmail(baseArgs);
    expect(subject).toContain("Tensol");
  });
});
