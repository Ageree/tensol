import { describe, expect, it } from 'vitest';
import { ApiError } from './client.ts';

describe('ApiError', () => {
  it('has the correct name and status', () => {
    const err = new ApiError(403, { error: 'forbidden' });
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'forbidden' });
    expect(err.message).toBe('API error 403');
  });

  it('is an instance of Error', () => {
    const err = new ApiError(404, {});
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ApiError).toBe(true);
  });
});
