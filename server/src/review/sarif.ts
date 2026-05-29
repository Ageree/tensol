/**
 * 003-whitebox — defensive SARIF 2.1.0 normalizer.
 *
 * Converts the raw SARIF JSON emitted by our SAST/secrets/SCA tools
 * (Opengrep/Semgrep, Gitleaks, Trivy) into the engine's neutral `RawFinding`
 * shape. The single public entry point is `normalizeSarif`.
 *
 * Design rules:
 *  - Input is `unknown`. We NEVER trust it: every field access is guarded and
 *    a non-SARIF / garbage payload returns `[]` rather than throwing.
 *  - Pure & immutable: no input is mutated; only new objects are returned.
 *  - Severity precedence: a numeric `security-severity` property (CVSS-style
 *    0–10 band) wins over the SARIF `level` enum when present and parseable.
 *  - CWE identifiers are gathered from rule props, result props, and
 *    tags/taxa, then deduped and normalized to the canonical `CWE-###` form.
 */

import type { FindingSource, RawFinding, Severity } from "./types.ts";

// ---------------------------------------------------------------------------
// Tiny guarded accessors (defensive — input is `unknown` end-to-end).
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

/** Safely read a nested property path, returning `undefined` on any miss. */
function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Severity mapping.
// ---------------------------------------------------------------------------

const LEVEL_TO_SEVERITY: Readonly<Record<string, Severity>> = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "informational",
};

/**
 * Map a numeric CVSS-style `security-severity` (0–10) to a `Severity` band.
 * Returns `undefined` for non-numeric or 0 (so we fall through to `level`).
 */
function severityFromScore(raw: unknown): Severity | undefined {
  const s = asString(raw);
  if (s === undefined) return undefined;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  return "low";
}

function severityFromLevel(level: unknown): Severity | undefined {
  const s = asString(level);
  if (s === undefined) return undefined;
  return LEVEL_TO_SEVERITY[s.toLowerCase()];
}

// ---------------------------------------------------------------------------
// CWE collection.
// ---------------------------------------------------------------------------

const CWE_RE = /CWE[-_\s]?(\d+)/i;

/** Pull a normalized `CWE-###` out of an arbitrary string, or `undefined`. */
function extractCwe(value: unknown): string | undefined {
  const s = asString(value);
  if (s === undefined) return undefined;
  const m = CWE_RE.exec(s);
  return m ? `CWE-${m[1]}` : undefined;
}

/** Normalize a value that may be a string or an array of strings into CWEs. */
function collectCweFrom(value: unknown, sink: Set<string>): void {
  if (typeof value === "string") {
    const c = extractCwe(value);
    if (c) sink.add(c);
    return;
  }
  for (const item of asArray(value)) {
    const c = extractCwe(item);
    if (c) sink.add(c);
  }
}

/**
 * Gather CWE ids from the resolved rule properties, the result properties, and
 * any tags / taxa entries that match the CWE pattern. Deduped via a Set; the
 * caller decides ordering.
 */
function collectCwe(result: unknown, rule: unknown): string[] {
  const sink = new Set<string>();

  collectCweFrom(get(rule, "properties", "cwe"), sink);
  collectCweFrom(get(rule, "properties", "tags"), sink);
  collectCweFrom(get(result, "properties", "cwe"), sink);
  collectCweFrom(get(result, "properties", "tags"), sink);

  // SARIF taxonomy references (e.g. CWE taxa) attached at result level.
  for (const taxa of asArray(get(result, "taxa"))) {
    collectCweFrom(get(taxa, "id"), sink);
    collectCweFrom(get(taxa, "name"), sink);
  }

  return [...sink];
}

// ---------------------------------------------------------------------------
// Rule resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve the driver rule object that backs a result. SARIF lets a result
 * reference its rule by `ruleIndex` (into `tool.driver.rules`) or by id; some
 * tools inline only the top-level `ruleId`. We try index first, then id.
 */
function resolveRule(result: unknown, rules: unknown[]): unknown {
  const idx = asInt(get(result, "ruleIndex"));
  if (idx !== undefined && idx >= 0 && idx < rules.length) {
    return rules[idx];
  }
  const ruleId = ruleIdOf(result);
  if (ruleId !== undefined) {
    for (const r of rules) {
      if (asString(get(r, "id")) === ruleId) return r;
    }
  }
  return undefined;
}

/** ruleId precedence: result.ruleId, then result.rule.id, else undefined. */
function ruleIdOf(result: unknown): string | undefined {
  return asString(get(result, "ruleId")) ?? asString(get(result, "rule", "id"));
}

// ---------------------------------------------------------------------------
// Location extraction.
// ---------------------------------------------------------------------------

interface LocationParts {
  filePath: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
}

/**
 * Strip a leading `file://` scheme and a single `./` prefix from a URI, then
 * percent-decode the path. SARIF 2.1.0 §3.4.1 specifies `artifactLocation.uri`
 * as a URI reference, so conforming producers percent-encode reserved chars
 * (space, `#`, non-ASCII). We decode AFTER removing the scheme so the on-disk
 * path matches the real repo path (fingerprint dedup + GitHub comment anchor).
 */
function cleanUri(uri: string): string {
  let out = uri;
  if (out.startsWith("file://")) out = out.slice("file://".length);
  try {
    out = decodeURIComponent(out);
  } catch {
    // Malformed escape (e.g. a literal `%` in the path) — leave as-is.
  }
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Extract file/line/snippet from the FIRST usable physicalLocation across a
 * result's `locations`. Tolerates null/garbage entries.
 */
function extractLocation(result: unknown): LocationParts {
  for (const loc of asArray(get(result, "locations"))) {
    const phys = get(loc, "physicalLocation");
    if (!isObject(phys)) continue;
    const uri = asString(get(phys, "artifactLocation", "uri"));
    const startLine = asInt(get(phys, "region", "startLine"));
    const endLine = asInt(get(phys, "region", "endLine"));
    const snippet = asString(get(phys, "region", "snippet", "text"));
    if (uri !== undefined || startLine !== undefined || snippet !== undefined) {
      return {
        filePath: uri !== undefined ? cleanUri(uri) : "",
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
      };
    }
  }
  return { filePath: "" };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Normalize a SARIF 2.1.0 document into neutral `RawFinding`s.
 *
 * @param sarif  Untrusted parsed-JSON value (may be anything).
 * @param source The finding source channel to stamp on every record.
 * @returns      A new array of findings; `[]` for any non-SARIF input.
 */
export function normalizeSarif(
  sarif: unknown,
  source: FindingSource,
): RawFinding[] {
  if (!isObject(sarif)) return [];
  const runs = sarif["runs"];
  if (!Array.isArray(runs)) return [];

  const findings: RawFinding[] = [];

  for (const run of runs) {
    const rules = asArray(get(run, "tool", "driver", "rules"));
    for (const result of asArray(get(run, "results"))) {
      const rule = resolveRule(result, rules);

      const ruleId = ruleIdOf(result) ?? "unknown";
      const message = asString(get(result, "message", "text")) ?? "";
      const { filePath, startLine, endLine, snippet } =
        extractLocation(result);

      const severity =
        severityFromScore(get(rule, "properties", "security-severity")) ??
        severityFromScore(get(result, "properties", "security-severity")) ??
        severityFromLevel(get(result, "level"));

      const cwe = collectCwe(result, rule);

      findings.push({
        ruleId,
        source,
        filePath,
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        message,
        ...(severity !== undefined ? { severity } : {}),
        ...(cwe.length > 0 ? { cwe } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
      });
    }
  }

  return findings;
}
