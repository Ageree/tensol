import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { PlaywrightBrowserDriverFacade } from './playwright-facade.ts';

// Minimal Page stub — matches the duck-typed Page interface used by the facade.
const makePageStub = (opts?: { url?: string }) => {
  const locatorClicks: string[] = [];
  const locatorFills: Array<{ selector: string; value: string }> = [];
  return {
    goto: mock((_url: string) => Promise.resolve(null)),
    locator: (selector: string) => ({
      click: mock(() => {
        locatorClicks.push(selector);
        return Promise.resolve();
      }),
      fill: mock((value: string) => {
        locatorFills.push({ selector, value });
        return Promise.resolve();
      }),
      all: mock(() => Promise.resolve([])),
    }),
    url: () => opts?.url ?? 'http://localhost/page',
    evaluate: mock((_fn: () => unknown) =>
      Promise.resolve({
        title: 'Test Page',
        url: opts?.url ?? 'http://localhost/page',
        headings: [],
        links: [],
      }),
    ),
    // locatorClicks/fills exposed for test assertions
    _locatorClicks: locatorClicks,
    _locatorFills: locatorFills,
  };
};

describe('PlaywrightBrowserDriverFacade :: act', () => {
  test('navigate calls page.goto with the url', async () => {
    const page = makePageStub();
    const facade = new PlaywrightBrowserDriverFacade();
    await facade.act(page, { action: 'navigate', value: 'http://example.com' });
    expect(page.goto).toHaveBeenCalledWith('http://example.com');
  });

  test('navigate calls scopeGuard before goto', async () => {
    const guard = mock(async (_url: string) => {});
    const page = makePageStub();
    const facade = new PlaywrightBrowserDriverFacade(guard);
    await facade.act(page, { action: 'navigate', value: 'http://allowed.com' });
    expect(guard).toHaveBeenCalledWith('http://allowed.com');
    expect(page.goto).toHaveBeenCalled();
  });

  test('scopeGuard rejection prevents goto', async () => {
    const guard = mock(async (_url: string) => {
      throw new Error('scope_denied');
    });
    const page = makePageStub();
    const facade = new PlaywrightBrowserDriverFacade(guard);
    await expect(
      facade.act(page, { action: 'navigate', value: 'http://denied.com' }),
    ).rejects.toThrow('scope_denied');
    expect(page.goto).not.toHaveBeenCalled();
  });

  test('click calls page.locator().click()', async () => {
    const page = makePageStub();
    const facade = new PlaywrightBrowserDriverFacade();
    await facade.act(page, { action: 'click', selector: '#submit' });
    expect(page._locatorClicks).toContain('#submit');
  });

  test('fill calls page.locator().fill() with value', async () => {
    const page = makePageStub();
    const facade = new PlaywrightBrowserDriverFacade();
    await facade.act(page, { action: 'fill', selector: '#email', value: 'user@example.com' });
    expect(page._locatorFills).toEqual([{ selector: '#email', value: 'user@example.com' }]);
  });

  test('throws ZodError on unknown action', async () => {
    const page = makePageStub();
    const facade = new PlaywrightBrowserDriverFacade();
    await expect(
      facade.act(page, { action: 'hover' as 'click', selector: '#x' }),
    ).rejects.toThrow();
  });
});

describe('PlaywrightBrowserDriverFacade :: extract', () => {
  test('returns data conforming to schema', async () => {
    const page = makePageStub({ url: 'http://example.com' });
    const facade = new PlaywrightBrowserDriverFacade();
    const schema = z.object({ title: z.string() }).passthrough();
    const result = await facade.extract(page, schema);
    expect(result.url).toBe('http://example.com');
    expect(typeof result.data).toBe('object');
  });
});
