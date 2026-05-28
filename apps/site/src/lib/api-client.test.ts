// T077 — Unit tests for the typed /v1 api-client.
//
// We stub `globalThis.fetch` and assert (a) the wire shape (URL, method,
// headers, body) and (b) the typed result. The five cases below cover the
// five HTTP verbs used by the client (GET / POST / PUT / DELETE) plus one
// error path through ApiError, which is the core invariant downstream
// pages will rely on.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  scanOrders,
  scans,
  auth,
  deepInquiries,
  ApiError,
  type ScanOrder,
  type ScanSummary,
  type CreateDeepInquiryBody,
} from "./api-client.ts";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let originalFetch: typeof globalThis.fetch;
let calls: FetchCall[];

function installFetchStub(handler: (url: string, init: RequestInit) => Response): void {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const reqInit = init ?? {};
    calls.push({ url, init: reqInit });
    return Promise.resolve(handler(url, reqInit));
  }) as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("scanOrders client", () => {
  test("list — GET /v1/scan-orders returns typed array", async () => {
    const fixture: ScanOrder[] = [
      {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        status: "draft",
        tier: "quick",
        primary_domain: "example.com",
        attack_surface: [],
        safety_rps: 10,
        payment_kind: "free_quick",
        created_at: 1700000000,
        updated_at: 1700000000,
      },
    ];
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await scanOrders.list();

    expect(result).toEqual(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/v1/scan-orders");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  test("create — POST /v1/scan-orders sends JSON body and parses 201", async () => {
    const fixture: ScanOrder = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "draft",
      tier: "quick",
      primary_domain: "acme.test",
      attack_surface: [],
      safety_rps: 10,
      payment_kind: "free_quick",
      created_at: 1700000000,
      updated_at: 1700000000,
    };
    installFetchStub(() => jsonResponse(201, fixture));

    const result = await scanOrders.create({
      tier: "quick",
      primary_domain: "acme.test",
    });

    expect(result).toEqual(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/v1/scan-orders");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ tier: "quick", primary_domain: "acme.test" }),
    );
  });

  test("updateAttackSurface — PUT carries body to the right sub-path", async () => {
    const fixture: ScanOrder = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "draft",
      tier: "quick",
      primary_domain: "acme.test",
      attack_surface: [
        { domain: "acme.test", primary: true, headers: [] },
      ],
      safety_rps: 10,
      payment_kind: "free_quick",
      created_at: 1700000000,
      updated_at: 1700000001,
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await scanOrders.updateAttackSurface(
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      { attack_surface: [{ domain: "acme.test", primary: true, headers: [] }] },
    );

    expect(result.attack_surface).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/v1/scan-orders/01ARZ3NDEKTSV4RRFFQ69G5FAV/attack-surface",
    );
    expect(calls[0]?.init.method).toBe("PUT");
  });

  test("cancel — DELETE /v1/scan-orders/:id returns updated order", async () => {
    const fixture: ScanOrder = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "cancelled",
      tier: "quick",
      primary_domain: "acme.test",
      attack_surface: [],
      safety_rps: 10,
      payment_kind: "free_quick",
      created_at: 1700000000,
      updated_at: 1700000002,
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await scanOrders.cancel("01ARZ3NDEKTSV4RRFFQ69G5FAV");

    expect(result.status).toBe("cancelled");
    expect(calls[0]?.url).toBe(
      "/v1/scan-orders/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("launch — POST returns scan_id without body", async () => {
    installFetchStub(() =>
      jsonResponse(202, { scan_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX" }),
    );

    const result = await scanOrders.launch("01ARZ3NDEKTSV4RRFFQ69G5FAV");

    expect(result.scan_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAX");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBeUndefined();
    // No content-type header when there's no body.
    expect(calls[0]?.init.headers).toBeUndefined();
  });
});

describe("scans client", () => {
  test("get — typed ScanSummary", async () => {
    const fixture: ScanSummary = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      scan_order_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      profile: "recon",
      status: "running",
      started_at: 1700000100,
      completed_at: null,
      usage_tokens: null,
      usage_usd_cents: null,
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await scans.get("01ARZ3NDEKTSV4RRFFQ69G5FAX");

    expect(result).toEqual(fixture);
    expect(calls[0]?.url).toBe("/v1/scans/01ARZ3NDEKTSV4RRFFQ69G5FAX");
  });

  test("getEvents — encodes `since` query param", async () => {
    installFetchStub(() => jsonResponse(200, []));

    await scans.getEvents("01ARZ3NDEKTSV4RRFFQ69G5FAX", 1700000050);

    expect(calls[0]?.url).toBe(
      "/v1/scans/01ARZ3NDEKTSV4RRFFQ69G5FAX/events?since=1700000050",
    );
  });
});

describe("error handling", () => {
  test("404 with Error envelope throws ApiError with code+message", async () => {
    installFetchStub(() =>
      jsonResponse(404, { error: "not_found", message: "scan not found" }),
    );

    let caught: unknown;
    try {
      await scans.get("01ARZ3NDEKTSV4RRFFQ69G5FAX");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("scan not found");
  });

  test("422 validation error carries `details` array through", async () => {
    installFetchStub(() =>
      jsonResponse(422, {
        error: "validation_error",
        message: "request body failed schema validation",
        details: [{ path: "primary_domain", code: "invalid_string" }],
      }),
    );

    let caught: unknown;
    try {
      await scanOrders.create({
        tier: "quick",
        primary_domain: "not a domain",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(422);
    expect(err.code).toBe("validation_error");
    expect(Array.isArray(err.details)).toBe(true);
  });

  test("network failure throws ApiError(0, network_error)", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await scanOrders.list();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(0);
    expect(err.code).toBe("network_error");
  });
});

// ─── T106 — US2 deep-inquiry + auth/me coverage ─────────────────────────────

describe("auth.me client", () => {
  test("200 returns typed AuthMe object", async () => {
    installFetchStub(() =>
      jsonResponse(200, {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "ops@acme.test",
        free_quick_available: true,
      }),
    );

    const result = await auth.me();

    expect(result).not.toBeNull();
    expect(result?.email).toBe("ops@acme.test");
    expect(calls[0]?.url).toBe("/v1/auth/me");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  test("401 (anonymous caller) is mapped to null", async () => {
    installFetchStub(() =>
      jsonResponse(401, { error: "unauthenticated" }),
    );

    const result = await auth.me();

    expect(result).toBeNull();
  });

  test("5xx still throws ApiError (not mapped)", async () => {
    installFetchStub(() =>
      jsonResponse(500, { error: "internal_error", message: "boom" }),
    );

    let caught: unknown;
    try {
      await auth.me();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
  });
});

describe("deepInquiries client", () => {
  const validBody: CreateDeepInquiryBody = {
    company: "Acme",
    contact_name: "Alex",
    phone: "+79991234567",
    domains_text: "acme.test",
    scope_text: "External perimeter, no DoS.",
    consent_accepted: true,
  };

  test("create — POST /v1/deep-inquiries sends JSON body and parses 201", async () => {
    installFetchStub(() =>
      jsonResponse(201, { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    );

    const result = await deepInquiries.create(validBody);

    expect(result.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(calls[0]?.url).toBe("/v1/deep-inquiries");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify(validBody));
  });

  test("create — 422 surfaces details for field-level errors", async () => {
    installFetchStub(() =>
      jsonResponse(422, {
        error: "validation_error",
        message: "request body failed schema validation",
        details: [{ path: "company", code: "too_small" }],
      }),
    );

    let caught: unknown;
    try {
      await deepInquiries.create(validBody);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(422);
    expect(err.code).toBe("validation_error");
    expect(Array.isArray(err.details)).toBe(true);
  });
});
