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
  github,
  review,
  agentTokens,
  ApiError,
  type ScanOrder,
  type ScanSummary,
  type CreateDeepInquiryBody,
  type ConnectUrl,
  type InstallationsResponse,
  type InstallationRepo,
  type ReviewListItemWire,
  type ReviewResultWire,
  type AgentTokenCreateResult,
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

  test("list — non-JSON 200 throws parse_error instead of returning undefined", async () => {
    installFetchStub(() =>
      new Response("<!doctype html><title>Vite fallback</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    let caught: unknown;
    try {
      await scanOrders.list();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(200);
    expect(err.code).toBe("parse_error");
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

// ─── T020 — GitHub connect / installations namespace ────────────────────────

describe("github.connect", () => {
  test("returns install_url and state via GET /v1/github/connect", async () => {
    const fixture: ConnectUrl = {
      install_url: "https://github.com/apps/sthrip/installations/new?state=abc",
      state: "abc",
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await github.connect();

    expect(result).toEqual(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/v1/github/connect");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  test("401 surfaces as ApiError", async () => {
    installFetchStub(() =>
      jsonResponse(401, { error: "unauthenticated", message: "not logged in" }),
    );

    let caught: unknown;
    try {
      await github.connect();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(401);
    expect((caught as ApiError).code).toBe("unauthenticated");
  });
});

describe("github.installations", () => {
  test("returns connected + installations array via GET /v1/github/installations", async () => {
    const fixture: InstallationsResponse = {
      connected: true,
      installations: [
        {
          id: "01INST000000000000000000001",
          account_login: "acmecorp",
          account_type: "Organization",
          repository_selection: "selected",
          status: "active",
        },
      ],
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await github.installations();

    expect(result).toEqual(fixture);
    expect(calls[0]?.url).toBe("/v1/github/installations");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("returns connected:false with empty array when not connected", async () => {
    const fixture: InstallationsResponse = { connected: false, installations: [] };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await github.installations();

    expect(result.connected).toBe(false);
    expect(result.installations).toHaveLength(0);
  });
});

describe("github.installationRepos", () => {
  test("returns InstallationRepo[] via GET /v1/github/installations/{id}/repos", async () => {
    const fixture: InstallationRepo[] = [
      {
        owner: "acmecorp",
        name: "backend",
        default_branch: "main",
        enabled: true,
      },
    ];
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await github.installationRepos("01INST000000000000000000001");

    expect(result).toEqual(fixture);
    expect(calls[0]?.url).toBe(
      "/v1/github/installations/01INST000000000000000000001/repos",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("404 when installation not owned by user throws ApiError", async () => {
    installFetchStub(() =>
      jsonResponse(404, { error: "not_found", message: "installation not found" }),
    );

    let caught: unknown;
    try {
      await github.installationRepos("bogus-id");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).code).toBe("not_found");
  });
});

describe("github.updateRepoSettings", () => {
  test("PATCH /v1/review/repos/{id}/settings sends body and returns InstallationRepo", async () => {
    const fixture: InstallationRepo = {
      owner: "acmecorp",
      name: "backend",
      default_branch: "main",
      enabled: false,
      status_check_enabled: true,
      merge_block_on_critical: false,
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const body = { enabled: false };
    const result = await github.updateRepoSettings("01REPO00000000000000000001", body);

    expect(result).toEqual(fixture);
    expect(calls[0]?.url).toBe(
      "/v1/review/repos/01REPO00000000000000000001/settings",
    );
    expect(calls[0]?.init.method).toBe("PATCH");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify(body));
  });

  test("403 when repo not owned by user throws ApiError", async () => {
    installFetchStub(() =>
      jsonResponse(403, { error: "forbidden", message: "not your repo" }),
    );

    let caught: unknown;
    try {
      await github.updateRepoSettings("bogus", { enabled: true });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
    expect((caught as ApiError).code).toBe("forbidden");
  });
});

describe("github.disconnect", () => {
  test("POST /v1/github/disconnect sends installation_id in body", async () => {
    installFetchStub(() =>
      new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
    );

    // Returns undefined (empty 200 body) — no throw expected
    installFetchStub(() => jsonResponse(200, {}));
    await github.disconnect("01INST000000000000000000001");

    expect(calls[0]?.url).toBe("/v1/github/disconnect");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ installation_id: "01INST000000000000000000001" }),
    );
  });

  test("403 when installation not owned throws ApiError", async () => {
    installFetchStub(() =>
      jsonResponse(403, { error: "forbidden", message: "not your installation" }),
    );

    let caught: unknown;
    try {
      await github.disconnect("bogus");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
  });
});

describe("review client", () => {
  test("list — GET /v1/review preserves mode and findings_count", async () => {
    const fixture: ReviewListItemWire[] = [
      {
        review_id: "01REV000000000000000000001",
        kind: "whitebox",
        mode: "deep",
        status: "completed",
        score_0_5: 4,
        repo: "acme/api",
        findings_count: 2,
      },
    ];
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await review.list();

    expect(result).toEqual(fixture);
    expect(calls[0]?.url).toBe("/v1/review");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("get — GET /v1/review/:id preserves verification and exploit fields", async () => {
    const fixture: ReviewResultWire = {
      review_id: "01REV000000000000000000001",
      kind: "whitebox",
      mode: "fast",
      status: "completed",
      score_0_5: 3,
      summary_md: "summary",
      findings: [
        {
          fingerprint: "fp1",
          file_path: "src/auth.ts",
          side: "RIGHT",
          severity: "high",
          cwe: ["CWE-287"],
          confidence: "high",
          reachable: true,
          title: "Auth bypass",
          rationale_md: "reachable",
          source: "llm",
          verification_status: "verified",
          reachability_evidence_md: "taint path",
          exploit_status: "proven",
          exploitability_score: 80,
          impact_score: 90,
          exploit_iterations: 2,
        },
      ],
    };
    installFetchStub(() => jsonResponse(200, fixture));

    const result = await review.get("01REV000000000000000000001");

    expect(result.mode).toBe("fast");
    expect(result.findings[0]!.verification_status).toBe("verified");
    expect(result.findings[0]!.reachability_evidence_md).toBe("taint path");
    expect(result.findings[0]!.exploit_status).toBe("proven");
    expect(calls[0]?.url).toBe("/v1/review/01REV000000000000000000001");
  });

  test("listRepos — GET /v1/review/repos", async () => {
    installFetchStub(() => jsonResponse(200, []));

    const result = await review.listRepos();

    expect(result).toEqual([]);
    expect(calls[0]?.url).toBe("/v1/review/repos");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("launchWhitebox — POST /v1/review/whitebox sends mode", async () => {
    installFetchStub(() =>
      jsonResponse(202, {
        review_id: "01REV000000000000000000001",
        job_id: "01JOB000000000000000000001",
        status: "queued",
      }),
    );

    const result = await review.launchWhitebox({
      repo_id: "01REPO00000000000000000001",
      mode: "deep",
    });

    expect(result.review_id).toBe("01REV000000000000000000001");
    expect(calls[0]?.url).toBe("/v1/review/whitebox");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ repo_id: "01REPO00000000000000000001", mode: "deep" }),
    );
  });
});

describe("agentTokens client", () => {
  test("create — POST /v1/agent/tokens returns plaintext once plus metadata", async () => {
    const fixture: AgentTokenCreateResult = {
      token: "sthrip_testtoken",
      token_meta: {
        id: "01TOK000000000000000000001",
        name: "Codex",
        token_prefix: "sthrip_testtoken".slice(0, 18),
        created_at: 1700000000,
        last_used_at: null,
        revoked_at: null,
      },
    };
    installFetchStub(() => jsonResponse(201, fixture));

    const result = await agentTokens.create({ name: "Codex" });

    expect(result).toEqual(fixture);
    expect(calls[0]?.url).toBe("/v1/agent/tokens");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "Codex" }));
  });

  test("list and revoke use /v1/agent/tokens", async () => {
    installFetchStub((url) => {
      if (url.endsWith("/01TOK000000000000000000001")) {
        return jsonResponse(200, { revoked: true });
      }
      return jsonResponse(200, { tokens: [] });
    });

    const listed = await agentTokens.list();
    const revoked = await agentTokens.revoke("01TOK000000000000000000001");

    expect(listed.tokens).toEqual([]);
    expect(revoked.revoked).toBe(true);
    expect(calls[0]?.url).toBe("/v1/agent/tokens");
    expect(calls[1]?.url).toBe("/v1/agent/tokens/01TOK000000000000000000001");
    expect(calls[1]?.init.method).toBe("DELETE");
  });
});
