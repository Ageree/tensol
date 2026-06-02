import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";

import type { AuthVariables } from "../auth/middleware.ts";
import { createDb, type DB } from "../db/client.ts";
import { jobs as jobsTable } from "../db/schema.ts";
import { createReviewService } from "../review/service.ts";
import { createAgentRouter } from "./agent.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-agent-routes-0123456789abcdef0123456789abcdef";

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

let clockNow = 1_700_000_200_000;
const clock = () => clockNow++;

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("user_1", "user_1@x.io", clockNow);
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("user_2", "user_2@x.io", clockNow);
  return db;
}

const fakeAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.set("user", { id: "user_1", email: "user_1@x.io" });
  c.set("session", { id: "s1", user_id: "user_1", expires_at: clockNow + 1e9 });
  await next();
};

function makeApp(db: DB) {
  const service = createReviewService({ db, auditKey: KEY, now: clock });
  const app = new Hono();
  app.route(
    "/v1/agent",
    createAgentRouter({
      db,
      service,
      requireAuth: fakeAuth,
      now: clock,
    }),
  );
  return { app, service };
}

async function issueToken(app: Hono): Promise<string> {
  const res = await app.request("/v1/agent/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "codex" }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { token: string };
  return json.token;
}

describe("/v1/agent token management", () => {
  test("cookie-authenticated users can create, list, and revoke tokens", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);
    const token = await issueToken(app);
    expect(token.startsWith("sthrip_")).toBe(true);

    const list = await app.request("/v1/agent/tokens");
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { tokens: { id: string; token_prefix: string }[] };
    expect(listJson.tokens.length).toBe(1);
    expect(listJson.tokens[0]!.token_prefix).toBe(token.slice(0, 18));

    const del = await app.request(`/v1/agent/tokens/${listJson.tokens[0]!.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { revoked: boolean }).revoked).toBe(true);

    const health = await app.request("/v1/agent/health", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(health.status).toBe(401);
  });
});

describe("/v1/agent bearer API", () => {
  test("health, reviews, detail, findings, whitebox launch, and job status are owner-scoped", async () => {
    const db = freshMemDb();
    const { app, service } = makeApp(db);
    const token = await issueToken(app);

    const repo = await service.upsertRepo({ userId: "user_1", owner: "acme", name: "api" });
    const own = await service.createQueuedReviewWithJob(
      { repoId: repo.id, userId: "user_1", kind: "whitebox", mode: "fast" },
      "whitebox_scan",
    );
    const otherRepo = await service.upsertRepo({ userId: "user_2", owner: "evil", name: "api" });
    const other = await service.createQueuedReviewWithJob(
      { repoId: otherRepo.id, userId: "user_2", kind: "whitebox", mode: "fast" },
      "whitebox_scan",
    );

    const health = await app.request("/v1/agent/health", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(health.status).toBe(200);
    expect(((await health.json()) as { user: { id: string } }).user.id).toBe("user_1");

    const list = await app.request("/v1/agent/reviews", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { reviews: { review_id: string; mode: string }[] };
    expect(listJson.reviews.map((r) => r.review_id)).toContain(own.review.id);
    expect(listJson.reviews.map((r) => r.review_id)).not.toContain(other.review.id);
    expect(listJson.reviews[0]!.mode).toBe("fast");

    const detail = await app.request(`/v1/agent/reviews/${own.review.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { id: string; mode: string }).mode).toBe("fast");

    const findings = await app.request(`/v1/agent/reviews/${own.review.id}/findings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(findings.status).toBe(200);
    expect(((await findings.json()) as { findings: unknown[] }).findings).toEqual([]);

    const hidden = await app.request(`/v1/agent/reviews/${other.review.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(hidden.status).toBe(404);

    const ownJob = db.select().from(jobsTable).where(eq(jobsTable.id, own.jobId)).get()!;
    const job = await app.request(`/v1/agent/jobs/${ownJob.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(job.status).toBe(200);
    const jobJson = (await job.json()) as { job_id: string; review_id: string; status: string };
    expect(jobJson.job_id).toBe(own.jobId);
    expect(jobJson.review_id).toBe(own.review.id);
    expect(jobJson.status).toBe("pending");

    const otherJob = await app.request(`/v1/agent/jobs/${other.jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(otherJob.status).toBe(404);

    const launch = await app.request("/v1/agent/whitebox", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "acme/new-api" }),
    });
    expect(launch.status).toBe(202);
    const launchJson = (await launch.json()) as { review_id: string; job_id: string; status: string };
    expect(launchJson.status).toBe("queued");
    expect(launchJson.review_id).toBeTruthy();
    expect(launchJson.job_id).toBeTruthy();
  });

  test("missing or malformed bearer token returns 401", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const missing = await app.request("/v1/agent/health");
    expect(missing.status).toBe(401);

    const malformed = await app.request("/v1/agent/health", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(malformed.status).toBe(401);
  });

  test("whitebox honors deep feature gate", async () => {
    const previous = process.env.TENSOL_RESEARCH_ENABLED;
    try {
      delete process.env.TENSOL_RESEARCH_ENABLED;
      const db = freshMemDb();
      const { app } = makeApp(db);
      const token = await issueToken(app);

      const disabled = await app.request("/v1/agent/whitebox", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ repo: "acme/deep-api", mode: "deep" }),
      });
      expect(disabled.status).toBe(422);
      expect(((await disabled.json()) as { error: string }).error).toBe("feature_disabled");

      process.env.TENSOL_RESEARCH_ENABLED = "true";
      const enabled = await app.request("/v1/agent/whitebox", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ repo: "acme/deep-api", mode: "deep" }),
      });
      expect(enabled.status).toBe(202);
      const queued = (await enabled.json()) as { review_id: string };

      const detail = await app.request(`/v1/agent/reviews/${queued.review_id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { mode: string }).mode).toBe("deep");
    } finally {
      if (previous === undefined) delete process.env.TENSOL_RESEARCH_ENABLED;
      else process.env.TENSOL_RESEARCH_ENABLED = previous;
    }
  });

  test("whitebox queueing is rate limited per token", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);
    const token = await issueToken(app);

    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/v1/agent/whitebox", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ repo: `acme/rate-${i}` }),
      });
      expect(res.status).toBe(202);
    }

    const limited = await app.request("/v1/agent/whitebox", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "acme/rate-over" }),
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
  });

  test("whitebox rejects oversized JSON bodies before parsing", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);
    const token = await issueToken(app);

    const res = await app.request("/v1/agent/whitebox", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repo: "acme/huge", ref: "x".repeat(70 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
  });
});
