// Sprint 9 — HAR cookie redaction (A-BR-Cookie).
//
// Strips:
//   - Request `Cookie` headers
//   - Response `Set-Cookie` headers
//   - HAR `cookies[].value` arrays in both request and response (HAR 1.2
//     stores cookies separately from the headers list)
//
// Replacement marker: '[REDACTED]'. Idempotent — running twice produces
// the same output. Boundary-only function: callers pass parsed HAR JSON,
// it returns a new object. No mutation.

export interface HarHeader {
  readonly name: string;
  readonly value: string;
  readonly [k: string]: unknown;
}

export interface HarCookie {
  readonly name: string;
  readonly value: string;
  readonly [k: string]: unknown;
}

export interface HarRequest {
  readonly headers?: ReadonlyArray<HarHeader>;
  readonly cookies?: ReadonlyArray<HarCookie>;
  readonly [k: string]: unknown;
}

export interface HarResponse {
  readonly headers?: ReadonlyArray<HarHeader>;
  readonly cookies?: ReadonlyArray<HarCookie>;
  readonly [k: string]: unknown;
}

export interface HarEntry {
  readonly request?: HarRequest;
  readonly response?: HarResponse;
  readonly [k: string]: unknown;
}

export interface HarLog {
  readonly entries?: ReadonlyArray<HarEntry>;
  readonly [k: string]: unknown;
}

export interface Har {
  readonly log?: HarLog;
  readonly [k: string]: unknown;
}

export const REDACTED = '[REDACTED]' as const;

const COOKIE_HEADER_NAMES_LOWER = new Set(['cookie', 'set-cookie']);

const redactHeaders = (
  headers: ReadonlyArray<HarHeader> | undefined,
): ReadonlyArray<HarHeader> | undefined => {
  if (!headers) return headers;
  return headers.map((h) => {
    if (COOKIE_HEADER_NAMES_LOWER.has(h.name.toLowerCase())) {
      return { ...h, value: REDACTED };
    }
    return h;
  });
};

const redactCookieEntries = (
  cookies: ReadonlyArray<HarCookie> | undefined,
): ReadonlyArray<HarCookie> | undefined => {
  if (!cookies) return cookies;
  return cookies.map((c) => ({ ...c, value: REDACTED }));
};

const redactRequest = (req: HarRequest | undefined): HarRequest | undefined => {
  if (!req) return req;
  const headers = redactHeaders(req.headers);
  const cookies = redactCookieEntries(req.cookies);
  return {
    ...req,
    ...(headers !== undefined ? { headers } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
  };
};

const redactResponse = (res: HarResponse | undefined): HarResponse | undefined => {
  if (!res) return res;
  const headers = redactHeaders(res.headers);
  const cookies = redactCookieEntries(res.cookies);
  return {
    ...res,
    ...(headers !== undefined ? { headers } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
  };
};

const redactEntry = (entry: HarEntry): HarEntry => {
  const request = redactRequest(entry.request);
  const response = redactResponse(entry.response);
  return {
    ...entry,
    ...(request !== undefined ? { request } : {}),
    ...(response !== undefined ? { response } : {}),
  };
};

export const redactCookies = (har: Har): Har => {
  const log = har.log;
  if (!log) return har;
  const entries = log.entries?.map(redactEntry);
  return {
    ...har,
    log: {
      ...log,
      ...(entries !== undefined ? { entries } : {}),
    },
  };
};
