// Sprint 10 — nonce generation + echo matcher.
//
// Pure helpers. A nonce is 32 lowercase-alphanumeric characters; the XSS
// validator stamps it into the payload and looks for it in the DOM/console
// streams. `nonceMatchesEcho` is a substring check — that is sufficient
// because the nonce is high-entropy (32×log2(36) ≈ 165 bits, vastly more
// than the random-collision floor we need).

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const NONCE_LENGTH = 32;

interface NonceDeps {
  /** Test seam — defaults to crypto.getRandomValues over an internal buffer. */
  readonly randomBytes?: (n: number) => Uint8Array;
}

export const NONCE_REGEX = /^[a-z0-9]{32}$/;

export const generateNonce = (deps: NonceDeps = {}): string => {
  const rand = deps.randomBytes
    ? deps.randomBytes(NONCE_LENGTH)
    : crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  let out = '';
  for (let i = 0; i < NONCE_LENGTH; i++) {
    const byte = rand[i] ?? 0;
    out += ALPHABET[byte % ALPHABET.length] ?? 'a';
  }
  return out;
};

export const nonceMatchesEcho = (nonce: string, body: string): boolean => {
  if (!NONCE_REGEX.test(nonce)) return false;
  return body.includes(nonce);
};

export const taggedConsoleMessage = (nonce: string, level: string, text: string): string =>
  `[${level}][${nonce}]${text}`;

/**
 * Build the deterministic XSS payload the validator stamps into the
 * affected URL. Echoed via DOM and console for redundancy.
 */
export const buildXssPayload = (nonce: string): string =>
  `<script>document.body.setAttribute('data-cs-nonce','${nonce}');console.log('[cs][${nonce}]xss-replay');</script>`;
