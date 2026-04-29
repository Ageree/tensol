import { afterEach, describe, expect, it } from 'bun:test';
import { type XssLabHandle, startXssLab } from './index.ts';

describe('xss-fixture lab app', () => {
  let handle: XssLabHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  it('reflects raw query payload inside <div> — vulnerable XSS sink', async () => {
    handle = await startXssLab(0);
    const payload = '<svg/onload=alert(1)>';
    const res = await fetch(`${handle.origin}/search?q=${encodeURIComponent(payload)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<div>${payload}</div>`);
  });

  it('GET /redirect-evil returns 302 to https://evil.example/', async () => {
    handle = await startXssLab(0);
    const res = await fetch(`${handle.origin}/redirect-evil`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://evil.example/');
  });

  it('exposes hit-counters per endpoint', async () => {
    handle = await startXssLab(0);
    await fetch(`${handle.origin}/healthz`);
    await fetch(`${handle.origin}/search?q=hi`);
    await fetch(`${handle.origin}/search?q=hi2`);
    const counters = handle.getCounters();
    expect(counters.healthz).toBe(1);
    expect(counters.search).toBe(2);
    expect(counters.redirectEvil).toBe(0);
  });

  it('resetCounters zeros the hit-counters', async () => {
    handle = await startXssLab(0);
    await fetch(`${handle.origin}/healthz`);
    handle.resetCounters();
    expect(handle.getCounters()).toEqual({ search: 0, redirectEvil: 0, healthz: 0 });
  });
});
