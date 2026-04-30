import { describe, expect, mock, test } from 'bun:test';
import type { Credential } from './credential-schema.ts';
import { LoginFailedError } from './errors.ts';
import type { ExecutorContext, ExecutorPage } from './executor.ts';
import { executeRecipe } from './executor.ts';
import type { LoginRecipe } from './recipe-schema.ts';

const credential: Credential = { username: 'lab-user', password: 'lab-pass' };

const makeRecipe = (overrides?: Partial<LoginRecipe>): LoginRecipe => ({
  name: 'test-recipe',
  kind: 'form-post',
  steps: [
    { action: 'navigate', value: 'http://localhost:9999/login' },
    { action: 'fill', selector: '#username', fillFromCred: 'username' },
    { action: 'fill', selector: '#password', fillFromCred: 'password' },
    { action: 'submit', selector: '#submit' },
  ],
  successCheck: { selector: '.dashboard', timeoutMs: 3000 },
  ...overrides,
});

const makePage = (opts?: { waitForSelectorFails?: boolean }): ExecutorPage => {
  const locatorMap: Record<
    string,
    { click: ReturnType<typeof mock>; fill: ReturnType<typeof mock> }
  > = {};
  const getLocator = (selector: string) => {
    if (!locatorMap[selector]) {
      locatorMap[selector] = {
        click: mock(() => Promise.resolve()),
        fill: mock(() => Promise.resolve()),
      };
    }
    return locatorMap[selector];
  };
  return {
    goto: mock(() => Promise.resolve(null)),
    locator: (selector: string) => ({
      click: getLocator(selector).click,
      fill: getLocator(selector).fill,
    }),
    waitForSelector: mock(() =>
      opts?.waitForSelectorFails ? Promise.reject(new Error('Timeout')) : Promise.resolve(null),
    ),
    url: () => 'http://localhost:9999/dashboard',
  };
};

const makeContext = (): ExecutorContext => ({
  storageState: mock(async () => ({
    cookies: [{ name: 'session', value: 'tok', domain: 'localhost', path: '/' }],
  })),
});

describe('executor :: executeRecipe', () => {
  test('returns storageState and cookies on happy path', async () => {
    const page = makePage();
    const ctx = makeContext();
    const result = await executeRecipe(page, ctx, makeRecipe(), credential);
    expect(result.storageState).toContain('session');
    expect(result.cookies[0]?.name).toBe('session');
    expect(result.lastUrl).toBe('http://localhost:9999/dashboard');
  });

  test('calls page.goto with navigate step value', async () => {
    const page = makePage();
    await executeRecipe(page, makeContext(), makeRecipe(), credential);
    expect(page.goto).toHaveBeenCalledWith('http://localhost:9999/login');
  });

  test('fills username from credential', async () => {
    const page = makePage();
    const locFill = mock(() => Promise.resolve());
    page.locator = (sel: string) => ({
      click: mock(() => Promise.resolve()),
      fill: sel === '#username' ? locFill : mock(() => Promise.resolve()),
    });
    await executeRecipe(page, makeContext(), makeRecipe(), credential);
    expect(locFill).toHaveBeenCalledWith('lab-user');
  });

  test('throws LoginFailedError when successCheck selector not found', async () => {
    const page = makePage({ waitForSelectorFails: true });
    await expect(executeRecipe(page, makeContext(), makeRecipe(), credential)).rejects.toThrow(
      LoginFailedError,
    );
  });
});
