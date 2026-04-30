import type { Credential } from './credential-schema.ts';
import { LoginFailedError } from './errors.ts';
import type { LoginRecipe, RecipeStep } from './recipe-schema.ts';

export interface AuthCookieResult {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

export interface LoginResult {
  readonly storageState: string;
  readonly cookies: ReadonlyArray<AuthCookieResult>;
  readonly lastUrl: string;
}

// Minimal Page interface — compatible with playwright's Page without importing it.
// Decouples browser-auth from a hard playwright dependency.
export interface ExecutorPage {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): {
    click(opts?: { timeout?: number }): Promise<void>;
    fill(value: string, opts?: { timeout?: number }): Promise<void>;
  };
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  url(): string;
}

export interface ExecutorContext {
  storageState(): Promise<{
    cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  }>;
}

const executeStep = async (
  page: ExecutorPage,
  step: RecipeStep,
  credential: Credential,
  scopeCheck?: (url: string) => Promise<void>,
): Promise<void> => {
  switch (step.action) {
    case 'navigate': {
      const url = step.value ?? '';
      if (scopeCheck) {
        await scopeCheck(url);
      }
      await page.goto(url, ...(step.waitFor ? [{ timeout: step.waitFor.timeoutMs }] : []));
      break;
    }
    case 'click': {
      if (!step.selector) break;
      await page.locator(step.selector).click();
      break;
    }
    case 'fill': {
      if (!step.selector) break;
      const value = step.fillFromCred ? credential[step.fillFromCred] : (step.value ?? '');
      await page.locator(step.selector).fill(value);
      break;
    }
    case 'submit': {
      if (!step.selector) break;
      await page.locator(step.selector).click();
      break;
    }
    case 'waitFor': {
      const sel = step.waitFor?.selector ?? step.selector ?? '';
      const timeout = step.waitFor?.timeoutMs;
      await page.waitForSelector(sel, timeout !== undefined ? { timeout } : undefined);
      break;
    }
  }
};

export const executeRecipe = async (
  page: ExecutorPage,
  context: ExecutorContext,
  recipe: LoginRecipe,
  credential: Credential,
  scopeCheck?: (url: string) => Promise<void>,
): Promise<LoginResult> => {
  for (const step of recipe.steps) {
    await executeStep(page, step, credential, scopeCheck);
  }

  try {
    await page.waitForSelector(recipe.successCheck.selector, {
      timeout: recipe.successCheck.timeoutMs,
    });
  } catch {
    throw new LoginFailedError(
      `Login failed: success selector '${recipe.successCheck.selector}' not found within ${recipe.successCheck.timeoutMs}ms`,
    );
  }

  const state = await context.storageState();
  const storageState = JSON.stringify(state);
  const cookies: ReadonlyArray<AuthCookieResult> = state.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));

  return { storageState, cookies, lastUrl: page.url() };
};
