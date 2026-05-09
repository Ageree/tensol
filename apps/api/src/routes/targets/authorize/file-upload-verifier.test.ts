import { describe, expect, it } from 'bun:test';
import type { HttpFetchResult, HttpFetcher } from './file-upload-verifier.ts';
import { FILE_TOKEN_PREFIX, generateChallenge, verify } from './file-upload-verifier.ts';

const TOKEN = 'a'.repeat(64);
const ORIGIN = 'https://example.com';

const enc = new TextEncoder();

const bodyReaderFrom = (text: string): ReadableStreamDefaultReader<Uint8Array> => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
  return stream.getReader();
};

const largBodyReader = (bytes: number): ReadableStreamDefaultReader<Uint8Array> => {
  const data = new Uint8Array(bytes).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  return stream.getReader();
};

const mockFetcher = (
  result: HttpFetchResult,
): { httpFetcher: HttpFetcher; spy: { calls: number } } => {
  const spy = { calls: 0 };
  const httpFetcher: HttpFetcher = {
    fetch: async (_url, _init) => {
      spy.calls++;
      return result;
    },
  };
  return { httpFetcher, spy };
};

describe('generateChallenge', () => {
  it('produces correct path and body shape', () => {
    const hex = 'b'.repeat(64);
    const result = generateChallenge('t1', ORIGIN, () => hex);
    expect(result.token).toBe(hex);
    expect(result.urlPath).toBe(`/.well-known/tensol-verify-${hex}.txt`);
    expect(result.expectedBody).toBe(`${FILE_TOKEN_PREFIX}${hex}`);
  });
});

describe('verify', () => {
  it('happy path — 200 + matching body', async () => {
    const body = `${FILE_TOKEN_PREFIX}${TOKEN}`;
    const { httpFetcher } = mockFetcher({
      status: 200,
      headers: new Headers(),
      bodyReader: bodyReaderFrom(body),
    });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: true });
  });

  it('non-https rejected before any fetch call', async () => {
    const { httpFetcher, spy } = mockFetcher({
      status: 200,
      headers: new Headers(),
      bodyReader: null,
    });
    const result = await verify('http://example.com', TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'non_https' });
    expect(spy.calls).toBe(0);
  });

  it('redirect (302) rejected', async () => {
    const { httpFetcher } = mockFetcher({ status: 302, headers: new Headers(), bodyReader: null });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'redirect_rejected' });
  });

  it('404 returns status_404', async () => {
    const { httpFetcher } = mockFetcher({ status: 404, headers: new Headers(), bodyReader: null });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'status_404' });
  });

  it('403 returns status_403', async () => {
    const { httpFetcher } = mockFetcher({ status: 403, headers: new Headers(), bodyReader: null });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'status_403' });
  });

  it('body mismatch — token_mismatch', async () => {
    const { httpFetcher } = mockFetcher({
      status: 200,
      headers: new Headers(),
      bodyReader: bodyReaderFrom(`${FILE_TOKEN_PREFIX}${'z'.repeat(64)}`),
    });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'token_mismatch' });
  });

  it('oversize body → oversize', async () => {
    const { httpFetcher } = mockFetcher({
      status: 200,
      headers: new Headers(),
      bodyReader: largBodyReader(2000),
    });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'oversize' });
  });

  it('fetch rejects with AbortError → timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const httpFetcher: HttpFetcher = {
      fetch: async () => {
        throw abortErr;
      },
    };
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('arbitrary fetch error → fetch_error', async () => {
    const httpFetcher: HttpFetcher = {
      fetch: async () => {
        throw new Error('network down');
      },
    };
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: false, reason: 'fetch_error' });
  });

  it('body with trailing whitespace still matches (trim)', async () => {
    const body = `${FILE_TOKEN_PREFIX}${TOKEN}\n`;
    const { httpFetcher } = mockFetcher({
      status: 200,
      headers: new Headers(),
      bodyReader: bodyReaderFrom(body),
    });
    const result = await verify(ORIGIN, TOKEN, { httpFetcher });
    expect(result).toEqual({ ok: true });
  });
});
