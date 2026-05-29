/**
 * Learning loop — suppression derivation + rules-file application.
 * Feature 004-sthrip-pr-review, T045 (US5 / FR-023/024).
 *
 * PURE module: no DB reads or writes here. The service.ts layer owns the
 * actual persistence of review_suppressions rows and the
 * `review_category_suppressed` audit event. This module provides the
 * deterministic derivation and application functions.
 *
 * Hard invariant (FR-024, Constitution): NEVER_SUPPRESS categories are
 * never returned by deriveSuppressions, regardless of how many dismissals
 * have accumulated.
 */

import type { ReviewFeedback } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum size of a .sthrip/rules.md file we will process (64 KiB). */
const RULES_MD_MAX_BYTES = 64 * 1024;

/**
 * Categories that can NEVER be suppressed (FR-024).
 * Enforced as a code-level invariant — not configurable.
 */
export const NEVER_SUPPRESS = new Set<string>(["security", "correctness"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A decision to suppress a particular category for a repository.
 * Returned by deriveSuppressions; the caller (service.ts) persists this.
 */
export interface SuppressionDecision {
  category: string;
  reason: "ignored_n_times" | "manual";
  ignoreCount: number;
}

/**
 * Parsed content from a .sthrip/rules.md file.
 * Both fields are empty arrays when the rules file is absent or empty.
 */
export interface ParsedRules {
  /** Path prefixes / globs that should not be reported. */
  ignoredPaths: string[];
  /** Source identifiers the team considers trusted (suppresses taint-source warnings). */
  trustedSources: string[];
}

// ---------------------------------------------------------------------------
// deriveSuppressions (T045)
// ---------------------------------------------------------------------------

/**
 * Derive suppression decisions from persisted feedback rows.
 *
 * Algorithm:
 * 1. Filter to `signal === 'ignored'` rows only.
 * 2. Extract the category from `commentText` (trimmed). Rows with null/empty
 *    commentText are silently skipped — no category can be derived.
 * 3. Count per-category ignores.
 * 4. For any category whose count ≥ threshold, emit a SuppressionDecision —
 *    UNLESS the category is in NEVER_SUPPRESS (hard invariant FR-024).
 *
 * @param args.feedback  – all ReviewFeedback rows for the repo (caller fetches).
 * @param args.threshold – the STHRIP_SUPPRESS_AFTER_N_IGNORES config value.
 * @returns An array of SuppressionDecision objects (may be empty).
 */
export function deriveSuppressions(args: {
  feedback: ReviewFeedback[];
  threshold: number;
}): SuppressionDecision[] {
  const { feedback, threshold } = args;

  // Count per-category ignores (only 'ignored' signals with a non-empty commentText).
  const counts = new Map<string, number>();

  for (const row of feedback) {
    if (row.signal !== "ignored") continue;
    const raw = row.commentText;
    if (raw === null || raw === undefined) continue;
    const category = raw.trim();
    if (category === "") continue;

    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  // Derive suppression decisions, honouring the NEVER_SUPPRESS invariant.
  const decisions: SuppressionDecision[] = [];

  for (const [category, count] of counts) {
    // FR-024 hard invariant: security and correctness are NEVER suppressed.
    if (NEVER_SUPPRESS.has(category)) continue;

    if (count >= threshold) {
      decisions.push({
        category,
        reason: "ignored_n_times",
        ignoreCount: count,
      });
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// applySuppressions (T045)
// ---------------------------------------------------------------------------

/**
 * Filter out findings whose category appears in the suppressed set.
 *
 * Generic over T so callers can pass either ReviewFinding[] or plain objects.
 * Findings with null/undefined category are passed through unchanged.
 *
 * @param findings    – the candidate findings (immutable — not mutated).
 * @param suppressed  – a ReadonlySet of suppressed category strings.
 * @returns A new array with suppressed-category findings removed.
 */
export function applySuppressions<T extends { category?: string | null }>(
  findings: T[],
  suppressed: ReadonlySet<string>,
): T[] {
  if (suppressed.size === 0) return [...findings];

  return findings.filter((f) => {
    const cat = f.category;
    if (cat === null || cat === undefined) return true;
    return !suppressed.has(cat);
  });
}

// ---------------------------------------------------------------------------
// parseRulesMd (T044)
// ---------------------------------------------------------------------------

/**
 * Parse a .sthrip/rules.md file into a ParsedRules object.
 *
 * Security properties:
 * - Input is size-capped to RULES_MD_MAX_BYTES before any processing.
 * - The file is treated as UNTRUSTED TEXT: only bullet-list items under the
 *   known section headers are extracted; arbitrary content is ignored.
 * - Never throws: malformed or oversized files yield partial/empty results.
 *
 * Section headers recognised (case-insensitive):
 *   `## ignored-paths`  → populates `ignoredPaths`
 *   `## trusted-sources` → populates `trustedSources`
 *
 * @param content – raw file content (string or null/undefined).
 * @returns Parsed rules; both arrays empty when content is absent or empty.
 */
export function parseRulesMd(content: string | null | undefined): ParsedRules {
  if (!content) {
    return { ignoredPaths: [], trustedSources: [] };
  }

  // Cap at 64 KiB — treat as untrusted text (data-model.md, T044).
  const capped =
    content.length > RULES_MD_MAX_BYTES
      ? content.slice(0, RULES_MD_MAX_BYTES)
      : content;

  const ignoredPaths: string[] = [];
  const trustedSources: string[] = [];

  // State machine: track which section we are currently inside.
  type Section = "ignored-paths" | "trusted-sources" | null;
  let currentSection: Section = null;

  for (const rawLine of capped.split("\n")) {
    const line = rawLine.trimEnd();

    // Check for a section header (## …).
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      const header = headerMatch[1]!.trim().toLowerCase();
      if (header === "ignored-paths") {
        currentSection = "ignored-paths";
      } else if (header === "trusted-sources") {
        currentSection = "trusted-sources";
      } else {
        // Some other section — stop collecting items.
        currentSection = null;
      }
      continue;
    }

    // Collect bullet-list items while inside a recognised section.
    if (currentSection === null) continue;

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (!bulletMatch) continue;

    const item = bulletMatch[1]!.trim();
    if (item === "") continue;

    if (currentSection === "ignored-paths") {
      ignoredPaths.push(item);
    } else {
      trustedSources.push(item);
    }
  }

  return { ignoredPaths, trustedSources };
}

// ---------------------------------------------------------------------------
// applyRulesMd (T044)
// ---------------------------------------------------------------------------

/**
 * Filter findings according to the parsed .sthrip/rules.md rules.
 *
 * Currently applies `ignoredPaths`: any finding whose `filePath` starts with
 * an ignored-paths prefix (or matches a simple glob pattern) is removed.
 *
 * Glob patterns supported:
 *   - Plain prefix: `vendor/`  → matches any path starting with "vendor/"
 *   - `**\/` prefix stripped for comparison purposes.
 *   - `*.ext` suffix: matches any path ending with `.ext`.
 *   - `**\/*.ext` suffix (common case): matches any path ending with `.ext`.
 *
 * The `trustedSources` list is available for downstream callers to suppress
 * taint-source warnings; it is not applied here (engine.ts wires it separately
 * when building the candidate context).
 *
 * @param findings – candidate findings (not mutated).
 * @param rules    – result of parseRulesMd.
 * @returns A new array with ignored-path findings removed.
 */
export function applyRulesMd<T extends { filePath: string }>(
  findings: T[],
  rules: ParsedRules,
): T[] {
  if (rules.ignoredPaths.length === 0) return [...findings];

  return findings.filter((f) => !isPathIgnored(f.filePath, rules.ignoredPaths));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given filePath matches any of the ignoredPaths patterns.
 *
 * Supported pattern types (untrusted input — no RegExp eval):
 *   1. Plain prefix: "vendor/" — path must start with this string.
 *   2. Glob suffix: "*.min.js" or "**\/*.min.js" — path must end with the
 *      suffix after stripping the glob prefix.
 */
function isPathIgnored(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesPattern(filePath, pattern)) return true;
  }
  return false;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  // Strip leading **/  to get the effective pattern.
  const effective = pattern.startsWith("**/") ? pattern.slice(3) : pattern;

  // If the effective pattern starts with "*.", treat as a suffix glob.
  if (effective.startsWith("*.")) {
    const suffix = effective.slice(1); // e.g. ".min.js"
    return filePath.endsWith(suffix);
  }

  // Plain prefix match (handles "vendor/", "generated/", etc.).
  return filePath.startsWith(effective);
}
