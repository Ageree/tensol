export type ReviewMode = "fast" | "deep";

export interface StartWhiteboxArgs {
  readonly repo_id?: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly mode?: ReviewMode;
}

export interface SthripAgentClient {
  health(): Promise<unknown>;
  listReviews(): Promise<unknown>;
  getReview(reviewId: string): Promise<unknown>;
  listFindings(reviewId: string): Promise<unknown>;
  startWhitebox(args: StartWhiteboxArgs): Promise<unknown>;
  getJob(jobId: string): Promise<unknown>;
}

export interface CreateHttpSthripAgentClientOptions {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly fetchImpl?: typeof fetch;
}

export class AgentApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    this.body = body;
  }
}

function normalizeApiBaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1/agent")
    ? pathname || "/v1/agent"
    : `${pathname || ""}/v1/agent`;
  return url.toString().replace(/\/$/, "");
}

async function parseApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof (payload as { message?: unknown }).message === "string"
  ) {
    return (payload as { message: string }).message;
  }
  return fallback;
}

async function requestAgentApi(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await parseApiResponse(response);
  if (!response.ok) {
    const fallback = `Sthrip agent API request failed with status ${response.status}`;
    throw new AgentApiError(errorMessage(payload, fallback), response.status, payload);
  }
  return payload;
}

export function createHttpSthripAgentClient(
  options: CreateHttpSthripAgentClientOptions,
): SthripAgentClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeApiBaseUrl(options.apiUrl);
  const token = options.apiToken;

  return {
    health: () => requestAgentApi(fetchImpl, baseUrl, token, "GET", "/health"),
    listReviews: () => requestAgentApi(fetchImpl, baseUrl, token, "GET", "/reviews"),
    getReview: (reviewId) =>
      requestAgentApi(
        fetchImpl,
        baseUrl,
        token,
        "GET",
        `/reviews/${encodeURIComponent(reviewId)}`,
      ),
    listFindings: (reviewId) =>
      requestAgentApi(
        fetchImpl,
        baseUrl,
        token,
        "GET",
        `/reviews/${encodeURIComponent(reviewId)}/findings`,
      ),
    startWhitebox: (args) =>
      requestAgentApi(fetchImpl, baseUrl, token, "POST", "/whitebox", args),
    getJob: (jobId) =>
      requestAgentApi(
        fetchImpl,
        baseUrl,
        token,
        "GET",
        `/jobs/${encodeURIComponent(jobId)}`,
      ),
  };
}

export function createHttpSthripAgentClientFromEnv(
  options: Pick<CreateHttpSthripAgentClientOptions, "fetchImpl"> = {},
): SthripAgentClient {
  const apiUrl = process.env.STHRIP_API_URL?.trim();
  const apiToken = process.env.STHRIP_API_TOKEN?.trim();
  if (!apiUrl) throw new Error("STHRIP_API_URL is required");
  if (!apiToken) throw new Error("STHRIP_API_TOKEN is required");
  return createHttpSthripAgentClient({
    apiUrl,
    apiToken,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}
