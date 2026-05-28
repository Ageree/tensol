/**
 * T040 — Yandex Cloud IAM token: JWT-bearer flow with cached singleton.
 *
 * Per research §R5: Yandex IAM tokens last ~12 hours. We mint short-lived
 * JWTs (signed PS256 with the SA private key) and exchange them at
 * `POST https://iam.api.cloud.yandex.net/iam/v1/tokens` for an IAM token.
 * The token is cached in-process and refreshed when within a 5-minute safety
 * window of its declared `expiresAt`.
 *
 * Yandex SA-key JSON (per Yandex docs / `yc iam key create --output ...`):
 *   {
 *     "id": "ajeXXXXX...",                  // key id → JWT header `kid`
 *     "service_account_id": "ajeYYY...",    // → JWT claim `iss`
 *     "private_key": "-----BEGIN PRIVATE KEY-----\n...",
 *     "key_algorithm": "RSA_2048"
 *   }
 *
 * JWT shape (per Yandex IAM JWT spec):
 *   header  = { typ: "JWT", alg: "PS256", kid: <id> }
 *   claims  = { iss: <service_account_id>, aud: <IAM_TOKEN_URL>, iat, exp }
 *
 * Env var `YANDEX_SA_KEY_JSON` may be either:
 *   - raw JSON (starts with `{`)
 *   - base64-encoded JSON (typical for env injection without escaping)
 *
 * Dependencies are injected (`fetcher`, `now`, `saKeyJson`) so tests run
 * offline against an in-memory keypair — see `./yandex-iam.test.ts`.
 */

import { createPrivateKey, sign, constants as cryptoConstants } from "node:crypto";

const IAM_TOKEN_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
/** JWT lifetime in seconds. Yandex IAM allows up to 1 hour for the bearer JWT. */
const JWT_TTL_SECONDS = 3600;
/** Refresh IAM token if its remaining lifetime drops below this. */
const REFRESH_SAFETY_MS = 5 * 60 * 1000;
/** Fallback IAM-token lifetime if the response omits `expiresAt`. */
const FALLBACK_IAM_TTL_MS = 3600 * 1000;

type SaKey = {
  id: string;
  service_account_id: string;
  private_key: string;
};

type CachedToken = { token: string; expiresAtMs: number };

let cachedToken: CachedToken | null = null;

export type GetIamTokenOpts = {
  /** Inject a fetch impl for tests; defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Inject a clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Inject the SA-key JSON for tests. When omitted, reads from
   * `process.env.YANDEX_SA_KEY_JSON`. Accepts raw JSON or base64.
   */
  saKeyJson?: string;
};

/**
 * Returns a valid Yandex IAM token, minting a new one only when the cached
 * value is missing or within {@link REFRESH_SAFETY_MS} of its expiry.
 */
export async function getIamToken(
  opts: GetIamTokenOpts = {},
): Promise<string> {
  const now = opts.now?.() ?? Date.now();
  if (cachedToken && cachedToken.expiresAtMs - now > REFRESH_SAFETY_MS) {
    return cachedToken.token;
  }

  const raw = opts.saKeyJson ?? process.env.YANDEX_SA_KEY_JSON;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "YANDEX_SA_KEY_JSON env var not set; cannot mint Yandex IAM token",
    );
  }

  const sa = parseSaKey(raw);
  const jwt = signJwt(sa, now);

  const fetcher = opts.fetcher ?? fetch;
  const resp = await fetcher(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });
  if (!resp.ok) {
    const detail = await readBodySafe(resp);
    throw new Error(
      `Yandex IAM token exchange failed: HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
    );
  }

  const data = (await resp.json()) as { iamToken?: string; expiresAt?: string };
  if (!data.iamToken) {
    throw new Error("Yandex IAM response missing `iamToken` field");
  }
  const expiresAtMs = data.expiresAt
    ? new Date(data.expiresAt).getTime()
    : now + FALLBACK_IAM_TTL_MS;
  cachedToken = { token: data.iamToken, expiresAtMs };
  return data.iamToken;
}

/**
 * Test-only escape hatch — clears the in-process cache so successive tests
 * see a cold start. Never call from production code.
 */
export function _resetCachedTokenForTests(): void {
  cachedToken = null;
}

function parseSaKey(raw: string): SaKey {
  const trimmed = raw.trim();
  let jsonText: string;
  if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else {
    try {
      jsonText = Buffer.from(trimmed, "base64").toString("utf8");
    } catch {
      throw new Error(
        "YANDEX_SA_KEY_JSON is not valid raw JSON or base64-encoded JSON",
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `YANDEX_SA_KEY_JSON parse failure: ${(err as Error).message}`,
    );
  }
  const obj = parsed as Partial<SaKey>;
  if (!obj.id || !obj.service_account_id || !obj.private_key) {
    throw new Error(
      "YANDEX_SA_KEY_JSON missing required fields (id, service_account_id, private_key)",
    );
  }
  return {
    id: obj.id,
    service_account_id: obj.service_account_id,
    private_key: obj.private_key,
  };
}

function signJwt(sa: SaKey, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const header = base64urlString(
    JSON.stringify({ typ: "JWT", alg: "PS256", kid: sa.id }),
  );
  const claims = base64urlString(
    JSON.stringify({ iss: sa.service_account_id, aud: IAM_TOKEN_URL, iat, exp }),
  );
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(sa.private_key);
  const sig = sign("RSA-SHA256", Buffer.from(signingInput), {
    key,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

function base64urlString(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

async function readBodySafe(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
