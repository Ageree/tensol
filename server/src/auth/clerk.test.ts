import { describe, expect, test } from "bun:test";
import {
  createClerkAuth,
  parseClerkAuthorizedParties,
} from "./clerk.ts";

describe("parseClerkAuthorizedParties", () => {
  test("normalizes comma-separated origins", () => {
    expect(
      parseClerkAuthorizedParties(
        " https://sthrip.dev, http://localhost:5175 ,, ",
      ),
    ).toEqual(["https://sthrip.dev", "http://localhost:5175"]);
  });
});

describe("createClerkAuth", () => {
  test("returns null when CLERK_SECRET_KEY is unset", () => {
    expect(createClerkAuth({ secretKey: "" })).toBeNull();
  });

  test("returns null without a bearer token", async () => {
    let verifyCalls = 0;
    const auth = createClerkAuth({
      secretKey: "sk_test_123",
      verifySessionToken: async () => {
        verifyCalls += 1;
        return { sub: "user_123" };
      },
      users: {
        getUser: async () => ({
          primaryEmailAddressId: "email_1",
          emailAddresses: [{ id: "email_1", emailAddress: "ops@example.com" }],
        }),
      },
    });

    expect(auth).not.toBeNull();
    expect(await auth!(new Request("https://api.test/me"))).toBeNull();
    expect(verifyCalls).toBe(0);
  });

  test("verifies a session token and returns the primary email", async () => {
    let forwardedParties: string[] | undefined;
    const auth = createClerkAuth({
      secretKey: "sk_test_123",
      authorizedParties: ["https://sthrip.dev"],
      verifySessionToken: async (token, options) => {
        expect(token).toBe("session-token");
        expect(options.secretKey).toBe("sk_test_123");
        forwardedParties = options.authorizedParties;
        return { sub: "user_clerk_123" };
      },
      users: {
        getUser: async (userId) => {
          expect(userId).toBe("user_clerk_123");
          return {
            primaryEmailAddressId: "email_primary",
            emailAddresses: [
              { id: "email_other", emailAddress: "other@example.com" },
              { id: "email_primary", emailAddress: "primary@example.com" },
            ],
          };
        },
      },
    });

    const result = await auth!(
      new Request("https://api.test/me", {
        headers: { Authorization: "Bearer session-token" },
      }),
    );

    expect(forwardedParties).toEqual(["https://sthrip.dev"]);
    expect(result).toEqual({
      id: "user_clerk_123",
      email: "primary@example.com",
    });
  });

  test("fails closed when token verification throws", async () => {
    const auth = createClerkAuth({
      secretKey: "sk_test_123",
      verifySessionToken: async () => {
        throw new Error("bad token");
      },
      users: {
        getUser: async () => {
          throw new Error("should not fetch user");
        },
      },
    });

    expect(
      await auth!(
        new Request("https://api.test/me", {
          headers: { Authorization: "Bearer invalid" },
        }),
      ),
    ).toBeNull();
  });
});
