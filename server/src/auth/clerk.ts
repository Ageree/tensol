import { createClerkClient, verifyToken } from "@clerk/backend";
import type { ClerkAuth } from "./middleware.ts";

interface VerifySessionTokenOptions {
  readonly secretKey: string;
  readonly authorizedParties?: string[];
}

type VerifySessionToken = (
  token: string,
  options: VerifySessionTokenOptions,
) => Promise<{ readonly sub?: string | null }>;

interface ClerkEmailAddressLike {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkUserLike {
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: readonly ClerkEmailAddressLike[];
}

interface ClerkUsersApiLike {
  getUser(userId: string): Promise<ClerkUserLike>;
}

export interface CreateClerkAuthDeps {
  readonly secretKey: string;
  readonly authorizedParties?: readonly string[];
  readonly verifySessionToken?: VerifySessionToken;
  readonly users?: ClerkUsersApiLike;
}

export function parseClerkAuthorizedParties(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function createClerkAuth(deps: CreateClerkAuthDeps): ClerkAuth | null {
  const secretKey = deps.secretKey.trim();
  if (!secretKey) return null;

  const authorizedParties = [...(deps.authorizedParties ?? [])]
    .map((party) => party.trim())
    .filter((party) => party.length > 0);
  const verifySessionToken =
    deps.verifySessionToken ??
    ((token, options) => verifyToken(token, options));
  const users = deps.users ?? createClerkClient({ secretKey }).users;

  return async (req) => {
    const token = readBearerToken(req);
    if (!token) return null;

    try {
      const payload = await verifySessionToken(token, {
        secretKey,
        ...(authorizedParties.length > 0 ? { authorizedParties } : {}),
      });
      const clerkUserId = payload.sub;
      if (!clerkUserId) return null;

      const user = await users.getUser(clerkUserId);
      const email = primaryEmail(user);
      if (!email) return null;

      return { id: clerkUserId, email };
    } catch {
      return null;
    }
  };
}

function readBearerToken(req: Request): string | null {
  const value = req.headers.get("authorization");
  if (!value) return null;

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function primaryEmail(user: ClerkUserLike): string | null {
  const primary = user.primaryEmailAddressId
    ? user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)
    : null;
  return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
}
