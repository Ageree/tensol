import { getToken } from '@clerk/react';

type ClerkEnv = {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
};

const env = (import.meta as unknown as { readonly env?: ClerkEnv }).env ?? {};

export const clerkPublishableKey = env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ?? '';

export const isClerkConfigured = clerkPublishableKey.trim().length > 0;

export async function getClerkSessionToken(): Promise<string | null> {
  if (!isClerkConfigured || typeof window === 'undefined') return null;

  try {
    return await getToken();
  } catch {
    return null;
  }
}
