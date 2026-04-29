// Sprint 6 — URL canonicalization (zero I/O).
//
// Uses the global WHATWG URL constructor for parsing + lowercasing scheme +
// IDN hostname conversion. We then apply additional invariants required by
// the spec:
//   - default-port elision (80 for http, 443 for https, 80/443 for ws/wss)
//   - path-traversal segment collapse (`/a/./b` → `/a/b`, `/a/../b` → `/b`,
//     `/a/../../b` capped at root → `/b`)
//   - fragment strip
//   - query preserved verbatim (order matters for some apps)

import { normalizeHost } from './host.ts';
import { normalizeIp } from './ip.ts';

export interface NormalizedUrl {
  readonly canonical: string;
  readonly scheme: string;
  readonly host: string;
  readonly hostHasMixedScript: boolean;
  /**
   * codex iter-5 P2 — true when the URL host is an IP literal (IPv4 or
   * IPv6 with/without brackets). Downstream `decide.allowCoversAllDimensions`
   * uses this to treat the host dimension as covered by ip/cidr allow rules
   * instead of demanding a domain/subdomain/url_prefix rule.
   */
  readonly hostIsIp?: boolean;
  /** Display port — undefined when default-port elision happened. */
  readonly port?: number;
  /**
   * Effective port for policy matching (codex iter-4 P1). Always set for
   * http/https/ws/wss; falls back to the scheme's default when explicit port
   * was elided. Port-rule and url_prefix matchers consult this, not `port`.
   */
  readonly effectivePort?: number;
  readonly path: string;
  readonly query?: string;
}

export class UrlNormalizationError extends Error {
  constructor(message: string) {
    super(`url_normalization_error: ${message}`);
    this.name = 'UrlNormalizationError';
  }
}

const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

/**
 * codex iter-8 P1 — RFC 3986 §2.3 unreserved set. Percent-encoded forms of
 * these characters MUST be decoded to their literal form before policy
 * matching so `/%61dmin` (encoded `a`) can't bypass `/admin`.
 *
 * Reserved (gen-delims + sub-delims), `/`, `?`, `#`, etc. stay encoded so
 * they can't smuggle structure into the path.
 */
const UNRESERVED_RE = /^[A-Za-z0-9\-._~]$/;

/**
 * Decode percent-encoded unreserved characters in a path. Single-pass: does
 * NOT recursively decode (so `%2541` → `%41`, not `A`). Most XSS sinks single-
 * decode anyway; recursive decode would create false positives where a path
 * legitimately contains an encoded `%`. Reserved chars stay encoded.
 *
 * Throws on malformed encoding (e.g. `%G0` or `%2`) so the caller can surface
 * normalization_error.
 */
const decodePathUnreserved = (path: string): string => {
  let out = '';
  for (let i = 0; i < path.length; ) {
    if (path[i] === '%') {
      if (i + 2 >= path.length) {
        throw new UrlNormalizationError(`malformed percent-encoding at ${i}`);
      }
      const hex = path.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        throw new UrlNormalizationError(`malformed percent-encoding ${path.slice(i, i + 3)}`);
      }
      const ch = String.fromCharCode(Number.parseInt(hex, 16));
      if (UNRESERVED_RE.test(ch)) {
        out += ch;
      } else {
        // Keep reserved chars encoded; normalize hex to uppercase per RFC §6.2.2.1.
        out += `%${hex.toUpperCase()}`;
      }
      i += 3;
    } else {
      out += path[i];
      i += 1;
    }
  }
  return out;
};

const collapsePath = (path: string): string => {
  // codex iter-8 P1 — decode percent-encoded unreserved chars BEFORE segment
  // collapse so that `/%2E%2E/etc` reduces to `/..` and is then capped at root.
  const decoded = decodePathUnreserved(path);
  // Remove all `.` segments and resolve `..` segments capped at root.
  if (decoded.length === 0 || !decoded.startsWith('/')) {
    return `/${decoded}`;
  }
  const segments = decoded.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  // Preserve trailing slash if original (post-decode) had one.
  const trailing = decoded.endsWith('/') && !decoded.endsWith('/..') && !decoded.endsWith('/.');
  return `/${out.join('/')}${out.length > 0 && trailing ? '/' : ''}`;
};

export const normalizeUrl = (input: string): NormalizedUrl => {
  if (typeof input !== 'string') {
    throw new UrlNormalizationError('url must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new UrlNormalizationError('url is empty');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    throw new UrlNormalizationError(`URL parse failed: ${trimmed}`);
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme.length === 0) throw new UrlNormalizationError('url has no scheme');

  // codex iter-4 P1 — use the WHATWG-parsed hostname. Manual host extraction
  // from the substring after `://` gets fooled by userinfo (e.g.,
  // `https://allowed.example:pw@evil.example/` → manual scan stops at the
  // colon in userinfo and reports `allowed.example` as the host). The URL
  // parser correctly resolves `parsed.hostname === 'evil.example'`.
  const rawHostFromParser = parsed.hostname;
  if (rawHostFromParser.length === 0) {
    throw new UrlNormalizationError('url has no host');
  }

  // codex iter-5 P2 — bracketed IPv6 literal (`[2001:db8::1]`, `[fe80::1%lo0]`).
  // WHATWG URL exposes such hosts as `parsed.hostname` either with brackets
  // included (some runtimes) or stripped (others — Bun strips them and the
  // hostname contains the bare colon-separated literal). LDH validation in
  // normalizeHost rejects both forms. Detect IP literals first and bypass
  // normalizeHost entirely.
  let canonicalHost: string;
  let hostHasMixedScript: boolean;
  let hostIsIp = false;
  const bracketStripped =
    rawHostFromParser.startsWith('[') && rawHostFromParser.endsWith(']')
      ? rawHostFromParser.slice(1, -1)
      : rawHostFromParser;
  let ipParsed: ReturnType<typeof normalizeIp> | null = null;
  try {
    ipParsed = normalizeIp(bracketStripped);
  } catch {
    ipParsed = null;
  }
  if (ipParsed !== null) {
    canonicalHost = ipParsed.canonical;
    hostHasMixedScript = false;
    hostIsIp = true;
  } else {
    // The parser IDN-encodes Unicode hostnames (.hostname returns punycode).
    // Mixed-script detection needs the *pre-encoding* form when the input had
    // a Unicode host. Recover it by stripping userinfo from the substring after
    // `://` up to the first `/`/`?`/`#`/`:`.
    const afterScheme = trimmed.slice(trimmed.indexOf('://') + 3);
    const stripUserinfo = (() => {
      const atIdx = (() => {
        for (let i = 0; i < afterScheme.length; i += 1) {
          const ch = afterScheme[i];
          if (ch === '/' || ch === '?' || ch === '#') return -1;
          if (ch === '@') return i;
        }
        return -1;
      })();
      return atIdx >= 0 ? afterScheme.slice(atIdx + 1) : afterScheme;
    })();
    const rawHostEndIdx = (() => {
      for (let i = 0; i < stripUserinfo.length; i += 1) {
        const ch = stripUserinfo[i];
        if (ch === '/' || ch === '?' || ch === '#' || ch === ':') return i;
      }
      return stripUserinfo.length;
    })();
    const rawHostForMixedScript = stripUserinfo.slice(0, rawHostEndIdx);
    const hostNorm = normalizeHost(rawHostFromParser);
    canonicalHost = hostNorm.canonical;
    const mixedScriptInput =
      rawHostForMixedScript.length > 0 ? rawHostForMixedScript : rawHostFromParser;
    hostHasMixedScript = (() => {
      if (hostNorm.hasMixedScript) return true;
      try {
        return normalizeHost(mixedScriptInput).hasMixedScript;
      } catch {
        return false;
      }
    })();
  }

  const portRaw = parsed.port;
  const portNum = portRaw === '' ? undefined : Number.parseInt(portRaw, 10);
  const defaultPort = DEFAULT_PORTS[scheme];
  // Display-side: drop default-port for canonical string display.
  const portOut = portNum !== undefined && portNum === defaultPort ? undefined : portNum;
  // Policy-side (codex iter-4 P1): always known when the scheme has a default.
  const effectivePort = portNum !== undefined ? portNum : defaultPort;

  const collapsedPath = collapsePath(parsed.pathname);
  const queryRaw = parsed.search; // includes leading `?` or empty
  const query = queryRaw.length > 1 ? queryRaw.slice(1) : undefined;

  const portStr = portOut === undefined ? '' : `:${portOut}`;
  const queryStr = query === undefined ? '' : `?${query}`;
  // codex iter-5 P2 — IPv6 literal hosts re-wrap in brackets for canonical
  // URL display; rule matching still uses the un-bracketed `host` field
  // (which mirrors `NormalizedIp.canonical`).
  const hostInUrl = hostIsIp && canonicalHost.includes(':') ? `[${canonicalHost}]` : canonicalHost;
  // Canonical NEVER includes userinfo (codex iter-4 P1).
  const canonical = `${scheme}://${hostInUrl}${portStr}${collapsedPath}${queryStr}`;

  const result: NormalizedUrl = {
    canonical,
    scheme,
    host: canonicalHost,
    hostHasMixedScript,
    ...(hostIsIp ? { hostIsIp: true } : {}),
    ...(portOut === undefined ? {} : { port: portOut }),
    ...(effectivePort === undefined ? {} : { effectivePort }),
    path: collapsedPath,
    ...(query === undefined ? {} : { query }),
  };
  return result;
};
