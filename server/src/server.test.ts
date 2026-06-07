import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDb } from "./db/client.ts";
import { hmacSha256 } from "./lib/crypto.ts";
import { FakeGitHubClient } from "./review/github/client.ts";
import { createReviewService } from "./review/service.ts";
import { applyMigrationsOnce, createApp } from "./server.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

function raw(db: ReturnType<typeof createDb>): Database {
  return db.$client as Database;
}

function execMigrationFile(db: ReturnType<typeof createDb>, file: string): void {
  raw(db).exec(
    readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(
      /-->\s*statement-breakpoint/g,
      "",
    ),
  );
}

function tableExists(db: ReturnType<typeof createDb>, name: string): boolean {
  return Boolean(
    raw(db)
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name),
  );
}

function appliedTags(db: ReturnType<typeof createDb>): string[] {
  return raw(db)
    .query<{ tag: string }, []>("SELECT tag FROM __migrations ORDER BY tag")
    .all()
    .map((row) => row.tag);
}

describe("applyMigrationsOnce", () => {
  test("warms an older DB and applies new migrations instead of skipping on users", () => {
    const db = createDb(":memory:");
    execMigrationFile(db, "0000_init.sql");

    expect(tableExists(db, "users")).toBe(true);
    expect(tableExists(db, "agent_api_tokens")).toBe(false);

    const first = applyMigrationsOnce(db, MIGRATIONS_DIR);

    expect(first.applied).toBe(true);
    expect(tableExists(db, "agent_api_tokens")).toBe(true);
    expect(appliedTags(db)).toContain("0000_init");
    expect(appliedTags(db)).toContain("0015_agent_api_tokens");

    const second = applyMigrationsOnce(db, MIGRATIONS_DIR);
    expect(second.applied).toBe(false);
  });
});

describe("createApp GitHub webhook wiring", () => {
  test("CORS preflight allows PATCH for repository settings", async () => {
    const db = createDb(":memory:");
    const app = createApp({
      db,
      signingKey: "test-key-cors-0123456789abcdef0123456789abcdef",
      sessionCookieSecret: "session-secret-0123456789abcdef",
      baseUrl: "http://localhost",
      emailMode: "stdout",
      isProd: false,
      webhookSecret: "scan-webhook-secret",
      telegramWebhookSecret: "telegram-webhook-secret",
      operatorEmails: [],
      reviewLlm: null,
      githubAppWebhookSecret: "github-webhook-secret",
      githubAppSlug: "sthrip-app",
    });

    const res = await app.fetch(
      new Request("http://localhost/v1/review/repos/repo_1/settings", {
        method: "OPTIONS",
        headers: {
          origin: "https://sthrip.dev",
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "Authorization, Content-Type",
        },
      }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://sthrip.dev",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
  });

  test("passes the configured GitHub client to the comment-trigger webhook", async () => {
    const db = createDb(":memory:");
    applyMigrationsOnce(db, MIGRATIONS_DIR);
    raw(db)
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run("user_1", "user_1@x.io", 1_700_000_000_000);

    const service = createReviewService({
      db,
      auditKey: "test-key-create-app-review-0123456789abcdef0123456789abcdef",
      now: () => 1_700_000_000_000,
    });
    await service.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "50001",
      accountLogin: "corp",
      accountType: "Organization",
      repositorySelection: "all",
    });
    await service.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "corp",
      name: "project",
      installationId: "50001",
    });

    const github = new FakeGitHubClient({
      pullRequestInfo: {
        headSha: "head-from-create-app",
        baseSha: "base-from-create-app",
        baseRef: "main",
      },
    });
    const secret = "github-webhook-secret";
    const app = createApp({
      db,
      signingKey: "test-key-create-app-review-0123456789abcdef0123456789abcdef",
      sessionCookieSecret: "session-secret-0123456789abcdef",
      baseUrl: "http://localhost",
      emailMode: "stdout",
      isProd: false,
      webhookSecret: "scan-webhook-secret",
      telegramWebhookSecret: "telegram-webhook-secret",
      operatorEmails: [],
      reviewLlm: null,
      githubAppWebhookSecret: secret,
      githubAppSlug: "sthrip-app",
      githubConnectClient: github,
    });

    const body = JSON.stringify({
      action: "created",
      installation: { id: 50001 },
      repository: { full_name: "corp/project" },
      issue: {
        number: 7,
        pull_request: { url: "https://api.github.com/repos/corp/project/pulls/7" },
      },
      comment: {
        body: "@sthrip review",
        user: { login: "alice", type: "User" },
      },
    });
    const res = await app.fetch(
      new Request("http://localhost/v1/review/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-github-delivery": "create-app-delivery-1",
          "x-hub-signature-256": `sha256=${hmacSha256(secret, body)}`,
        },
        body,
      }),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { status: string; review_id?: string };
    expect(json.status).toBe("queued");
    expect(json.review_id).toBeDefined();
    expect(github.getPullRequestCalls).toHaveLength(1);
  });
});
