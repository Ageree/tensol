/**
 * Tests for `github/client.ts`.
 *
 * Two implementations of `GitHubClient`:
 *   - `FakeGitHubClient` — records every call into public arrays and returns
 *     deterministic ids; the PR file list is configurable via the constructor.
 *     Used by upstream orchestration tests as a seam.
 *   - `createHttpGitHubClient` — real client over the GitHub REST + GraphQL
 *     API. Here we drive it with a fake `fetch` and a fake `tokenProvider`,
 *     asserting that each method hits the correct endpoint/method/body.
 *
 * Determinism: no real network, no real keys, no clock. A fake `tokenProvider`
 * replaces JWT-based token minting so `buildAppJwt` is never exercised over
 * the wire.
 */
import { describe, expect, test } from "bun:test";

import type { DiffFile } from "../types.ts";
import { FakeGitHubClient, createHttpGitHubClient } from "./client.ts";

// ───────────────────────────────────────────────────────────────────────────
// FakeGitHubClient
// ───────────────────────────────────────────────────────────────────────────

describe("FakeGitHubClient", () => {
  const sampleFiles: DiffFile[] = [
    { path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@" },
    { path: "src/b.ts", status: "added", patch: "@@ -0,0 +1 @@" },
  ];

  test("getPullRequestFiles returns the configured file list", async () => {
    const c = new FakeGitHubClient({ files: sampleFiles });
    const files = await c.getPullRequestFiles({ owner: "o", name: "n", pr: 1 });
    expect(files).toEqual(sampleFiles);
    expect(c.getFilesCalls).toHaveLength(1);
    expect(c.getFilesCalls[0]).toEqual({ owner: "o", name: "n", pr: 1 });
  });

  test("getFileContents returns configured contents or null", async () => {
    const c = new FakeGitHubClient({
      fileContents: { "src/a.ts": "console.log(1)" },
    });
    const present = await c.getFileContents({
      owner: "o",
      name: "n",
      path: "src/a.ts",
      ref: "main",
    });
    const absent = await c.getFileContents({
      owner: "o",
      name: "n",
      path: "nope.ts",
      ref: "main",
    });
    expect(present).toBe("console.log(1)");
    expect(absent).toBeNull();
  });

  test("postReview records the batched call and returns a deterministic id", async () => {
    const c = new FakeGitHubClient();
    const res = await c.postReview({
      owner: "o",
      name: "n",
      pr: 5,
      body: "summary",
      event: "REQUEST_CHANGES",
      comments: [
        { path: "src/a.ts", line: 10, side: "RIGHT", body: "bug here" },
        { path: "src/b.ts", line: 2, body: "and here" },
      ],
    });
    expect(res.reviewId).toBe("fake-review-1");
    expect(c.postReviewCalls).toHaveLength(1);
    // All comments are batched into the single review call.
    expect(c.postReviewCalls[0]!.comments).toHaveLength(2);
    expect(c.postReviewCalls[0]!.event).toBe("REQUEST_CHANGES");
  });

  test("postReview ids increment across calls", async () => {
    const c = new FakeGitHubClient();
    const r1 = await c.postReview({
      owner: "o",
      name: "n",
      pr: 1,
      body: "",
      event: "COMMENT",
      comments: [],
    });
    const r2 = await c.postReview({
      owner: "o",
      name: "n",
      pr: 1,
      body: "",
      event: "COMMENT",
      comments: [],
    });
    expect(r1.reviewId).toBe("fake-review-1");
    expect(r2.reviewId).toBe("fake-review-2");
  });

  test("createCheckRun records the call and returns a deterministic id", async () => {
    const c = new FakeGitHubClient();
    const res = await c.createCheckRun({
      owner: "o",
      name: "n",
      headSha: "abc",
      conclusion: "failure",
      title: "t",
      summary: "s",
    });
    expect(res.checkRunId).toBe("fake-check-1");
    expect(c.createCheckRunCalls[0]!.conclusion).toBe("failure");
    expect(c.createCheckRunCalls[0]!.headSha).toBe("abc");
  });

  test("resolveReviewThread records the thread id", async () => {
    const c = new FakeGitHubClient();
    await c.resolveReviewThread({ threadId: "T_kwthread" });
    expect(c.resolveThreadCalls).toEqual([{ threadId: "T_kwthread" }]);
  });

  test("listUserInstallationIds returns ids for the OAuth code and records the call", async () => {
    const c = new FakeGitHubClient({
      userInstallationIds: { code_owned: ["123", "456"] },
    });
    await expect(c.listUserInstallationIds({ code: "code_owned" })).resolves.toEqual([
      "123",
      "456",
    ]);
    await expect(c.listUserInstallationIds({ code: "unknown" })).resolves.toEqual([]);
    expect(c.listUserInstallationIdsCalls).toEqual([
      { code: "code_owned" },
      { code: "unknown" },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createHttpGitHubClient — fake fetch + fake tokenProvider
// ───────────────────────────────────────────────────────────────────────────

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function makeFetch(routes: (rec: Recorded) => { status?: number; json?: unknown }) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const rec: Recorded = { url, method, headers, body };
    calls.push(rec);
    const { status = 200, json = {} } = routes(rec);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----";
const tokenProvider = async () => "ghs_installation_token_fake";

describe("createHttpGitHubClient — getPullRequestFiles", () => {
  test("GETs the pulls/files endpoint and maps to DiffFile", async () => {
    const page1 = [
      { filename: "src/a.ts", status: "modified", patch: "@@a" },
      {
        filename: "src/new.ts",
        status: "renamed",
        previous_filename: "src/old.ts",
        patch: "@@b",
      },
    ];
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/pulls/12/files")) {
        // Single page: second page is empty → pagination stops.
        return rec.url.includes("page=2") ? { json: [] } : { json: page1 };
      }
      return { json: {} };
    });

    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    const files = await c.getPullRequestFiles({
      owner: "acme",
      name: "widgets",
      pr: 12,
      installationId: "42",
    });

    const first = calls[0]!;
    expect(first.method).toBe("GET");
    expect(first.url).toContain("https://api.github.com/repos/acme/widgets/pulls/12/files");
    expect(first.headers.authorization).toBe("Bearer ghs_installation_token_fake");

    expect(files).toEqual([
      { path: "src/a.ts", status: "modified", patch: "@@a" },
      {
        path: "src/new.ts",
        status: "renamed",
        patch: "@@b",
        previousPath: "src/old.ts",
      },
    ]);
  });
});

describe("createHttpGitHubClient — getFileContents", () => {
  test("GETs the contents endpoint and decodes base64", async () => {
    const encoded = Buffer.from("hello world", "utf8").toString("base64");
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/contents/")) {
        return { json: { content: encoded, encoding: "base64" } };
      }
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    const out = await c.getFileContents({
      owner: "acme",
      name: "widgets",
      path: "src/a.ts",
      ref: "deadbeef",
      installationId: "42",
    });
    expect(out).toBe("hello world");
    expect(calls[0]!.url).toContain("/repos/acme/widgets/contents/src/a.ts");
    expect(calls[0]!.url).toContain("ref=deadbeef");
  });

  test("returns null on 404", async () => {
    const { impl } = makeFetch(() => ({ status: 404, json: { message: "Not Found" } }));
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    const out = await c.getFileContents({
      owner: "acme",
      name: "widgets",
      path: "missing.ts",
      ref: "x",
      installationId: "42",
    });
    expect(out).toBeNull();
  });
});

describe("createHttpGitHubClient — postReview", () => {
  test("POSTs one batched review with comments[]", async () => {
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/pulls/7/reviews")) return { json: { id: 9911 } };
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    const res = await c.postReview({
      owner: "acme",
      name: "widgets",
      pr: 7,
      body: "Found issues",
      event: "REQUEST_CHANGES",
      comments: [
        { path: "src/a.ts", line: 4, side: "RIGHT", body: "x" },
        { path: "src/b.ts", line: 1, body: "y" },
      ],
      installationId: "42",
    });

    expect(res.reviewId).toBe("9911");
    const call = calls.find((c2) => c2.url.includes("/reviews"))!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/reviews");
    const body = call.body as {
      body: string;
      event: string;
      comments: Array<{ path: string; line: number; side?: string; body: string }>;
    };
    expect(body.body).toBe("Found issues");
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0]).toEqual({ path: "src/a.ts", line: 4, side: "RIGHT", body: "x" });
    // Comment without an explicit side omits it (GitHub defaults to RIGHT).
    expect(body.comments[1]!.side).toBeUndefined();
  });
});

describe("createHttpGitHubClient — createCheckRun", () => {
  test("POSTs the check-runs endpoint with conclusion + output", async () => {
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/check-runs")) return { json: { id: 5577 } };
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    const res = await c.createCheckRun({
      owner: "acme",
      name: "widgets",
      headSha: "cafebabe",
      conclusion: "failure",
      title: "Sthrip Review",
      summary: "2 findings",
      installationId: "42",
    });
    expect(res.checkRunId).toBe("5577");
    const call = calls.find((c2) => c2.url.includes("/check-runs"))!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/check-runs");
    const body = call.body as {
      head_sha: string;
      status: string;
      conclusion: string;
      output: { title: string; summary: string };
    };
    expect(body.head_sha).toBe("cafebabe");
    expect(body.status).toBe("completed");
    expect(body.conclusion).toBe("failure");
    expect(body.output.title).toBe("Sthrip Review");
    expect(body.output.summary).toBe("2 findings");
  });
});

describe("createHttpGitHubClient — resolveReviewThread", () => {
  test("POSTs a GraphQL resolveReviewThread mutation", async () => {
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/graphql")) {
        return { json: { data: { resolveReviewThread: { thread: { id: "T_x" } } } } };
      }
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    await c.resolveReviewThread({ threadId: "T_x", installationId: "42" });
    const call = calls.find((c2) => c2.url.includes("/graphql"))!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.github.com/graphql");
    const body = call.body as { query: string; variables: { threadId: string } };
    expect(body.query).toContain("resolveReviewThread");
    expect(body.variables.threadId).toBe("T_x");
  });
});

describe("FakeGitHubClient — listInstallationRepos", () => {
  test("returns canned repos and records the call", async () => {
    const cannedRepos = [
      { owner: "acme", name: "widgets", defaultBranch: "main" },
      { owner: "acme", name: "backend", defaultBranch: "master", repoId: "R_123" },
    ];
    const c = new FakeGitHubClient({ installationRepos: cannedRepos });
    const result = await c.listInstallationRepos({ installationId: "42" });
    expect(result).toEqual(cannedRepos);
    expect(c.listInstallationReposCalls).toHaveLength(1);
    expect(c.listInstallationReposCalls[0]).toEqual({ installationId: "42" });
  });

  test("returns empty array when no repos configured", async () => {
    const c = new FakeGitHubClient();
    const result = await c.listInstallationRepos({ installationId: "99" });
    expect(result).toEqual([]);
    expect(c.listInstallationReposCalls).toHaveLength(1);
  });
});

describe("createHttpGitHubClient — listInstallationRepos", () => {
  /** Build a full page of 100 dummy repo entries (names repo-0 … repo-99). */
  function makeFullPage(startId: number) {
    return Array.from({ length: 100 }, (_, i) => ({
      owner: { login: "acme" },
      name: `repo-${startId + i}`,
      default_branch: "main",
      id: startId + i,
    }));
  }

  test("GETs /installation/repositories with pagination and maps repos", async () => {
    // page1 has 100 repos (full) → triggers page 2 request.
    // page2 has 1 repo (partial) → pagination stops.
    const page1Repos = makeFullPage(0);
    const page2Repos = [
      { owner: { login: "acme" }, name: "frontend", default_branch: "develop", id: 9999 },
    ];

    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/installation/repositories")) {
        if (rec.url.includes("page=2")) return { json: { total_count: 101, repositories: page2Repos } };
        return { json: { total_count: 101, repositories: page1Repos } };
      }
      return { json: {} };
    });

    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });

    const repos = await c.listInstallationRepos({ installationId: "42" });

    // Should have 101 repos total (100 from page1 + 1 from page2).
    expect(repos).toHaveLength(101);
    // First repo from page 1.
    expect(repos[0]).toEqual({ owner: "acme", name: "repo-0", defaultBranch: "main", repoId: "0" });
    // Last repo from page 2.
    expect(repos[100]).toEqual({ owner: "acme", name: "frontend", defaultBranch: "develop", repoId: "9999" });

    const repoCall = calls[0]!;
    expect(repoCall.method).toBe("GET");
    expect(repoCall.url).toContain("https://api.github.com/installation/repositories");
    expect(repoCall.headers.authorization).toBe("Bearer ghs_installation_token_fake");
    // Two pages were fetched.
    expect(calls.length).toBe(2);
  });

  test("returns empty array when no repositories exist", async () => {
    const { impl } = makeFetch(() => ({
      json: { total_count: 0, repositories: [] },
    }));

    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });

    const repos = await c.listInstallationRepos({ installationId: "42" });
    expect(repos).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    const { impl } = makeFetch(() => ({ status: 403, json: { message: "Forbidden" } }));

    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });

    await expect(c.listInstallationRepos({ installationId: "42" })).rejects.toThrow(
      "GitHub: listInstallationRepos failed (403)",
    );
  });
});

describe("createHttpGitHubClient — listUserInstallationIds", () => {
  function makeInstallationsPage(ids: Array<number | string>) {
    return ids.map((id) => ({ id }));
  }

  test("exchanges OAuth code for a user token and paginates /user/installations", async () => {
    const fullPage = makeInstallationsPage(Array.from({ length: 100 }, (_, i) => i + 1));
    const tailPage = makeInstallationsPage(["tail-101"]);
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url === "https://github.com/login/oauth/access_token") {
        return { json: { access_token: "ghu_user_token", token_type: "bearer" } };
      }
      if (rec.url.includes("/user/installations")) {
        if (rec.url.includes("page=2")) {
          return { json: { installations: tailPage } };
        }
        return { json: { installations: fullPage } };
      }
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
      clientId: "Iv1.client",
      clientSecret: "secret",
    });

    const ids = await c.listUserInstallationIds({ code: "oauth-code" });

    expect(ids).toHaveLength(101);
    expect(ids[0]).toBe("1");
    expect(ids[100]).toBe("tail-101");

    const tokenCall = calls[0];
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.url).toBe("https://github.com/login/oauth/access_token");
    expect(tokenCall?.headers.accept).toBe("application/json");
    expect(tokenCall?.body).toEqual({
      client_id: "Iv1.client",
      client_secret: "secret",
      code: "oauth-code",
    });

    const installationCalls = calls.filter((call) => call.url.includes("/user/installations"));
    expect(installationCalls).toHaveLength(2);
    expect(installationCalls[0]?.headers.authorization).toBe("Bearer ghu_user_token");
    expect(installationCalls[0]?.url).toContain("per_page=100");
    expect(installationCalls[0]?.url).toContain("page=1");
    expect(installationCalls[1]?.url).toContain("page=2");
  });

  test("throws when OAuth client credentials are missing", async () => {
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: makeFetch(() => ({ json: {} })).impl,
      tokenProvider,
    });

    await expect(c.listUserInstallationIds({ code: "oauth-code" })).rejects.toThrow(
      "GitHub: OAuth client_id/client_secret not configured",
    );
  });

  test("throws when GitHub returns no user access token", async () => {
    const { impl } = makeFetch((rec) => {
      if (rec.url === "https://github.com/login/oauth/access_token") {
        return { json: { error: "bad_verification_code" } };
      }
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
      clientId: "Iv1.client",
      clientSecret: "secret",
    });

    await expect(c.listUserInstallationIds({ code: "bad-code" })).rejects.toThrow(
      "GitHub: OAuth code exchange returned no access_token (bad_verification_code)",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FakeGitHubClient — getPullRequest (T040)
// ───────────────────────────────────────────────────────────────────────────

describe("FakeGitHubClient — getPullRequest", () => {
  test("returns default canned PR info when not seeded", async () => {
    const c = new FakeGitHubClient();
    const info = await c.getPullRequest({ owner: "o", name: "n", pr: 7 });
    expect(info.headSha).toBe("fake-head-sha");
    expect(info.baseSha).toBe("fake-base-sha");
    expect(info.baseRef).toBe("main");
    expect(c.getPullRequestCalls).toHaveLength(1);
    expect(c.getPullRequestCalls[0]).toEqual({ owner: "o", name: "n", pr: 7 });
  });

  test("returns seeded PR info", async () => {
    const c = new FakeGitHubClient({
      pullRequestInfo: { headSha: "abc123", baseSha: "def456", baseRef: "develop" },
    });
    const info = await c.getPullRequest({ owner: "o", name: "n", pr: 3, installationId: "42" });
    expect(info.headSha).toBe("abc123");
    expect(info.baseRef).toBe("develop");
    expect(c.getPullRequestCalls[0]).toEqual({ owner: "o", name: "n", pr: 3, installationId: "42" });
  });
});

describe("createHttpGitHubClient — getPullRequest", () => {
  test("GETs /pulls/{pr} and maps headSha/baseSha/baseRef", async () => {
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/pulls/5") && !rec.url.includes("/files") && !rec.url.includes("/reviews") && !rec.url.includes("/comments")) {
        return {
          json: {
            head: { sha: "head-sha-xyz" },
            base: { sha: "base-sha-abc", ref: "main" },
          },
        };
      }
      return { json: {} };
    });
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    const info = await c.getPullRequest({
      owner: "acme",
      name: "widgets",
      pr: 5,
      installationId: "42",
    });
    expect(info.headSha).toBe("head-sha-xyz");
    expect(info.baseSha).toBe("base-sha-abc");
    expect(info.baseRef).toBe("main");
    const call = calls.find((c2) => c2.url.includes("/pulls/5") && !c2.url.includes("files"))!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/pulls/5");
    expect(call.headers.authorization).toBe("Bearer ghs_installation_token_fake");
  });

  test("throws on non-OK response", async () => {
    const { impl } = makeFetch(() => ({ status: 404, json: { message: "Not Found" } }));
    const c = createHttpGitHubClient({
      appId: "1",
      privateKeyPem: FAKE_PEM,
      fetchImpl: impl,
      tokenProvider,
    });
    await expect(
      c.getPullRequest({ owner: "o", name: "n", pr: 99, installationId: "42" }),
    ).rejects.toThrow("GitHub: getPullRequest failed (404)");
  });
});

describe("createHttpGitHubClient — token minting fallback", () => {
  test("without a tokenProvider, mints an installation token via /access_tokens", async () => {
    const { impl, calls } = makeFetch((rec) => {
      if (rec.url.includes("/access_tokens")) {
        return { status: 201, json: { token: "ghs_minted_token", expires_at: "x" } };
      }
      if (rec.url.includes("/pulls/3/files")) {
        return rec.url.includes("page=2") ? { json: [] } : { json: [] };
      }
      return { json: {} };
    });
    // No tokenProvider → real JWT path. Use a generated RSA key so buildAppJwt works.
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const c = createHttpGitHubClient({
      appId: "999",
      privateKeyPem: privateKey as string,
      fetchImpl: impl,
    });
    await c.getPullRequestFiles({ owner: "o", name: "n", pr: 3, installationId: "77" });

    const mint = calls.find((c2) => c2.url.includes("/access_tokens"))!;
    expect(mint.method).toBe("POST");
    expect(mint.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    // JWT (not installation token) authenticates the mint request.
    expect(mint.headers.authorization).toMatch(/^Bearer eyJ/);

    const filesCall = calls.find((c2) => c2.url.includes("/pulls/3/files"))!;
    expect(filesCall.headers.authorization).toBe("Bearer ghs_minted_token");
  });

  test("caches the minted token across calls (one mint for two requests)", async () => {
    let mintCount = 0;
    const { impl } = makeFetch((rec) => {
      if (rec.url.includes("/access_tokens")) {
        mintCount += 1;
        return { status: 201, json: { token: "ghs_cached", expires_at: "x" } };
      }
      return { json: [] };
    });
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const c = createHttpGitHubClient({
      appId: "999",
      privateKeyPem: privateKey as string,
      fetchImpl: impl,
    });
    await c.getPullRequestFiles({ owner: "o", name: "n", pr: 1, installationId: "77" });
    await c.getPullRequestFiles({ owner: "o", name: "n", pr: 2, installationId: "77" });
    expect(mintCount).toBe(1);
  });
});
