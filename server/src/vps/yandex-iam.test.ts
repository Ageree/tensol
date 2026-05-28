/**
 * T042 — Tests for `yandex-iam.ts` (T040).
 *
 * Per Constitution VI: real Yandex IAM API is never touched. We generate a
 * fresh RSA-2048 keypair in-memory per test, format it as a Yandex SA-key
 * JSON, and verify the JWT we sign with our private key against the matching
 * public key — offline, deterministic, no secrets in source.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";

import {
  getIamToken,
  _resetCachedTokenForTests,
  type GetIamTokenOpts,
} from "./yandex-iam";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type RecordedCall = { url: string; method: string; body: unknown };

function makeFetchMock(
  handler: (req: { url: string; method: string; body: unknown }) => Response,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    return handler({ url, method, body });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeTestSaKey(): {
  saKeyJson: string;
  publicKeyPem: string;
  id: string;
  serviceAccountId: string;
} {
  const id = "ajetestkeyidxxxxxxxx";
  const serviceAccountId = "ajetestsaidxxxxxxxxx";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const saKey = {
    id,
    service_account_id: serviceAccountId,
    created_at: "2026-05-19T12:57:59Z",
    key_algorithm: "RSA_2048",
    public_key: publicKey,
    private_key: privateKey,
  };
  return {
    saKeyJson: JSON.stringify(saKey),
    publicKeyPem: publicKey,
    id,
    serviceAccountId,
  };
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const [h, c, s] = parts as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(c, "base64url").toString("utf8")),
    signingInput: `${h}.${c}`,
    signature: Buffer.from(s, "base64url"),
  };
}

const IAM_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";

beforeEach(() => {
  _resetCachedTokenForTests();
});

describe("getIamToken — JWT construction", () => {
  test("signs JWT with PS256 + correct header/claims and verifies offline", async () => {
    const { saKeyJson, publicKeyPem, id, serviceAccountId } = makeTestSaKey();
    const nowMs = 1_700_000_000_000;
    const { fetchImpl, calls } = makeFetchMock(() =>
      new Response(
        JSON.stringify({
          iamToken: "fake-iam-token",
          expiresAt: new Date(nowMs + 3600 * 1000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const token = await getIamToken({
      saKeyJson,
      fetcher: fetchImpl,
      now: () => nowMs,
    });

    expect(token).toBe("fake-iam-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(IAM_URL);
    expect(calls[0]!.method).toBe("POST");

    const reqBody = calls[0]!.body as { jwt: string };
    expect(typeof reqBody.jwt).toBe("string");
    const { header, claims, signingInput, signature } = decodeJwt(reqBody.jwt);
    expect(header).toEqual({ typ: "JWT", alg: "PS256", kid: id });
    expect(claims.iss).toBe(serviceAccountId);
    expect(claims.aud).toBe(IAM_URL);
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(claims.iat).toBe(Math.floor(nowMs / 1000));
    expect((claims.exp as number) - (claims.iat as number)).toBeGreaterThan(
      300,
    );

    // Offline PS256 verification.
    const pub = createPublicKey(publicKeyPem);
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(signingInput),
      { key: pub, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 },
      signature,
    );
    expect(ok).toBe(true);
  });
});

describe("getIamToken — caching", () => {
  test("caches token across calls and reuses while > 5 min of expiry left", async () => {
    const { saKeyJson } = makeTestSaKey();
    const nowMs = 1_700_000_000_000;
    let fetchCount = 0;
    const { fetchImpl } = makeFetchMock(() => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          iamToken: `token-${fetchCount}`,
          expiresAt: new Date(nowMs + 3600 * 1000).toISOString(),
        }),
        { status: 200 },
      );
    });

    const opts: GetIamTokenOpts = {
      saKeyJson,
      fetcher: fetchImpl,
      now: () => nowMs,
    };
    const t1 = await getIamToken(opts);
    const t2 = await getIamToken(opts);
    const t3 = await getIamToken(opts);
    expect(t1).toBe("token-1");
    expect(t2).toBe("token-1");
    expect(t3).toBe("token-1");
    expect(fetchCount).toBe(1);
  });

  test("re-signs and re-fetches when within 5-min safety window", async () => {
    const { saKeyJson } = makeTestSaKey();
    const startMs = 1_700_000_000_000;
    let fetchCount = 0;
    const { fetchImpl } = makeFetchMock(() => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          iamToken: `token-${fetchCount}`,
          // each fresh token expires 10 min after issuance
          expiresAt: new Date(currentNow + 600 * 1000).toISOString(),
        }),
        { status: 200 },
      );
    });

    let currentNow = startMs;
    const opts: GetIamTokenOpts = {
      saKeyJson,
      fetcher: fetchImpl,
      now: () => currentNow,
    };
    const t1 = await getIamToken(opts);
    expect(t1).toBe("token-1");
    expect(fetchCount).toBe(1);

    // Advance to 4 min before expiry — inside 5-min safety window.
    currentNow = startMs + (600 - 4 * 60) * 1000;
    const t2 = await getIamToken(opts);
    expect(t2).toBe("token-2");
    expect(fetchCount).toBe(2);
  });

  test("re-fetches when previously cached token has fully expired", async () => {
    const { saKeyJson } = makeTestSaKey();
    const startMs = 1_700_000_000_000;
    let fetchCount = 0;
    let currentNow = startMs;
    const { fetchImpl } = makeFetchMock(() => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          iamToken: `token-${fetchCount}`,
          expiresAt: new Date(currentNow + 60_000).toISOString(),
        }),
        { status: 200 },
      );
    });

    const opts: GetIamTokenOpts = {
      saKeyJson,
      fetcher: fetchImpl,
      now: () => currentNow,
    };
    await getIamToken(opts);
    currentNow = startMs + 24 * 3600 * 1000;
    await getIamToken(opts);
    expect(fetchCount).toBe(2);
  });
});

describe("getIamToken — validation & errors", () => {
  test("throws when env var missing and no override supplied", async () => {
    const saved = process.env.YANDEX_SA_KEY_JSON;
    delete process.env.YANDEX_SA_KEY_JSON;
    try {
      await expect(getIamToken({})).rejects.toThrow(/YANDEX_SA_KEY_JSON/);
    } finally {
      if (saved !== undefined) process.env.YANDEX_SA_KEY_JSON = saved;
    }
  });

  test("throws when JSON malformed", async () => {
    await expect(
      getIamToken({ saKeyJson: "{not-json" }),
    ).rejects.toThrow();
  });

  test("throws when required SA-key fields missing", async () => {
    const incomplete = JSON.stringify({ id: "x", service_account_id: "y" });
    await expect(
      getIamToken({ saKeyJson: incomplete }),
    ).rejects.toThrow(/missing required fields/);
  });

  test("propagates IAM API error response", async () => {
    const { saKeyJson } = makeTestSaKey();
    const { fetchImpl } = makeFetchMock(
      () => new Response("PERMISSION_DENIED", { status: 403 }),
    );
    await expect(
      getIamToken({
        saKeyJson,
        fetcher: fetchImpl,
        now: () => 1_700_000_000_000,
      }),
    ).rejects.toThrow(/403/);
  });

  test("accepts base64-encoded SA-key JSON", async () => {
    const { saKeyJson, serviceAccountId } = makeTestSaKey();
    const b64 = Buffer.from(saKeyJson, "utf8").toString("base64");
    const nowMs = 1_700_000_000_000;
    const { fetchImpl, calls } = makeFetchMock(
      () =>
        new Response(
          JSON.stringify({
            iamToken: "ok",
            expiresAt: new Date(nowMs + 3600_000).toISOString(),
          }),
          { status: 200 },
        ),
    );
    const token = await getIamToken({
      saKeyJson: b64,
      fetcher: fetchImpl,
      now: () => nowMs,
    });
    expect(token).toBe("ok");
    const { claims } = decodeJwt((calls[0]!.body as { jwt: string }).jwt);
    expect(claims.iss).toBe(serviceAccountId);
  });
});
