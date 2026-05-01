// Sprint 9 — FakeBrowserDriver unit tests.

import { describe, expect, test } from 'bun:test';
import { FakeBrowserDriver } from './fake-driver.ts';
import { BrowserTimeoutError } from './types.ts';

const TRACE_ID = 'a'.repeat(32);

const okFetch = (body: string, headers: Record<string, string> = {}): typeof globalThis.fetch =>
  (async (_url: string | URL): Promise<Response> => {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html', ...headers },
    });
  }) as unknown as typeof globalThis.fetch;

describe('FakeBrowserDriver', () => {
  test('launch creates an isolated session', async () => {
    const drv = new FakeBrowserDriver({ fetch: okFetch('<html></html>') });
    const a = await drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID });
    const b = await drv.launch({ tenantId: 't2', assessmentId: 'a2', traceId: TRACE_ID });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.status).toBe('launched');
  });

  test('navigate returns artefacts with HAR + DOM snapshot + console + screenshot bytes', async () => {
    const drv = new FakeBrowserDriver({
      fetch: okFetch('<html><body><a href="/b">x</a></body></html>'),
    });
    const sess = await drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID });
    const out = await drv.navigate(sess.sessionId, {
      url: 'http://localhost:9999/a',
      method: 'GET',
    });
    expect(out.finalUrl).toBe('http://localhost:9999/a');
    expect(out.artifacts.domSnapshot).toContain('<a href="/b">');
    expect(out.artifacts.consoleMessages.length).toBe(1);
    expect(out.artifacts.consoleMessages[0]?.text).toContain('navigated:');
    expect(out.artifacts.screenshot.byteLength).toBeGreaterThan(50);
    expect(out.artifacts.trace.byteLength).toBeGreaterThan(0);
    expect(out.artifacts.httpStatus).toBe(200);
  });

  test('discoveredLinks resolves relative hrefs', async () => {
    const drv = new FakeBrowserDriver({
      fetch: okFetch('<html><a href="/x">1</a><a href="https://other/y">2</a></html>'),
    });
    const sess = await drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID });
    const out = await drv.navigate(sess.sessionId, {
      url: 'http://localhost:9999/p',
      method: 'GET',
    });
    expect(out.discoveredLinks).toContain('http://localhost:9999/x');
    expect(out.discoveredLinks).toContain('https://other/y');
  });

  test('HAR bytes parse to JSON with cookie + set-cookie headers', async () => {
    const drv = new FakeBrowserDriver({
      fetch: okFetch('<html></html>', { 'set-cookie': 'session=top-secret' }),
    });
    const sess = await drv.launch({
      tenantId: 't1',
      assessmentId: 'a1',
      traceId: TRACE_ID,
      authCookies: [{ name: 'sid', value: 'leak-token', domain: 'localhost', path: '/' }],
    });
    const out = await drv.navigate(sess.sessionId, {
      url: 'http://localhost:9999/p',
      method: 'GET',
    });
    const har = JSON.parse(new TextDecoder().decode(out.artifacts.har));
    const reqHeaders = har.log.entries[0].request.headers as Array<{ name: string; value: string }>;
    expect(reqHeaders.some((h) => h.name === 'Cookie' && h.value.includes('leak-token'))).toBe(
      true,
    );
    const respHeaders = har.log.entries[0].response.headers as Array<{
      name: string;
      value: string;
    }>;
    expect(respHeaders.some((h) => h.name === 'Set-Cookie' && h.value.includes('top-secret'))).toBe(
      true,
    );
  });

  test('navigate on unknown session throws', async () => {
    const drv = new FakeBrowserDriver({ fetch: okFetch('') });
    await expect(drv.navigate('not-a-session', { url: 'http://x', method: 'GET' })).rejects.toThrow(
      /session_not_found/,
    );
  });

  test('close marks session closed; subsequent navigate fails', async () => {
    const drv = new FakeBrowserDriver({ fetch: okFetch('') });
    const sess = await drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID });
    await drv.close(sess.sessionId);
    await expect(drv.navigate(sess.sessionId, { url: 'http://x', method: 'GET' })).rejects.toThrow(
      /session_not_found/,
    );
  });

  test('oneShotLaunchFault throws once then permits', async () => {
    let fired = 0;
    const fault = (): Error | null => {
      fired += 1;
      if (fired === 1) return new BrowserTimeoutError('boom');
      return null;
    };
    const drv = new FakeBrowserDriver({ fetch: okFetch(''), oneShotLaunchFault: fault });
    await expect(
      drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID }),
    ).rejects.toBeInstanceOf(BrowserTimeoutError);
    const sess2 = await drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID });
    expect(sess2.sessionId).toBeDefined();
  });

  test('fetch failure wraps as BrowserTimeoutError', async () => {
    const drv = new FakeBrowserDriver({
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    });
    const sess = await drv.launch({ tenantId: 't1', assessmentId: 'a1', traceId: TRACE_ID });
    await expect(
      drv.navigate(sess.sessionId, { url: 'http://x', method: 'GET' }),
    ).rejects.toBeInstanceOf(BrowserTimeoutError);
  });
});
