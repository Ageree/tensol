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
