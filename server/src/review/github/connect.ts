/**
 * T013 — GitHub App connect core.
 *
 * Pure, injectable, side-effect-free functions for the GitHub App install
 * redirect flow and post-install callback handling.
 *
 *   - buildInstallUrl            — builds the GitHub App installation URL
 *   - buildUserAuthorizationUrl  — builds the GitHub App OAuth URL
 *   - buildConnectState          — creates a stateless HMAC-signed CSRF nonce
 *   - verifyConnectState         — verifies and decodes the CSRF nonce
 *   - handleInstallCallback — orchestrates metadata fetch + upsert + repo reconcile
 *
 * No module-level singletons. All external dependencies are injected.
 * No console.log. Immutability: inputs never mutated; only new objects created.
 */
import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { Installation } from "../../db/schema.ts";
import type { ReviewService } from "../service.ts";
import type { GitHubClient } from "./client.ts";

// ── Constants ────────────────────────────────────────────────────────────────

/** Default maximum age for a connect state nonce (15 minutes). */
const DEFAULT_STATE_MAX_AGE_MS = 15 * 60 * 1000;

/** Separator between the payload and HMAC signature in the state string. */
const STATE_SEP = ".";
const STRUCTURED_STATE_PREFIX = "json";

export interface VerifiedConnectState {
  readonly userId: string;
  readonly installationId?: string;
  readonly setupAction?: string | null;
}

interface StructuredConnectState {
  readonly v: 2;
  readonly userId: string;
  readonly ts: number;
  readonly installationId?: string;
  readonly setupAction?: string | null;
}

// ── buildInstallUrl ──────────────────────────────────────────────────────────

/**
 * Build the GitHub App installation URL that the user is redirected to when
 * clicking "Connect GitHub App". After completing the installation, GitHub
 * redirects back with `?installation_id=...&setup_action=...&state=...`.
 *
 * @param args.slug  The GitHub App slug (the `GITHUB_APP_SLUG` config value).
 * @param args.state The CSRF state nonce (from `buildConnectState`).
 * @returns          The full installation URL.
 */
export function buildInstallUrl(args: { slug: string; state: string }): string {
  const params = new URLSearchParams({ state: args.state });
  return `https://github.com/apps/${args.slug}/installations/new?${params.toString()}`;
}

// ── buildUserAuthorizationUrl ───────────────────────────────────────────────

/**
 * Build the GitHub App user-authorization URL used after a setup callback
 * returns only `installation_id` and `state`. The OAuth `code` returned by this
 * flow lets the callback prove the signed-in GitHub user can access the
 * claimed installation.
 */
export function buildUserAuthorizationUrl(args: {
  clientId: string;
  state: string;
  redirectUri?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    state: args.state,
  });
  if (args.redirectUri !== undefined) {
    params.set("redirect_uri", args.redirectUri);
  }
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

// ── buildConnectState ────────────────────────────────────────────────────────

/**
 * Build a stateless, HMAC-signed CSRF nonce for the GitHub App OAuth flow.
 *
 * Format (base64url-encoded):
 *   `<payload>.<hmac-sha256-hex>`
 *
 * Payload:
 *   `<userId>.<timestampMs>`
 *
 * The HMAC is computed over the payload string with the session cookie secret
 * as the key. No DB storage is required — the state is self-verifying.
 *
 * @param args.userId  The authenticated user ID to embed in the nonce.
 * @param args.now     Current timestamp in milliseconds (injectable for tests).
 * @param args.secret  HMAC signing secret (TENSOL_SESSION_COOKIE_SECRET).
 * @returns            A base64url-encoded, period-delimited nonce string.
 */
export function buildConnectState(args: {
  userId: string;
  now: number;
  secret: string;
  installationId?: string;
  setupAction?: string | null;
}): string {
  if (args.installationId !== undefined || args.setupAction !== undefined) {
    const structured: StructuredConnectState = {
      v: 2,
      userId: args.userId,
      ts: args.now,
      ...(args.installationId !== undefined
        ? { installationId: args.installationId }
        : {}),
      ...(args.setupAction !== undefined ? { setupAction: args.setupAction } : {}),
    };
    const payload = Buffer.from(JSON.stringify(structured), "utf8").toString(
      "base64url",
    );
    const signedPayload = `${STRUCTURED_STATE_PREFIX}${STATE_SEP}${payload}`;
    const sig = computeHmac(args.secret, signedPayload);
    return Buffer.from(`${signedPayload}${STATE_SEP}${sig}`, "utf8").toString(
      "base64url",
    );
  }

  const payload = `${args.userId}${STATE_SEP}${args.now}`;
  const sig = computeHmac(args.secret, payload);
  const raw = `${payload}${STATE_SEP}${sig}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

// ── verifyConnectState ───────────────────────────────────────────────────────

/**
 * Verify and decode a connect state nonce produced by `buildConnectState`.
 *
 * Rejects when:
 *   - The state is empty or malformed (cannot be parsed)
 *   - The HMAC does not match (tampered state or wrong secret)
 *   - The nonce is older than `maxAgeMs` milliseconds (default 15 min)
 *
 * @param args.state    The state string from the GitHub redirect callback.
 * @param args.secret   HMAC signing secret (must match the one used to build).
 * @param args.maxAgeMs Maximum nonce age in milliseconds (default 15 min).
 * @param args.now      Current timestamp in ms (injectable for tests).
 * @returns             `{ userId }` on success, or `null` on failure.
 */
export function verifyConnectState(args: {
  state: string;
  secret: string;
  maxAgeMs?: number;
  now?: number;
}): VerifiedConnectState | null {
  if (!args.state) return null;

  let raw: string;
  try {
    raw = Buffer.from(args.state, "base64url").toString("utf8");
  } catch {
    return null;
  }

  if (raw.startsWith(`${STRUCTURED_STATE_PREFIX}${STATE_SEP}`)) {
    return verifyStructuredConnectState(args, raw);
  }

  // Expected format: "<userId>.<timestampMs>.<hmac-hex>"
  // userId itself may not contain "." — split from the right to be safe.
  const lastDot = raw.lastIndexOf(STATE_SEP);
  if (lastDot === -1) return null;

  const payload = raw.slice(0, lastDot);
  const receivedSig = raw.slice(lastDot + 1);

  if (!payload || !receivedSig) return null;

  // Verify HMAC constant-time.
  const expectedSig = computeHmac(args.secret, payload);
  if (!constantTimeEqual(expectedSig, receivedSig)) return null;

  // Parse payload: "<userId>.<timestampMs>"
  const lastDotInPayload = payload.lastIndexOf(STATE_SEP);
  if (lastDotInPayload === -1) return null;

  const userId = payload.slice(0, lastDotInPayload);
  const tsStr = payload.slice(lastDotInPayload + 1);

  if (!userId || !tsStr) return null;

  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || ts <= 0) return null;

  // Check age.
  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? DEFAULT_STATE_MAX_AGE_MS;
  if (now - ts > maxAge) return null;

  return { userId };
}

function verifyStructuredConnectState(
  args: {
    state: string;
    secret: string;
    maxAgeMs?: number;
    now?: number;
  },
  raw: string,
): VerifiedConnectState | null {
  const lastDot = raw.lastIndexOf(STATE_SEP);
  if (lastDot === -1) return null;

  const signedPayload = raw.slice(0, lastDot);
  const receivedSig = raw.slice(lastDot + 1);
  if (!signedPayload || !receivedSig) return null;

  const expectedSig = computeHmac(args.secret, signedPayload);
  if (!constantTimeEqual(expectedSig, receivedSig)) return null;

  const prefix = `${STRUCTURED_STATE_PREFIX}${STATE_SEP}`;
  const encodedPayload = signedPayload.slice(prefix.length);
  if (!encodedPayload) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;
  const claims = parsed as Partial<StructuredConnectState>;
  if (claims.v !== 2) return null;
  if (typeof claims.userId !== "string" || claims.userId.length === 0) {
    return null;
  }
  if (typeof claims.ts !== "number" || !Number.isFinite(claims.ts) || claims.ts <= 0) {
    return null;
  }

  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? DEFAULT_STATE_MAX_AGE_MS;
  if (now - claims.ts > maxAge) return null;

  const result: {
    userId: string;
    installationId?: string;
    setupAction?: string | null;
  } = { userId: claims.userId };
  if (
    typeof claims.installationId === "string" &&
    claims.installationId.length > 0
  ) {
    result.installationId = claims.installationId;
  }
  if (claims.setupAction === null) {
    result.setupAction = null;
  } else if (
    typeof claims.setupAction === "string" &&
    claims.setupAction.length > 0
  ) {
    result.setupAction = claims.setupAction;
  }

  return result;
}

// ── handleInstallCallback ────────────────────────────────────────────────────

/**
 * Handle the GitHub App post-installation callback (the redirect back to our
 * server after the user completes the GitHub App installation flow).
 *
 * Steps:
 *   1. Fetch installation metadata from GitHub (accountLogin, accountType,
 *      repositorySelection) using the App JWT.
 *   2. Upsert the `installations` row (idempotent by scm+installationId).
 *   3. List repos accessible to the installation.
 *   4. Reconcile `review_repos` rows (upsert + link to installation row).
 *
 * All args are injected (no module-level state) so callers and tests can
 * provide fakes for GitHub and the service.
 *
 * @param args.installationId GitHub's installation id (from the callback query param).
 * @param args.setupAction    The `setup_action` query param ("install", "update", etc.).
 * @param args.userId         The authenticated user who triggered the install.
 * @param args.github         The GitHub client (real or Fake for tests).
 * @param args.service        The review service (real or Fake for tests).
 * @param args.now            Clock function (injectable for tests).
 * @returns                   The persisted `Installation` row.
 */
export async function handleInstallCallback(args: {
  installationId: string;
  setupAction: string | null;
  userId: string;
  github: GitHubClient;
  service: ReviewService;
  now?: () => number;
}): Promise<Installation> {
  const { installationId, setupAction, userId, github, service } = args;

  // 1. Fetch installation metadata from GitHub.
  const meta = await github.getInstallationMetadata({ installationId });

  // 2. Upsert the installation row.
  const installation = await service.upsertInstallation({
    userId,
    scm: "github",
    installationId,
    accountLogin: meta.accountLogin,
    accountType: meta.accountType,
    repositorySelection: meta.repositorySelection,
    status: "active",
    ...(setupAction !== null ? { setupAction } : {}),
  });

  // 3. List repos accessible to this installation.
  const repos = await github.listInstallationRepos({ installationId });

  // 4. Reconcile review_repos — link each repo to the installation row.
  await service.reconcileInstallationRepos({
    installationRowId: installation.id,
    installationId,
    userId,
    selection: meta.repositorySelection,
    repos: repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      ...(r.defaultBranch !== undefined ? { defaultBranch: r.defaultBranch } : {}),
    })),
  });

  return installation;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute HMAC-SHA256 hex digest. */
function computeHmac(secret: string, message: string): string {
  const h = createHmac("sha256", secret);
  h.update(message);
  return h.digest("hex");
}

/** Constant-time string comparison (leaks length — not a secret-content leak). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}
