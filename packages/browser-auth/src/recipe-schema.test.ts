import { describe, expect, test } from 'bun:test';
import { LoginRecipeSchema } from './recipe-schema.ts';

const validFormPostRecipe = {
  name: 'lab-form-post',
  kind: 'form-post' as const,
  steps: [
    { action: 'navigate' as const, value: 'http://localhost:3000/login' },
    { action: 'fill' as const, selector: '#username', fillFromCred: 'username' as const },
    { action: 'fill' as const, selector: '#password', fillFromCred: 'password' as const },
    { action: 'submit' as const, selector: '#login-btn' },
  ],
  successCheck: { selector: '.dashboard', timeoutMs: 5000 },
};

describe('recipe-schema :: LoginRecipeSchema', () => {
  test('accepts valid form-post recipe', () => {
    const result = LoginRecipeSchema.safeParse(validFormPostRecipe);
    expect(result.success).toBe(true);
  });

  test('accepts valid oauth2-pkce recipe', () => {
    const recipe = {
      ...validFormPostRecipe,
      name: 'oauth2-flow',
      kind: 'oauth2-pkce' as const,
    };
    expect(LoginRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  test('accepts valid magic-link recipe', () => {
    const recipe = { ...validFormPostRecipe, name: 'magic-link', kind: 'magic-link' as const };
    expect(LoginRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  test('rejects recipe with empty steps array', () => {
    const result = LoginRecipeSchema.safeParse({ ...validFormPostRecipe, steps: [] });
    expect(result.success).toBe(false);
  });

  test('rejects recipe with unknown kind', () => {
    const result = LoginRecipeSchema.safeParse({ ...validFormPostRecipe, kind: 'saml' });
    expect(result.success).toBe(false);
  });

  test('rejects step with unknown action', () => {
    const result = LoginRecipeSchema.safeParse({
      ...validFormPostRecipe,
      steps: [{ action: 'hover', selector: '#btn' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects recipe with empty name', () => {
    const result = LoginRecipeSchema.safeParse({ ...validFormPostRecipe, name: '' });
    expect(result.success).toBe(false);
  });

  test('rejects successCheck with non-positive timeoutMs', () => {
    const result = LoginRecipeSchema.safeParse({
      ...validFormPostRecipe,
      successCheck: { selector: '.ok', timeoutMs: 0 },
    });
    expect(result.success).toBe(false);
  });
});
