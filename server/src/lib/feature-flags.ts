/**
 * T019 — feature flags for MVP.
 *
 * 2026-06-05 pivot: YooKassa is no longer a product target. This helper is
 * retained only for legacy pre-pivot compatibility while the REST surface still
 * returns `yookassa_live`. New billing work must use provider-agnostic
 * billing/entitlement flags instead.
 */
export function isYookassaLive(): boolean {
  return process.env.TENSOL_YOOKASSA_LIVE === "true";
}

/** Strict truthy check mirroring config.ts `envBool` (1|true|yes|on,
 *  case-insensitive). Read at request time so a flip takes effect without a
 *  reboot, matching the no-snapshot contract of the feature-flags route. */
function envFlag(value: string | undefined): boolean {
  return value === undefined ? false : /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Deep Whitebox Research (F1) availability. When true the dashboard may offer a
 * per-review "deep research" toggle and `POST /v1/review/whitebox` honors
 * `mode: "deep"`. Gated by TENSOL_RESEARCH_ENABLED (off by default).
 */
export function isResearchEnabled(): boolean {
  return envFlag(process.env.TENSOL_RESEARCH_ENABLED);
}

/**
 * Autonomous Exploit Lab (F2) availability. When true the dashboard surfaces
 * exploit verdicts (proven PoCs) on findings. Gated by TENSOL_EXPLOIT_ENABLED
 * (off by default). NOTE: this only reflects whether verdicts may be PRODUCED +
 * shown; the actual PoC EXECUTION stays behind the server's sandbox safety gate
 * (TENSOL_EXPLOIT_ALLOW_UNSANDBOXED_LOCAL / a wired VM sandbox).
 */
export function isExploitEnabled(): boolean {
  return envFlag(process.env.TENSOL_EXPLOIT_ENABLED);
}

export type BillingProvider =
  | "none"
  | "manual"
  | "paddle"
  | "lemonsqueezy"
  | "polar"
  | "stripe"
  | "clerk_billing"
  | "oxapay";

export function billingProvider(): BillingProvider {
  const value = process.env.TENSOL_BILLING_PROVIDER?.trim().toLowerCase();
  if (
    value === "none" ||
    value === "manual" ||
    value === "paddle" ||
    value === "lemonsqueezy" ||
    value === "polar" ||
    value === "stripe" ||
    value === "clerk_billing" ||
    value === "oxapay"
  ) {
    return value;
  }
  return "manual";
}

export function isBillingLive(): boolean {
  return billingProvider() !== "none";
}
