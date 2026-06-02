/**
 * T019 — feature flags for MVP.
 *
 * Per research.md §R13: YooKassa is dark-coded in MVP. The
 * isYookassaLive() flag gates any payment code path; defaults
 * to false so payment routes return 503 unless explicitly
 * enabled at deploy via TENSOL_YOOKASSA_LIVE=true.
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
