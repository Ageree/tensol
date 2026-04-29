import { describe, expect, test } from 'bun:test';
import { buildXssPayload, generateNonce } from './nonce.ts';
import {
  BrowserReplayTimeoutError,
  FakeXssReplayDriver,
  NotImplementedError,
  RealXssReplayDriver,
  selectXssReplayDriver,
} from './xss-replay-driver.ts';

const reflectingFetch =
  (echo: boolean, includeAlert = false): typeof globalThis.fetch =>
  async (input: Request | string | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const params = new URL(url).searchParams.get('q') ?? '';
    const body = `<html><body><div>${echo ? params : ''}</div>${includeAlert ? '<script>alert(1)</script>' : ''}</body></html>`;
    return new Response(body, { status: 200 });
  };

describe('validators :: xss-replay-driver :: Fake', () => {
  test('reflects nonce → domContainsNonce true + consoleNonceHits non-empty', async () => {
    const nonce = generateNonce();
    const driver = new FakeXssReplayDriver({ fetch: reflectingFetch(true) });
    const out = await driver.replay({
      affectedUrl: 'http://localhost/search',
      nonce,
      payload: buildXssPayload(nonce),
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(out.domContainsNonce).toBe(true);
    expect(out.consoleNonceHits.length).toBeGreaterThan(0);
    expect(out.screenshot.byteLength).toBeGreaterThan(0);
    expect(out.trace.byteLength).toBeGreaterThan(0);
    expect(out.httpStatus).toBe(200);
  });

  test('non-reflecting endpoint → domContainsNonce false', async () => {
    const nonce = generateNonce();
    const driver = new FakeXssReplayDriver({ fetch: reflectingFetch(false) });
    const out = await driver.replay({
      affectedUrl: 'http://localhost/healthz',
      nonce,
      payload: buildXssPayload(nonce),
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(out.domContainsNonce).toBe(false);
    expect(out.consoleNonceHits.length).toBe(0);
  });

  test('forceAlertOnly opt → alertDispatched true even when body lacks alert(', async () => {
    const driver = new FakeXssReplayDriver({
      fetch: reflectingFetch(false),
      forceAlertOnly: true,
    });
    const out = await driver.replay({
      affectedUrl: 'http://localhost/healthz',
      nonce: generateNonce(),
      payload: 'p',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(out.alertDispatched).toBe(true);
  });

  test('simulateTimeout=true → throws BrowserReplayTimeoutError (A-V-Hang)', async () => {
    const driver = new FakeXssReplayDriver({ simulateTimeout: true });
    let caught: unknown = null;
    try {
      await driver.replay({
        affectedUrl: 'http://localhost/search',
        nonce: generateNonce(),
        payload: 'p',
        traceId: '0123456789abcdef0123456789abcdef',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error).toBe(true);
    expect(caught instanceof BrowserReplayTimeoutError).toBe(true);
    expect((caught as Error).name).toBe('BrowserReplayTimeoutError');
  });

  test('fetch failure wrapped as Error', async () => {
    const driver = new FakeXssReplayDriver({
      fetch: async (): Promise<Response> => {
        throw new Error('econnrefused');
      },
    });
    let caught: Error | null = null;
    try {
      await driver.replay({
        affectedUrl: 'http://localhost/search',
        nonce: generateNonce(),
        payload: 'p',
        traceId: '0123456789abcdef0123456789abcdef',
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? '').toContain('fake_xss_replay_fetch_failed');
  });
});

describe('validators :: xss-replay-driver :: Real', () => {
  test('replay() rejects with NotImplementedError', async () => {
    const driver = new RealXssReplayDriver();
    let caught: unknown = null;
    try {
      await driver.replay({
        affectedUrl: 'http://x/',
        nonce: 'a'.repeat(32),
        payload: 'p',
        traceId: '0123456789abcdef0123456789abcdef',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof NotImplementedError).toBe(true);
    expect((caught as Error).name).toBe('NotImplementedError');
  });
});

describe('validators :: selectXssReplayDriver', () => {
  test('default → Fake', () => {
    const d = selectXssReplayDriver({});
    expect(d).toBeInstanceOf(FakeXssReplayDriver);
  });

  test('XSS_REPLAY_DRIVER=fake → Fake', () => {
    const d = selectXssReplayDriver({ XSS_REPLAY_DRIVER: 'fake' });
    expect(d).toBeInstanceOf(FakeXssReplayDriver);
  });

  test('XSS_REPLAY_DRIVER=real → Real', () => {
    const d = selectXssReplayDriver({ XSS_REPLAY_DRIVER: 'real' });
    expect(d).toBeInstanceOf(RealXssReplayDriver);
  });

  test('unknown value → throws', () => {
    expect(() => selectXssReplayDriver({ XSS_REPLAY_DRIVER: 'rogue' })).toThrow(
      /unknown_xss_replay_driver/,
    );
  });
});
