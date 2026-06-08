/**
 * T013 — GitHub App connect core tests.
 *
 * Tests:
 *   1. buildInstallUrl  — correct URL shape
 *   2. buildConnectState / verifyConnectState — HMAC state round-trips, rejection of
 *      tampered states and expired states
 *   3. handleInstallCallback — persists installation, reconciles repos, is idempotent
 *
 * Harness: real in-memory SQLite with all migrations, FakeGitHubClient,
 * real createReviewService. Clock is injected and monotonic.
 *
 * No console.log. No mocked DB. No mocked audit signer.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDb, type DB } from "../../db/client.ts";
import { createReviewService } from "../service.ts";
import { FakeGitHubClient } from "./client.ts";
import {
  buildInstallUrl,
  buildUserAuthorizationUrl,
  buildConnectState,
  verifyConnectState,
  handleInstallCallback,
} from "./connect.ts";

// ── Test harness ─────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "migrations");

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

const AUDIT_KEY = "test-audit-key-0123456789abcdef0123456789abcdef0123456789ab";
const SECRET = "test-session-secret-0123456789abcdef0123456789abcdef0123456789";

let clockNow = 1_700_000_000_000;
const clock = () => clockNow++;

// Seed a user row the service can FK-reference.
function seedUser(db: DB, id: string): void {
  (db.$client as Database).exec(
    `INSERT INTO users (id, email, created_at) VALUES ('${id}', '${id}@test.com', ${Date.now()})`,
  );
}

// ── buildInstallUrl ───────────────────────────────────────────────────────────

describe("buildInstallUrl", () => {
  test("returns correct GitHub install URL with state", () => {
    const url = buildInstallUrl({ slug: "sthrip", state: "abc123" });
    expect(url).toBe("https://github.com/apps/sthrip/installations/new?state=abc123");
  });

  test("URL-encodes the state parameter", () => {
    const url = buildInstallUrl({ slug: "sthrip", state: "a+b=c&d" });
    expect(url).toContain("state=a%2Bb%3Dc%26d");
  });

  test("uses the slug in the path", () => {
    const url = buildInstallUrl({ slug: "my-app-slug", state: "x" });
    expect(url).toContain("/apps/my-app-slug/installations/new");
  });
});

describe("buildUserAuthorizationUrl", () => {
  test("returns the GitHub App OAuth URL with state and redirect_uri", () => {
    const url = new URL(
      buildUserAuthorizationUrl({
        clientId: "Iv1.client",
        state: "state-123",
        redirectUri: "https://api.sthrip.dev/v1/github/callback",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("Iv1.client");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.sthrip.dev/v1/github/callback",
    );
  });
});

// ── buildConnectState / verifyConnectState ────────────────────────────────────

describe("buildConnectState / verifyConnectState — round-trip", () => {
  test("verifies a freshly built state", () => {
    const now = 1_700_000_000_000;
    const state = buildConnectState({ userId: "user-1", now, secret: SECRET });
    const result = verifyConnectState({ state, secret: SECRET, now });
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-1");
  });

  test("round-trips setup callback context in structured state", () => {
    const now = 1_700_000_000_000;
    const state = buildConnectState({
      userId: "user-1",
      installationId: "123456",
      setupAction: "install",
      now,
      secret: SECRET,
    });
    const result = verifyConnectState({ state, secret: SECRET, now });

    expect(result).toEqual({
      userId: "user-1",
      installationId: "123456",
      setupAction: "install",
    });
  });

  test("state is base64url (no + or / or =)", () => {
    const state = buildConnectState({
      userId: "user-abc",
      now: 1_700_000_000_000,
      secret: SECRET,
    });
    // base64url uses - and _ instead of + and /, no = padding
    expect(state).toMatch(/^[A-Za-z0-9\-_.]+$/);
  });

  test("rejects tampered state (modified payload)", () => {
    const now = 1_700_000_000_000;
    const state = buildConnectState({ userId: "user-1", now, secret: SECRET });
    const tampered = state.slice(0, -3) + "xxx";
    const result = verifyConnectState({ state: tampered, secret: SECRET, now });
    expect(result).toBeNull();
  });

  test("rejects state signed with different secret", () => {
    const now = 1_700_000_000_000;
    const state = buildConnectState({ userId: "user-1", now, secret: SECRET });
    const result = verifyConnectState({ state, secret: "different-secret-abc", now });
    expect(result).toBeNull();
  });

  test("rejects expired state (default 15 min window)", () => {
    const createdAt = 1_700_000_000_000;
    const state = buildConnectState({ userId: "user-1", now: createdAt, secret: SECRET });
    // Verify 16 minutes later (exceeds default 15 min window)
    const verifyAt = createdAt + 16 * 60 * 1000;
    const result = verifyConnectState({ state, secret: SECRET, now: verifyAt });
    expect(result).toBeNull();
  });

  test("accepts state within custom maxAgeMs window", () => {
    const createdAt = 1_700_000_000_000;
    const state = buildConnectState({ userId: "user-1", now: createdAt, secret: SECRET });
    const verifyAt = createdAt + 5 * 60 * 1000; // 5 min later
    const result = verifyConnectState({
      state,
      secret: SECRET,
      maxAgeMs: 10 * 60 * 1000, // 10 min window
      now: verifyAt,
    });
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-1");
  });

  test("rejects state that exceeds custom maxAgeMs", () => {
    const createdAt = 1_700_000_000_000;
    const state = buildConnectState({ userId: "user-1", now: createdAt, secret: SECRET });
    const verifyAt = createdAt + 11 * 60 * 1000; // 11 min later
    const result = verifyConnectState({
      state,
      secret: SECRET,
      maxAgeMs: 10 * 60 * 1000, // 10 min window
      now: verifyAt,
    });
    expect(result).toBeNull();
  });

  test("handles different userIds correctly", () => {
    const now = 1_700_000_000_000;
    const s1 = buildConnectState({ userId: "user-A", now, secret: SECRET });
    const s2 = buildConnectState({ userId: "user-B", now, secret: SECRET });
    expect(s1).not.toBe(s2);
    expect(verifyConnectState({ state: s1, secret: SECRET, now })?.userId).toBe("user-A");
    expect(verifyConnectState({ state: s2, secret: SECRET, now })?.userId).toBe("user-B");
  });

  test("round-trips installation context for the setup-to-OAuth handoff", () => {
    const now = 1_700_000_000_000;
    const state = buildConnectState({
      userId: "user-1",
      installationId: "inst-42",
      setupAction: "install",
      now,
      secret: SECRET,
    });
    const result = verifyConnectState({ state, secret: SECRET, now });
    expect(result).toEqual({
      userId: "user-1",
      installationId: "inst-42",
      setupAction: "install",
    });
  });

  test("rejects malformed state (not valid base64url)", () => {
    const result = verifyConnectState({
      state: "not-valid-state-at-all",
      secret: SECRET,
      now: 1_700_000_000_000,
    });
    expect(result).toBeNull();
  });

  test("rejects empty state", () => {
    const result = verifyConnectState({ state: "", secret: SECRET, now: 1_700_000_000_000 });
    expect(result).toBeNull();
  });
});

// ── handleInstallCallback ─────────────────────────────────────────────────────

describe("handleInstallCallback", () => {
  let db: DB;
  let service: ReturnType<typeof createReviewService>;

  beforeEach(() => {
    clockNow = 1_700_000_000_000;
    db = freshMemDb();
    seedUser(db, "user-1");
    service = createReviewService({ db, auditKey: AUDIT_KEY, now: clock });
  });

  test("persists installation and returns it", async () => {
    const github = new FakeGitHubClient({
      installationMetadata: {
        accountLogin: "acme-org",
        accountType: "Organization",
        repositorySelection: "all",
      },
      installationRepos: [
        { owner: "acme-org", name: "backend", defaultBranch: "main" },
        { owner: "acme-org", name: "frontend", defaultBranch: "develop" },
      ],
    });

    const inst = await handleInstallCallback({
      installationId: "gh-install-42",
      setupAction: "install",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    expect(inst.installationId).toBe("gh-install-42");
    expect(inst.accountLogin).toBe("acme-org");
    expect(inst.accountType).toBe("Organization");
    expect(inst.repositorySelection).toBe("all");
    expect(inst.userId).toBe("user-1");
    expect(inst.status).toBe("active");
  });

  test("reconciles repos after persisting installation", async () => {
    const github = new FakeGitHubClient({
      installationMetadata: {
        accountLogin: "acme-org",
        accountType: "Organization",
        repositorySelection: "all",
      },
      installationRepos: [
        { owner: "acme-org", name: "backend", defaultBranch: "main" },
        { owner: "acme-org", name: "frontend", defaultBranch: "develop" },
      ],
    });

    await handleInstallCallback({
      installationId: "gh-install-42",
      setupAction: "install",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    // Verify repos were reconciled in the DB.
    const repos = await service.listReposByUser("user-1");
    const names = repos.map((r) => r.name).sort();
    expect(names).toEqual(["backend", "frontend"]);
    expect(repos.every((r) => r.owner === "acme-org")).toBe(true);
  });

  test("is idempotent — second call updates but does not duplicate", async () => {
    const github = new FakeGitHubClient({
      installationMetadata: {
        accountLogin: "acme-org",
        accountType: "Organization",
        repositorySelection: "all",
      },
      installationRepos: [
        { owner: "acme-org", name: "backend", defaultBranch: "main" },
      ],
    });

    await handleInstallCallback({
      installationId: "gh-install-42",
      setupAction: "install",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    // Call again with same installationId.
    await handleInstallCallback({
      installationId: "gh-install-42",
      setupAction: "install",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    const repos = await service.listReposByUser("user-1");
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe("backend");

    const inst = await service.getInstallationByGithubId("github", "gh-install-42");
    expect(inst).not.toBeNull();
  });

  test("calls getInstallationMetadata with the installationId", async () => {
    const github = new FakeGitHubClient({
      installationMetadata: {
        accountLogin: "solo-user",
        accountType: "User",
        repositorySelection: "selected",
      },
      installationRepos: [],
    });

    await handleInstallCallback({
      installationId: "gh-install-99",
      setupAction: "install",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    expect(github.getInstallationMetadataCalls).toHaveLength(1);
    expect(github.getInstallationMetadataCalls[0]?.installationId).toBe("gh-install-99");
  });

  test("passes setupAction to upsertInstallation", async () => {
    const github = new FakeGitHubClient({
      installationMetadata: {
        accountLogin: "acme-org",
        accountType: "Organization",
        repositorySelection: "all",
      },
      installationRepos: [],
    });

    const inst = await handleInstallCallback({
      installationId: "gh-install-42",
      setupAction: "update",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    expect(inst.setupAction).toBe("update");
  });

  test("works with empty repo list (no repos reconciled)", async () => {
    const github = new FakeGitHubClient({
      installationMetadata: {
        accountLogin: "empty-org",
        accountType: "Organization",
        repositorySelection: "selected",
      },
      installationRepos: [],
    });

    const inst = await handleInstallCallback({
      installationId: "gh-install-0",
      setupAction: "install",
      userId: "user-1",
      github,
      service,
      now: clock,
    });

    expect(inst.installationId).toBe("gh-install-0");
    const repos = await service.listReposByUser("user-1");
    expect(repos).toHaveLength(0);
  });
});
