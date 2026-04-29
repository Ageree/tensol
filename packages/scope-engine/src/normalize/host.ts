// Sprint 6 — Host canonicalization (zero I/O).
//
// Uses the global WHATWG URL constructor (NOT a `node:` import) to leverage
// the runtime's ICU-backed IDN→punycode conversion. Bun ships ICU by default.
//
// Canonical host = lowercase ASCII, trailing-dot stripped, Unicode→punycode.
// Mixed-script segments are FLAGGED via `hasMixedScript` — the engine uses
// that flag to default-deny (OQ-8) unless an explicit `domain` allow names the
// punycode form.

export interface NormalizedHost {
  readonly canonical: string; // lowercase ASCII (post-punycode), trailing-dot stripped
  readonly hasMixedScript: boolean;
}

export class HostNormalizationError extends Error {
  constructor(message: string) {
    super(`host_normalization_error: ${message}`);
    this.name = 'HostNormalizationError';
  }
}

const TRAILING_DOT = /\.+$/;
const ASCII_LDH = /^[a-z0-9-]+$/; // letters, digits, hyphen (per LDH rule)

/**
 * Detect whether a label spans multiple Unicode scripts (homograph defense).
 * After IDN encoding, Latin-LDH-only segments are safe; anything else is
 * either a punycode label (`xn--`) or contains characters from non-Latin
 * scripts. Mixed Latin + non-Latin in the SAME label is the homograph attack
 * pattern — we flag it. Pure non-Latin (e.g. Cyrillic-only) is fine on its
 * own; mixed Latin+Cyrillic in one label is the attack.
 */
const labelHasMixedScript = (rawLabel: string): boolean => {
  if (rawLabel.length === 0) return false;
  let hasLatin = false;
  let hasNonLatinLetter = false;
  for (const codePoint of rawLabel) {
    const cp = codePoint.codePointAt(0);
    if (cp === undefined) continue;
    // Letters in basic Latin block (ASCII a-z, A-Z).
    const isLatinLetter = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    if (isLatinLetter) {
      hasLatin = true;
      continue;
    }
    // Hyphen / digit / dot / underscore — script-neutral.
    if (
      cp === 0x2d /* - */ ||
      cp === 0x2e /* . */ ||
      cp === 0x5f /* _ */ ||
      (cp >= 0x30 && cp <= 0x39) /* 0-9 */
    ) {
      continue;
    }
    // Anything else above ASCII is a non-Latin letter (Cyrillic, Greek, CJK, …).
    if (cp > 0x7f) {
      hasNonLatinLetter = true;
    }
  }
  return hasLatin && hasNonLatinLetter;
};

export const normalizeHost = (input: string): NormalizedHost => {
  if (typeof input !== 'string') {
    throw new HostNormalizationError('host must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new HostNormalizationError('host is empty');
  if (/\s/.test(trimmed)) throw new HostNormalizationError('host contains whitespace');

  // Detect mixed-script BEFORE punycode encoding (after encoding the labels
  // become ASCII `xn--*` and the signal is gone).
  const rawLabels = trimmed.replace(TRAILING_DOT, '').split('.');
  if (rawLabels.some((l) => l.length === 0)) {
    throw new HostNormalizationError('host has empty label');
  }
  const hasMixedScript = rawLabels.some(labelHasMixedScript);

  // Use WHATWG URL to perform IDN→punycode. Build a fake URL and read host.
  // URL() lowercases the host and applies IDN encoding via ICU.
  let canonical: string;
  try {
    const u = new URL(`http://${trimmed}/`);
    canonical = u.hostname.replace(TRAILING_DOT, '');
  } catch (_err) {
    throw new HostNormalizationError(`URL construction failed for: ${trimmed}`);
  }

  // Final sanity: canonical must be ASCII LDH on each label. Punycode labels
  // begin with `xn--`; both shapes pass ASCII_LDH.
  for (const label of canonical.split('.')) {
    if (label.length === 0) throw new HostNormalizationError('canonical host has empty label');
    if (!ASCII_LDH.test(label)) {
      throw new HostNormalizationError(`canonical host has non-ASCII-LDH label: ${label}`);
    }
  }

  return { canonical, hasMixedScript };
};
