import type { HttpFetchResult, HttpFetcher } from './file-upload-verifier.ts';

export class NodeHttpFetcher implements HttpFetcher {
  async fetch(
    url: string,
    init: { method: 'GET'; signal: AbortSignal; redirect: 'manual' },
  ): Promise<HttpFetchResult> {
    const res = await globalThis.fetch(url, {
      method: init.method,
      signal: init.signal,
      redirect: init.redirect,
    });
    return {
      status: res.status,
      headers: res.headers,
      bodyReader: (res.body?.getReader() ?? null) as ReadableStreamDefaultReader<Uint8Array> | null,
    };
  }
}
