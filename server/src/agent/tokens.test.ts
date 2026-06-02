import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDb, type DB } from "../db/client.ts";
import { agentApiTokens as agentApiTokensTable } from "../db/schema.ts";
import {
  authenticateAgentToken,
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  sha256Token,
} from "./tokens.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

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

let clockNow = 1_700_000_100_000;
const clock = () => clockNow++;

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("user_1", "user_1@x.io", clockNow);
  return db;
}

describe("agent API tokens", () => {
  test("create stores only a hash and returns plaintext once", async () => {
    const db = freshMemDb();

    const created = await createAgentToken({
      db,
      userId: "user_1",
      name: "codex",
      now: clock,
    });

    expect(created.token.startsWith("sthrip_")).toBe(true);
    expect(created.record.name).toBe("codex");
    expect(created.record.tokenPrefix).toBe(created.token.slice(0, 18));

    const row = db.select().from(agentApiTokensTable).all()[0]!;
    expect(row.tokenHash).toBe(sha256Token(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const listed = await listAgentTokens({ db, userId: "user_1" });
    expect(listed).toEqual([
      {
        id: created.record.id,
        name: "codex",
        tokenPrefix: created.token.slice(0, 18),
        createdAt: created.record.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
  });

  test("authenticate succeeds, records last_used_at, and revoked tokens fail", async () => {
    const db = freshMemDb();
    const created = await createAgentToken({
      db,
      userId: "user_1",
      name: "mcp",
      now: clock,
    });

    const auth = await authenticateAgentToken({
      db,
      token: created.token,
      now: clock,
    });

    expect(auth?.user).toEqual({ id: "user_1", email: "user_1@x.io" });
    expect(auth?.token.id).toBe(created.record.id);
    expect(auth?.token.name).toBe("mcp");

    const listedAfterUse = await listAgentTokens({ db, userId: "user_1" });
    expect(listedAfterUse[0]!.lastUsedAt).toBeGreaterThan(created.record.createdAt);

    const revoked = await revokeAgentToken({
      db,
      userId: "user_1",
      tokenId: created.record.id,
      now: clock,
    });
    expect(revoked).toBe(true);

    const afterRevoke = await authenticateAgentToken({
      db,
      token: created.token,
      now: clock,
    });
    expect(afterRevoke).toBeNull();
  });

  test("malformed tokens and cross-user revokes fail closed", async () => {
    const db = freshMemDb();
    (db.$client as Database)
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run("user_2", "user_2@x.io", clockNow);
    const created = await createAgentToken({
      db,
      userId: "user_1",
      name: "cli",
      now: clock,
    });

    expect(
      await authenticateAgentToken({ db, token: "not-a-sthrip-token", now: clock }),
    ).toBeNull();
    expect(
      await revokeAgentToken({
        db,
        userId: "user_2",
        tokenId: created.record.id,
        now: clock,
      }),
    ).toBe(false);

    const stillWorks = await authenticateAgentToken({
      db,
      token: created.token,
      now: clock,
    });
    expect(stillWorks?.user.id).toBe("user_1");
  });
});
