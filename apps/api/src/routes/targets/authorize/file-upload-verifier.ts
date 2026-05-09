import type { VerifierResult } from './types.ts';

export interface HttpFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyReader: ReadableStreamDefaultReader<Uint8Array> | null;
}

export interface HttpFetcher {
  fetch(
    url: string,
    init: { method: 'GET'; signal: AbortSignal; redirect: 'manual' },
  ): Promise<HttpFetchResult>;
}

export const FILE_TOKEN_PREFIX = 'tensol-verify=';
export const MAX_BODY_BYTES = 1024;
export const FETCH_TIMEOUT_MS = 5_000;

const randomHex32 = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const generateChallenge = (
  _targetId: string,
  _originUrl: string,
  randomBytes: () => string = randomHex32,
): { token: string; urlPath: string; expectedBody: string } => {
  const hex = randomBytes();
  const token = hex;
  const urlPath = `/.well-known/tensol-verify-${token}.txt`;
  const expectedBody = `${FILE_TOKEN_PREFIX}${token}`;
  return { token, urlPath, expectedBody };
};

const timingSafeEqual = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
};

const readUpTo = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; oversize: boolean }> => {
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return { bytes: new Uint8Array(0), oversize: true };
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: result, oversize: false };
};

export const verify = async (
  originUrl: string,
  expectedToken: string,
  deps: { httpFetcher: HttpFetcher },
): Promise<VerifierResult> => {
  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch {
    return { ok: false, reason: 'non_https' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'non_https' };
  }

  const fullUrl = `${originUrl.replace(/\/$/, '')}/.well-known/tensol-verify-${expectedToken}.txt`;

  let result: HttpFetchResult;
  try {
    result = await deps.httpFetcher.fetch(fullUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    // AbortSignal.timeout throws a TimeoutError (also named 'TimeoutError' in some runtimes)
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'fetch_error' };
  }

  const { status } = result;

  if (status >= 300 && status < 400) {
    return { ok: false, reason: 'redirect_rejected' };
  }

  if (status !== 200) {
    return { ok: false, reason: `status_${status}` };
  }

  if (!result.bodyReader) {
    return { ok: false, reason: 'fetch_error' };
  }

  let bodyBytes: Uint8Array;
  let oversize: boolean;
  try {
    ({ bytes: bodyBytes, oversize } = await readUpTo(result.bodyReader, MAX_BODY_BYTES));
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'fetch_error' };
  }

  if (oversize) {
    return { ok: false, reason: 'oversize' };
  }

  const body = new TextDecoder().decode(bodyBytes).trim();
  const expected = `${FILE_TOKEN_PREFIX}${expectedToken}`;

  if (timingSafeEqual(body, expected)) {
    return { ok: true };
  }
  return { ok: false, reason: 'token_mismatch' };
};
