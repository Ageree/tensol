/**
 * T101 — DeepInquiriesService tests.
 *
 * Validates the 4-method service surface per spec FR-031..FR-038
 * (Deep-engagement lead-gen funnel) and data-model.md §E6 state machine:
 *
 *   createInquiry(args) — anonymous OR logged-in, sanitizes scope_text,
 *                         inserts row, enqueues send_deep_inquiry_telegram
 *                         job, emits inquiry_received audit AFTER tx commit
 *   setStatus(id, s)    — validates VALID_TRANSITIONS:
 *                           new       → contacted | declined | dropped
 *                           contacted → converted | declined | dropped
 *                           converted → ∅ (terminal)
 *                           declined  → ∅ (terminal)
 *                           dropped   → new (operator re-open)
 *                         emits inquiry_status_changed audit
 *   getInquiry(id)      — read shape; null if missing
 *   listInquiries(opts) — newest-first; optional status filter
 *
 * Constitution invariants pinned:
 *   - VI:  illegal transition → throw with `code === 'CONFLICT'`.
 *   - VII: file ≤ 800 LOC.
 *   - IX:  body has already been Zod-validated; the service trusts shape.
 *   - X:   every state-change emits a signed audit row AFTER tx commit.
 *
 * Test infra mirrors `server/src/scan-orders/service.test.ts`:
 *   - in-memory bun:sqlite + ALL migrations applied
 *   - HMAC signing key threaded explicitly (Constitution X — emit.ts
 *     refuses to read process env)
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import {
  users as usersTable,
  deepInquiries as deepInquiriesTable,
  jobs as jobsTable,
  auditLog as auditLogTable,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { createDeepInquiriesService } from "./service.ts";
import type { CreateInquiryBody } from "../schemas/deep-inquiries.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-deep-inquiries";

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
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

function seedUser(db: DB, ts: number = 1_700_000_000_000): string {
  const id = ulid(ts);
  db.insert(usersTable)
    .values({ id, email: `${id}@test.local`, createdAt: ts })
    .run();
  return id;
}

function buildSvc(db: DB) {
  let n = 1_700_000_000_000;
  return createDeepInquiriesService({
    db,
    auditKey: KEY,
    now: () => ++n,
  });
}

function validBody(overrides: Partial<CreateInquiryBody> = {}): CreateInquiryBody {
  return {
    company: "Acme Corp",
    contact_name: "Jane Operator",
    phone: "+79991234567",
    domains_text: "example.com\napi.example.com",
    scope_text: "We want a thorough pentest of our API surface.",
    consent_accepted: true,
    ...overrides,
  } as CreateInquiryBody;
}

function countAudit(db: DB, event: string): number {
  const row = db
    .select({ c: count() })
    .from(auditLogTable)
    .where(eq(auditLogTable.event, event))
    .get();
  return row?.c ?? 0;
}

function countJobs(db: DB, type: string): number {
  const row = db
    .select({ c: count() })
    .from(jobsTable)
    .where(eq(jobsTable.type, type as never))
    .get();
  return row?.c ?? 0;
}

function readInquiry(db: DB, id: string) {
  return db
    .select()
    .from(deepInquiriesTable)
    .where(eq(deepInquiriesTable.id, id))
    .get();
}

// ───────────────────────────────────────────────────────────────────────────
// createInquiry — anonymous flow
// ───────────────────────────────────────────────────────────────────────────
describe("createInquiry — anonymous", () => {
  test("no userId → row.user_id = null", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);

    const result = await svc.createInquiry({ body: validBody() });

    expect(result.id).toBeTruthy();
    const row = readInquiry(db, result.id);
    expect(row?.userId).toBeNull();
    expect(row?.status).toBe("new");
  });

  test("emits inquiry_received audit AFTER commit", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    await svc.createInquiry({ body: validBody() });
    expect(countAudit(db, "inquiry_received")).toBe(1);
  });

  test("enqueues send_deep_inquiry_telegram job", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const result = await svc.createInquiry({ body: validBody() });
    expect(countJobs(db, "send_deep_inquiry_telegram")).toBe(1);

    // Job payload references the inquiry id
    const jobRow = db.select().from(jobsTable).get();
    expect(jobRow?.status).toBe("pending");
    const payload = JSON.parse(jobRow!.payloadJson) as {
      type: string;
      inquiry_id?: string;
      inquiryId?: string;
    };
    expect(payload.type).toBe("send_deep_inquiry_telegram");
    expect(payload.inquiry_id ?? payload.inquiryId).toBe(result.id);
  });

  test("uses custom enqueueJob DI when provided", async () => {
    const db = freshMemDb();
    const calls: Array<{ kind: string; payload: unknown }> = [];
    const svc = createDeepInquiriesService({
      db,
      auditKey: KEY,
      enqueueJob: async (kind, payload) => {
        calls.push({ kind, payload });
        return "job-id-stub";
      },
    });

    const result = await svc.createInquiry({ body: validBody() });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("send_deep_inquiry_telegram");
    const p = calls[0]?.payload as { inquiry_id?: string; inquiryId?: string };
    expect(p.inquiry_id ?? p.inquiryId).toBe(result.id);
    // No default-enqueue side-effect because DI overrode the path
    expect(countJobs(db, "send_deep_inquiry_telegram")).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createInquiry — logged-in flow
// ───────────────────────────────────────────────────────────────────────────
describe("createInquiry — logged-in", () => {
  test("userId set → row.user_id populated", async () => {
    const db = freshMemDb();
    const userId = seedUser(db);
    const svc = buildSvc(db);

    const result = await svc.createInquiry({ body: validBody(), userId });
    const row = readInquiry(db, result.id);
    expect(row?.userId).toBe(userId);
  });

  test("null userId is treated as anonymous", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const result = await svc.createInquiry({ body: validBody(), userId: null });
    const row = readInquiry(db, result.id);
    expect(row?.userId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createInquiry — sanitization round-trip
// ───────────────────────────────────────────────────────────────────────────
describe("createInquiry — sanitization", () => {
  test("scope_text containing password:foo is redacted in DB row", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);

    const result = await svc.createInquiry({
      body: validBody({
        scope_text:
          "We want a pentest. Test creds: password:supersecret123 — please ignore",
      }),
    });

    const row = readInquiry(db, result.id);
    expect(row?.scopeText).toContain("[REDACTED]");
    expect(row?.scopeText).not.toContain("supersecret123");

    expect(result.sanitization.redactedCount).toBeGreaterThanOrEqual(1);
    expect(result.sanitization.rulesHit).toContain("password-key-value");
  });

  test("clean scope_text passes through unchanged with redactedCount=0", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const clean = "Standard pentest of api.example.com — no secrets here.";
    const result = await svc.createInquiry({
      body: validBody({ scope_text: clean }),
    });
    const row = readInquiry(db, result.id);
    expect(row?.scopeText).toBe(clean);
    expect(result.sanitization.redactedCount).toBe(0);
    expect(result.sanitization.rulesHit).toEqual([]);
  });

  test("result shape: {id, sanitization: {redactedCount, rulesHit}}", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const result = await svc.createInquiry({ body: validBody() });
    expect(typeof result.id).toBe("string");
    expect(typeof result.sanitization.redactedCount).toBe("number");
    expect(Array.isArray(result.sanitization.rulesHit)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// setStatus — legal transitions
// ───────────────────────────────────────────────────────────────────────────
describe("setStatus — legal transitions", () => {
  test("new → contacted → converted, each emits inquiry_status_changed", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });

    await svc.setStatus(id, "contacted");
    expect(readInquiry(db, id)?.status).toBe("contacted");

    await svc.setStatus(id, "converted");
    expect(readInquiry(db, id)?.status).toBe("converted");

    expect(countAudit(db, "inquiry_status_changed")).toBe(2);
  });

  test("new → declined emits audit", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });
    await svc.setStatus(id, "declined");
    expect(readInquiry(db, id)?.status).toBe("declined");
    expect(countAudit(db, "inquiry_status_changed")).toBe(1);
  });

  test("dropped → new (operator can re-open)", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });
    await svc.setStatus(id, "dropped");
    await svc.setStatus(id, "new");
    expect(readInquiry(db, id)?.status).toBe("new");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// setStatus — illegal transitions
// ───────────────────────────────────────────────────────────────────────────
describe("setStatus — illegal", () => {
  test("converted → contacted throws CONFLICT", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });
    await svc.setStatus(id, "contacted");
    await svc.setStatus(id, "converted");

    let caught: unknown;
    try {
      await svc.setStatus(id, "contacted");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe("CONFLICT");
    // Row stayed terminal
    expect(readInquiry(db, id)?.status).toBe("converted");
  });

  test("declined → converted throws CONFLICT (terminal)", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });
    await svc.setStatus(id, "declined");
    let caught: unknown;
    try {
      await svc.setStatus(id, "converted");
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { code?: string }).code).toBe("CONFLICT");
  });

  test("new → new throws CONFLICT (no-op transition rejected)", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });
    let caught: unknown;
    try {
      await svc.setStatus(id, "new");
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { code?: string }).code).toBe("CONFLICT");
  });

  test("setStatus on unknown id throws NOT_FOUND", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    let caught: unknown;
    try {
      await svc.setStatus("01ARZ3NDEKTSV4RRFFQ69G5FAV", "contacted");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe("NOT_FOUND");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// getInquiry / listInquiries (reads)
// ───────────────────────────────────────────────────────────────────────────
describe("getInquiry", () => {
  test("returns row by id", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const { id } = await svc.createInquiry({ body: validBody() });
    const row = await svc.getInquiry(id);
    expect(row?.id).toBe(id);
    expect(row?.company).toBe("Acme Corp");
    expect(row?.status).toBe("new");
  });

  test("returns null for missing id", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const row = await svc.getInquiry("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(row).toBeNull();
  });
});

describe("listInquiries", () => {
  test("returns newest-first by created_at", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const a = await svc.createInquiry({ body: validBody({ company: "A" }) });
    const b = await svc.createInquiry({ body: validBody({ company: "B" }) });
    const c = await svc.createInquiry({ body: validBody({ company: "C" }) });

    const rows = await svc.listInquiries();
    expect(rows.length).toBe(3);
    // newest first → c, b, a (ts increments per call)
    expect(rows[0]?.id).toBe(c.id);
    expect(rows[1]?.id).toBe(b.id);
    expect(rows[2]?.id).toBe(a.id);
  });

  test("status filter narrows results", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    const a = await svc.createInquiry({ body: validBody({ company: "A" }) });
    await svc.createInquiry({ body: validBody({ company: "B" }) });
    await svc.setStatus(a.id, "contacted");

    const newRows = await svc.listInquiries({ status: "new" });
    expect(newRows.length).toBe(1);
    const contactedRows = await svc.listInquiries({ status: "contacted" });
    expect(contactedRows.length).toBe(1);
    expect(contactedRows[0]?.id).toBe(a.id);
  });

  test("limit truncates", async () => {
    const db = freshMemDb();
    const svc = buildSvc(db);
    await svc.createInquiry({ body: validBody({ company: "A" }) });
    await svc.createInquiry({ body: validBody({ company: "B" }) });
    await svc.createInquiry({ body: validBody({ company: "C" }) });
    const rows = await svc.listInquiries({ limit: 2 });
    expect(rows.length).toBe(2);
  });
});
