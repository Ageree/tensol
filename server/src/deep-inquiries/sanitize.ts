/**
 * T098 — credential sanitizer for deep-inquiry scope_text.
 *
 * Per spec FR-034: redact common password/secret patterns before
 * persistence to deep_inquiries.scope_text AND before formatting the
 * Telegram operator-channel notification.
 *
 * Conservative philosophy:
 *  - Match well-known key:value shapes (password:foo, api_key=bar).
 *  - Match provider-specific token prefixes with bounded character classes.
 *  - Preserve prose context — only the value gets [REDACTED].
 *  - Skip high-entropy heuristics (too risky for false positives on
 *    legitimate scope text like asset names, hashes, JWT identifiers).
 */

const REDACTED = "[REDACTED]";

interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacer: (match: string, ...groups: string[]) => string;
}

// Each rule is applied independently; rules earlier in the list win first
// (string is rewritten in place, so later rules see redacted text).
const RULES: ReadonlyArray<RedactionRule> = [
  // ---- key/value style: password:foo, api_key="bar", token = 'baz' ----
  // Keys: password, pwd, pass, passwd, secret, api_key, api-key, apikey,
  //       access_key, access-key, token.
  // Separators: ':' or '='.
  // Values: quoted ("...", '...', `...`) OR bare (non-whitespace, no quote/punct stop).
  {
    name: "password-key-value",
    pattern:
      /\b(password|passwd|pwd|pass|secret|api[-_]?key|apikey|access[-_]?key|token)(\s*)([:=])\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s'"`<>;,]+)/gi,
    replacer: (_m, key: string, gap: string, sep: string) =>
      `${key}${gap}${sep} ${REDACTED}`,
  },
  // ---- Bearer <token> (RFC 6750 Authorization header shape) ----
  {
    name: "password-key-value",
    pattern: /\b(Bearer)\s+([A-Za-z0-9._\-+/=]+)/g,
    replacer: (_m, key: string) => `${key} ${REDACTED}`,
  },
  // ---- URL basic auth: https://user:password@host ----
  {
    name: "url-basic-auth",
    pattern: /(https?:\/\/[^:/\s@]+):([^@/\s]+)@/g,
    replacer: (_m, prefix: string) => `${prefix}:${REDACTED}@`,
  },
  // ---- AWS access key id: AKIA + 16 uppercase alphanumerics ----
  {
    name: "aws-access-key",
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    replacer: () => REDACTED,
  },
  // ---- GitHub personal access tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 30+ chars ----
  {
    name: "github-pat",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
    replacer: () => REDACTED,
  },
  // ---- Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs- ----
  {
    name: "slack-token",
    pattern: /\bxox[bpoars]-[A-Za-z0-9-]{10,}\b/g,
    replacer: () => REDACTED,
  },
  // ---- Anthropic API keys: sk-ant-... (placed BEFORE generic sk- rule) ----
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
    replacer: () => REDACTED,
  },
  // ---- OpenAI-style keys: sk- + 20+ alphanumerics ----
  // Anthropic rule above strips the sk-ant- variant first.
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacer: () => REDACTED,
  },
];

export interface SanitizeResult {
  readonly sanitized: string;
  readonly redactedCount: number;
  readonly rulesHit: ReadonlyArray<string>;
}

/**
 * Sanitize a free-form scope_text string by redacting common credential
 * patterns. Returns the sanitized string plus metadata about which rules
 * fired (useful for audit + operator-channel preview).
 */
export function sanitizeScopeText(input: string): SanitizeResult {
  if (typeof input !== "string" || input.length === 0) {
    return { sanitized: "", redactedCount: 0, rulesHit: [] };
  }

  let working = input;
  const hit: string[] = [];
  let count = 0;

  for (const rule of RULES) {
    const before = working;
    working = working.replace(rule.pattern, (match, ...groups) => {
      count += 1;
      // groups can include match offset + full string; pass through safely.
      return rule.replacer(match, ...(groups as string[]));
    });
    if (before !== working && !hit.includes(rule.name)) {
      hit.push(rule.name);
    }
  }

  return {
    sanitized: working,
    redactedCount: count,
    rulesHit: hit,
  };
}

/**
 * Convenience wrapper: returns only the sanitized string.
 * Use when caller does not need redaction metadata.
 */
export function sanitizeScopeTextSimple(input: string): string {
  return sanitizeScopeText(input).sanitized;
}
