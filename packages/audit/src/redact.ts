// Sprint 4 A16/A17 — pure secret-redaction primitive.
//
// Single redact() implementation used by every audit emission path (today
// auth routes; Sprint 5+ assessment scope diffs, finding status changes,
// report metadata). Replaces values whose KEY matches the case-insensitive
// secret-key list with the literal string `'[redacted]'`. Handles cycles
// without infinite recursion by tracking visited references.
//
// Properties (asserted by redact.test.ts + redact.property.test.ts):
//   - Pure (no I/O, no Date/Math.random sourcing).
//   - Top-level + arbitrary-depth nesting + arrays + mixed types.
//   - Cycles → `'[circular]'` marker, no stack overflow.
//   - Input is never mutated; output is a new value-tree.
//   - Symbol keys are preserved (cannot be matched against the key list).
//   - undefined / null / primitives are passed through verbatim.

const DEFAULT_SECRET_KEYS: ReadonlyArray<string> = Object.freeze([
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'set-cookie',
  'mfa_secret',
  'totp_secret',
  'private_key',
  'api_key',
  // NQ-B (Sprint 4 Evaluator iteration 1):
  'bearer',
  'jwt',
  'session_token',
]);

export interface RedactionConfig {
  /** Additional keys to redact (case-insensitive). Always merged with the defaults. */
  readonly additionalKeys?: ReadonlyArray<string>;
}

const REDACTED = '[redacted]' as const;
const CIRCULAR = '[circular]' as const;

const buildKeySet = (config?: RedactionConfig): ReadonlySet<string> => {
  const all = [...DEFAULT_SECRET_KEYS, ...(config?.additionalKeys ?? [])];
  return new Set(all.map((k) => k.toLowerCase()));
};

/**
 * Returns a new value tree with secret-keyed values replaced by `'[redacted]'`
 * and cycle-back references replaced by `'[circular]'`. Input is never
 * mutated.
 */
export const redact = <T>(input: T, config?: RedactionConfig): unknown => {
  const keys = buildKeySet(config);
  const seen = new WeakMap<object, true>();

  const walk = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    if (seen.has(value as object)) return CIRCULAR;
    seen.set(value as object, true);

    if (Array.isArray(value)) {
      return value.map((item) => walk(item));
    }

    const obj = value as Record<string, unknown>;
    const out: Record<string | symbol, unknown> = {};
    // String keys — eligible for matching against the secret-key set.
    for (const k of Object.keys(obj)) {
      if (keys.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(obj[k]);
      }
    }
    // Symbol keys — pass through verbatim. Cannot be matched against a
    // string-keyed secret list; preserved for forward-compat (e.g. opaque
    // observability tags). Their values are NOT recursed into (Sprint 4 is
    // not in the business of inspecting symbol-keyed payloads).
    for (const sym of Object.getOwnPropertySymbols(obj)) {
      out[sym] = obj[sym as unknown as string];
    }
    return out;
  };

  return walk(input);
};

export { DEFAULT_SECRET_KEYS, REDACTED, CIRCULAR };
