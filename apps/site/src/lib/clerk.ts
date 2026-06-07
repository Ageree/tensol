import { getToken } from '@clerk/react';

type ClerkEnv = {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_E2E_AUTH_BYPASS?: string;
};

const env = (import.meta as unknown as { readonly env?: ClerkEnv }).env ?? {};

export const clerkPublishableKey = env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ?? '';

export const isClerkConfigured = clerkPublishableKey.trim().length > 0;

export const isE2EAuthBypass = env.VITE_E2E_AUTH_BYPASS === 'true';

export class ClerkTokenError extends Error {
  constructor(message = 'Failed to acquire Clerk session token') {
    super(message);
    this.name = 'ClerkTokenError';
  }
}

export async function getClerkSessionToken(options?: {
  readonly template?: string;
}): Promise<string | null> {
  if (isE2EAuthBypass || !isClerkConfigured || typeof window === 'undefined') {
    return null;
  }

  try {
    return await getToken(
      options?.template ? { template: options.template } : undefined,
    );
  } catch (error) {
    throw new ClerkTokenError(
      error instanceof Error ? error.message : undefined,
    );
  }
}
