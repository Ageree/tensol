/**
 * 003-whitebox — GitHub API client.
 *
 * The review engine talks to GitHub through the narrow `GitHubClient`
 * interface so the orchestration logic never depends on the HTTP shape. Two
 * implementations ship here:
 *
 *   - `FakeGitHubClient`  — an in-memory test double that records every call
 *     and returns deterministic ids; the PR file list / file contents are
 *     configured via the constructor. Lets upstream tests assert "the engine
 *     posted one batched review with these comments" without any network.
 *
 *   - `createHttpGitHubClient` — the real client over `api.github.com`
 *     (REST + GraphQL via `fetch`). It authenticates as a GitHub App: it mints
 *     short-lived *installation* access tokens (cached per installation) by
 *     calling `POST /app/installations/{id}/access_tokens` with the App JWT
 *     from `./sign.ts`. Both `fetch` and the token minter are injectable so
 *     the wire behaviour is fully testable.
 *
 * Immutability: inputs are never mutated; responses are mapped into fresh
 * `DiffFile` objects. No console logging — failures surface as thrown errors
 * with actionable messages.
 */
import type { DiffFile, DiffSide } from "../types.ts";
import { buildAppJwt } from "./sign.ts";

const GITHUB_API = "https://api.github.com";

/** Default installation-token lifetime we assume before re-minting (GitHub issues 1h; refresh early). */
const TOKEN_TTL_SEC = 50 * 60;

/** Shared headers GitHub's REST API expects. */
const BASE_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "tensol-review",
};

/** A line-level inline comment attached to a batched review. */
export interface ReviewComment {
  path: string;
  line: number;
  side?: DiffSide;
  body: string;
}

/** An existing inline review comment on a PR (only the body is needed: it
 *  carries the hidden `tensol:fp:<id>` marker we dedup on). */
export interface ExistingReviewComment {
  body: string;
}

/** The capabilities the review engine needs from GitHub. */
export interface GitHubClient {
  getPullRequestFiles(a: {
    owner: string;
    name: string;
    pr: number;
    installationId?: string;
  }): Promise<DiffFile[]>;
  /**
   * List the existing inline review comments on a PR. GitHub is the source of
   * truth for what we've already posted: a retry after a successful post (but
   * before the local thread row committed) must NOT re-post, so the poster
   * reconciles fingerprints found in these bodies into `alreadyPosted`.
   */
  listReviewComments(a: {
    owner: string;
    name: string;
    pr: number;
    installationId?: string;
  }): Promise<ExistingReviewComment[]>;
  getFileContents(a: {
    owner: string;
    name: string;
    path: string;
    ref: string;
    installationId?: string;
  }): Promise<string | null>;
  postReview(a: {
    owner: string;
    name: string;
    pr: number;
    body: string;
    event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
    comments: ReviewComment[];
    installationId?: string;
  }): Promise<{ reviewId: string }>;
  createCheckRun(a: {
    owner: string;
    name: string;
    headSha: string;
    conclusion: "success" | "failure" | "neutral" | "action_required";
    title: string;
    summary: string;
    installationId?: string;
  }): Promise<{ checkRunId: string }>;
  resolveReviewThread(a: { threadId: string; installationId?: string }): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// FakeGitHubClient — in-memory test double
// ───────────────────────────────────────────────────────────────────────────

/** Recorded shape of a `getPullRequestFiles` call. */
type GetFilesCall = { owner: string; name: string; pr: number; installationId?: string };
/** Recorded shape of a `listReviewComments` call. */
type ListCommentsCall = { owner: string; name: string; pr: number; installationId?: string };
/** Recorded shape of a `getFileContents` call. */
type GetContentsCall = {
  owner: string;
  name: string;
  path: string;
  ref: string;
  installationId?: string;
};
/** Recorded shape of a `postReview` call. */
type PostReviewCall = {
  owner: string;
  name: string;
  pr: number;
  body: string;
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  comments: ReviewComment[];
  installationId?: string;
};
/** Recorded shape of a `createCheckRun` call. */
type CreateCheckRunCall = {
  owner: string;
  name: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral" | "action_required";
  title: string;
  summary: string;
  installationId?: string;
};
/** Recorded shape of a `resolveReviewThread` call. */
type ResolveThreadCall = { threadId: string; installationId?: string };

/**
 * In-memory `GitHubClient`. All calls are appended to public arrays for
 * assertions; ids are deterministic (`fake-review-1`, `fake-check-1`, …).
 */
export class FakeGitHubClient implements GitHubClient {
  readonly files: DiffFile[];
  readonly fileContents: Record<string, string>;
  /** Pre-seeded existing PR review comments (their bodies may carry markers). */
  readonly existingComments: ExistingReviewComment[];

  readonly getFilesCalls: GetFilesCall[] = [];
  readonly listCommentsCalls: ListCommentsCall[] = [];
  readonly getContentsCalls: GetContentsCall[] = [];
  readonly postReviewCalls: PostReviewCall[] = [];
  readonly createCheckRunCalls: CreateCheckRunCall[] = [];
  readonly resolveThreadCalls: ResolveThreadCall[] = [];

  #reviewSeq = 0;
  #checkSeq = 0;

  constructor(opts?: {
    files?: DiffFile[];
    fileContents?: Record<string, string>;
    existingComments?: ExistingReviewComment[];
  }) {
    this.files = opts?.files ? [...opts.files] : [];
    this.fileContents = opts?.fileContents ? { ...opts.fileContents } : {};
    this.existingComments = opts?.existingComments
      ? opts.existingComments.map((c) => ({ ...c }))
      : [];
  }

  getPullRequestFiles(a: GetFilesCall): Promise<DiffFile[]> {
    this.getFilesCalls.push({ ...a });
    return Promise.resolve(this.files.map((f) => ({ ...f })));
  }

  listReviewComments(a: ListCommentsCall): Promise<ExistingReviewComment[]> {
    this.listCommentsCalls.push({ ...a });
    return Promise.resolve(this.existingComments.map((c) => ({ ...c })));
  }

  getFileContents(a: GetContentsCall): Promise<string | null> {
    this.getContentsCalls.push({ ...a });
    const hit = Object.prototype.hasOwnProperty.call(this.fileContents, a.path);
    return Promise.resolve(hit ? (this.fileContents[a.path] as string) : null);
  }

  postReview(a: PostReviewCall): Promise<{ reviewId: string }> {
    this.postReviewCalls.push({ ...a, comments: a.comments.map((c) => ({ ...c })) });
    this.#reviewSeq += 1;
    return Promise.resolve({ reviewId: `fake-review-${this.#reviewSeq}` });
  }

  createCheckRun(a: CreateCheckRunCall): Promise<{ checkRunId: string }> {
    this.createCheckRunCalls.push({ ...a });
    this.#checkSeq += 1;
    return Promise.resolve({ checkRunId: `fake-check-${this.#checkSeq}` });
  }

  resolveReviewThread(a: ResolveThreadCall): Promise<void> {
    this.resolveThreadCalls.push({ ...a });
    return Promise.resolve();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// createHttpGitHubClient — real REST + GraphQL client
// ───────────────────────────────────────────────────────────────────────────

/** Map a raw GitHub `pulls/files` entry to our `DiffFile` (immutably). */
function mapPullFile(raw: {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
}): DiffFile {
  const status: DiffFile["status"] = (
    ["added", "modified", "removed", "renamed"] as const
  ).includes(raw.status as DiffFile["status"])
    ? (raw.status as DiffFile["status"])
    : "modified";
  return {
    path: raw.filename,
    status,
    ...(raw.patch === undefined ? {} : { patch: raw.patch }),
    ...(raw.previous_filename === undefined ? {} : { previousPath: raw.previous_filename }),
  };
}

/**
 * Create the production GitHub client.
 *
 * @param a.appId         GitHub App id (for JWT `iss`).
 * @param a.privateKeyPem App private key PEM (literal `\n` tolerated).
 * @param a.fetchImpl     Injectable `fetch` (defaults to global).
 * @param a.tokenProvider Injectable installation-token minter; when omitted,
 *                        tokens are minted via the App JWT + REST and cached.
 */
export function createHttpGitHubClient(a: {
  appId: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: (installationId: string) => Promise<string>;
}): GitHubClient {
  const fetchImpl = a.fetchImpl ?? fetch;

  // Installation-token cache: installationId → { token, expiresAtSec }.
  const tokenCache = new Map<string, { token: string; expiresAtSec: number }>();

  /** Mint a fresh installation token using the App JWT. */
  async function mintInstallationToken(installationId: string): Promise<string> {
    const jwt = buildAppJwt({ appId: a.appId, privateKeyPem: a.privateKeyPem });
    const res = await fetchImpl(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...BASE_HEADERS, authorization: `Bearer ${jwt}` },
      },
    );
    if (!res.ok) {
      throw new Error(
        `GitHub: failed to mint installation token (${res.status}) for installation ${installationId}`,
      );
    }
    const json = (await res.json()) as { token?: string };
    if (!json.token) throw new Error("GitHub: access_tokens response missing `token`");
    return json.token;
  }

  /** Resolve a bearer token for the given installation, caching by TTL. */
  async function getToken(installationId: string | undefined): Promise<string> {
    if (!installationId) {
      throw new Error("GitHub: installationId is required to authenticate this request");
    }
    if (a.tokenProvider) return a.tokenProvider(installationId);

    const nowSec = Math.floor(Date.now() / 1000);
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtSec > nowSec) return cached.token;

    const token = await mintInstallationToken(installationId);
    tokenCache.set(installationId, { token, expiresAtSec: nowSec + TOKEN_TTL_SEC });
    return token;
  }

  /** Authenticated REST request returning the parsed JSON (or throwing). */
  async function authed(
    installationId: string | undefined,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await getToken(installationId);
    return fetchImpl(url, {
      ...init,
      headers: { ...BASE_HEADERS, ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
  }

  return {
    async getPullRequestFiles(args): Promise<DiffFile[]> {
      const out: DiffFile[] = [];
      const perPage = 100;
      // Paginate until a short/empty page is returned.
      for (let page = 1; ; page += 1) {
        const url = `${GITHUB_API}/repos/${args.owner}/${args.name}/pulls/${args.pr}/files?per_page=${perPage}&page=${page}`;
        const res = await authed(args.installationId, url, { method: "GET" });
        if (!res.ok) {
          throw new Error(`GitHub: getPullRequestFiles failed (${res.status})`);
        }
        const batch = (await res.json()) as Array<{
          filename: string;
          status: string;
          patch?: string;
          previous_filename?: string;
        }>;
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const raw of batch) out.push(mapPullFile(raw));
        if (batch.length < perPage) break;
      }
      return out;
    },

    async listReviewComments(args): Promise<ExistingReviewComment[]> {
      const out: ExistingReviewComment[] = [];
      const perPage = 100;
      for (let page = 1; ; page += 1) {
        const url = `${GITHUB_API}/repos/${args.owner}/${args.name}/pulls/${args.pr}/comments?per_page=${perPage}&page=${page}`;
        const res = await authed(args.installationId, url, { method: "GET" });
        if (!res.ok) {
          throw new Error(`GitHub: listReviewComments failed (${res.status})`);
        }
        const batch = (await res.json()) as Array<{ body?: string }>;
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const raw of batch) {
          if (typeof raw.body === "string") out.push({ body: raw.body });
        }
        if (batch.length < perPage) break;
      }
      return out;
    },

    async getFileContents(args): Promise<string | null> {
      const url = `${GITHUB_API}/repos/${args.owner}/${args.name}/contents/${args.path}?ref=${encodeURIComponent(
        args.ref,
      )}`;
      const res = await authed(args.installationId, url, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub: getFileContents failed (${res.status})`);
      const json = (await res.json()) as { content?: string; encoding?: string };
      if (!json.content) return null;
      if (json.encoding && json.encoding !== "base64") {
        throw new Error(`GitHub: unexpected contents encoding ${json.encoding}`);
      }
      return Buffer.from(json.content, "base64").toString("utf8");
    },

    async postReview(args): Promise<{ reviewId: string }> {
      const url = `${GITHUB_API}/repos/${args.owner}/${args.name}/pulls/${args.pr}/reviews`;
      // One batched review; omit `side` when not supplied (GitHub defaults RIGHT).
      const comments = args.comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
        ...(c.side === undefined ? {} : { side: c.side }),
      }));
      const res = await authed(args.installationId, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: args.body, event: args.event, comments }),
      });
      if (!res.ok) throw new Error(`GitHub: postReview failed (${res.status})`);
      const json = (await res.json()) as { id?: number | string };
      return { reviewId: String(json.id ?? "") };
    },

    async createCheckRun(args): Promise<{ checkRunId: string }> {
      const url = `${GITHUB_API}/repos/${args.owner}/${args.name}/check-runs`;
      const res = await authed(args.installationId, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: args.title,
          head_sha: args.headSha,
          status: "completed",
          conclusion: args.conclusion,
          output: { title: args.title, summary: args.summary },
        }),
      });
      if (!res.ok) throw new Error(`GitHub: createCheckRun failed (${res.status})`);
      const json = (await res.json()) as { id?: number | string };
      return { checkRunId: String(json.id ?? "") };
    },

    async resolveReviewThread(args): Promise<void> {
      const url = `${GITHUB_API}/graphql`;
      const query =
        "mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id } } }";
      const res = await authed(args.installationId, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { threadId: args.threadId } }),
      });
      if (!res.ok) throw new Error(`GitHub: resolveReviewThread failed (${res.status})`);
      const json = (await res.json()) as { errors?: unknown[] };
      if (json.errors && json.errors.length > 0) {
        throw new Error("GitHub: resolveReviewThread returned GraphQL errors");
      }
    },
  };
}
