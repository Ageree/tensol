import {
  ErrorCode,
  McpError,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import { McpServer } from "skybridge/server";
import { z } from "zod";

import {
  AgentApiError,
  createHttpSthripAgentClient,
  createHttpSthripAgentClientFromEnv,
  type CreateHttpSthripAgentClientOptions,
  type SthripAgentClient,
} from "../agent/client.ts";
import { createJsonLineDecoder } from "./protocol.ts";

export { createHttpSthripAgentClient, createHttpSthripAgentClientFromEnv };
export type { CreateHttpSthripAgentClientOptions, SthripAgentClient };

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "sthrip-agent-api",
  version: "0.1.0",
};
const SERVER_CAPABILITIES = {
  tools: {
    listChanged: false,
  },
};

const EmptyArgsSchema = z.object({}).strict();

const ReviewIdArgsSchema = z.object({
  review_id: z.string().min(1),
}).strict();

const JobIdArgsSchema = z.object({
  job_id: z.string().min(1),
}).strict();

const WhiteboxArgsSchema = z
  .object({
    repo_id: z.string().min(1).optional(),
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name")
      .optional(),
    ref: z.string().min(1).optional(),
    mode: z.enum(["fast", "deep"]).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.repo_id) || Boolean(value.repo), {
    message: "repo_id or repo is required",
    path: ["repo"],
  });
const WHITEBOX_REPO_REQUIREMENT_SCHEMA = {
  anyOf: [{ required: ["repo_id"] }, { required: ["repo"] }],
};

export interface CreateSthripMcpServerOptions {
  client: SthripAgentClient;
  log?: (line: string) => void;
}

export interface RunMcpStdioServerOptions extends CreateSthripMcpServerOptions {
  input: AsyncIterable<string | Uint8Array>;
  write: (chunk: string) => void | Promise<void>;
}

interface McpLifecycleState {
  initializeAccepted: boolean;
  initialized: boolean;
}

interface SthripToolConfig {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
}

const STHRIP_TOOL_CONFIGS = [
  {
    name: "sthrip_health",
    description: "Return Sthrip agent API health and enabled feature flags.",
    inputSchema: {},
  },
  {
    name: "sthrip_list_reviews",
    description: "List reviews visible to the authenticated Sthrip agent user.",
    inputSchema: {},
  },
  {
    name: "sthrip_get_review",
    description: "Fetch one review with summary and findings by review_id.",
    inputSchema: {
      review_id: z.string().min(1),
    },
  },
  {
    name: "sthrip_list_findings",
    description: "List findings for a review by review_id.",
    inputSchema: {
      review_id: z.string().min(1),
    },
  },
  {
    name: "sthrip_start_whitebox",
    description: "Queue a whitebox review and return its review_id and job_id.",
    inputSchema: {
      repo_id: z.string().min(1).optional(),
      repo: z
        .string()
        .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name")
        .optional(),
      ref: z.string().min(1).optional(),
      mode: z.enum(["fast", "deep"]).optional(),
    },
  },
  {
    name: "sthrip_get_job",
    description: "Fetch queued job status by job_id.",
    inputSchema: {
      job_id: z.string().min(1),
    },
  },
] satisfies SthripToolConfig[];

const TOOL_NAMES = new Set(STHRIP_TOOL_CONFIGS.map((tool) => tool.name));

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "invalid arguments";
}

function toToolResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
    isError,
  };
}

function normalizeAgentError(error: unknown) {
  const message = getErrorMessage(error);
  if (error instanceof AgentApiError) {
    return {
      message,
      status: error.status,
      body: error.body,
    };
  }
  return { message };
}

function parseToolName(params: unknown): string {
  if (!isRecord(params)) return "";
  return typeof params.name === "string" ? params.name : "";
}

function parseToolArguments(params: unknown): unknown {
  return isRecord(params) ? params.arguments : undefined;
}

function validateToolArguments(name: string, args: unknown): void {
  switch (name) {
    case "sthrip_health":
    case "sthrip_list_reviews":
      EmptyArgsSchema.parse(args ?? {});
      return;
    case "sthrip_get_review":
    case "sthrip_list_findings":
      ReviewIdArgsSchema.parse(args ?? {});
      return;
    case "sthrip_start_whitebox":
      WhiteboxArgsSchema.parse(args ?? {});
      return;
    case "sthrip_get_job":
      JobIdArgsSchema.parse(args ?? {});
      return;
    default:
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
  }
}

function assertValidToolCall(params: unknown): void {
  const toolName = parseToolName(params);
  if (!toolName || !TOOL_NAMES.has(toolName)) {
    throw new McpError(ErrorCode.MethodNotFound, "Method not found");
  }

  try {
    validateToolArguments(toolName, parseToolArguments(params));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        validationMessage(error),
        error.flatten(),
      );
    }
    throw error;
  }
}

function normalizeEmptyToolArguments(
  request: { params: Record<string, unknown> },
): void {
  const toolName = parseToolName(request.params);
  if (
    (toolName === "sthrip_health" || toolName === "sthrip_list_reviews") &&
    !Object.prototype.hasOwnProperty.call(request.params, "arguments")
  ) {
    request.params = { ...request.params, arguments: {} };
  }
}

function normalizeClientInfo(value: unknown) {
  if (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string"
  ) {
    return { ...value, name: value.name, version: value.version };
  }
  return { name: "unknown", version: "0.0.0" };
}

async function callTool(
  client: SthripAgentClient,
  name: string,
  args: unknown,
): Promise<unknown> {
  switch (name) {
    case "sthrip_health":
      EmptyArgsSchema.parse(args ?? {});
      return client.health();
    case "sthrip_list_reviews":
      EmptyArgsSchema.parse(args ?? {});
      return client.listReviews();
    case "sthrip_get_review": {
      const parsed = ReviewIdArgsSchema.parse(args ?? {});
      return client.getReview(parsed.review_id);
    }
    case "sthrip_list_findings": {
      const parsed = ReviewIdArgsSchema.parse(args ?? {});
      return client.listFindings(parsed.review_id);
    }
    case "sthrip_start_whitebox": {
      const parsed = WhiteboxArgsSchema.parse(args ?? {});
      return client.startWhitebox({
        ...(parsed.repo_id !== undefined ? { repo_id: parsed.repo_id } : {}),
        ...(parsed.repo !== undefined ? { repo: parsed.repo } : {}),
        ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
        ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      });
    }
    case "sthrip_get_job": {
      const parsed = JobIdArgsSchema.parse(args ?? {});
      return client.getJob(parsed.job_id);
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
  }
}

function registerSthripTool(
  server: McpServer,
  client: SthripAgentClient,
  config: SthripToolConfig,
): void {
  const registerTool = server.registerTool.bind(server) as (
    toolConfig: SthripToolConfig,
    handler: (args: unknown) => Promise<ReturnType<typeof toToolResult>>,
  ) => void;

  // Skybridge accumulates tool types across chained calls; this bounded wrapper
  // keeps TypeScript from expanding that generic for this dynamic registry.
  registerTool(config, async (args) => {
    try {
      const payload = await callTool(client, config.name, args);
      return toToolResult(payload);
    } catch (error) {
      return toToolResult(normalizeAgentError(error), true);
    }
  });
}

function installLifecycleMiddleware(
  server: McpServer,
  state: McpLifecycleState,
): void {
  server.mcpMiddleware("initialize", async (request, _extra, next) => {
    const params = isRecord(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
    const requestedVersion =
      typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;

    request.params = {
      ...params,
      protocolVersion: requestedVersion ?? SUPPORTED_PROTOCOL_VERSION,
      capabilities: isRecord(params.capabilities) ? params.capabilities : {},
      clientInfo: normalizeClientInfo(params.clientInfo),
    };

    state.initializeAccepted = true;
    state.initialized = false;
    await next();

    return {
      protocolVersion:
        requestedVersion === SUPPORTED_PROTOCOL_VERSION
          ? requestedVersion
          : SUPPORTED_PROTOCOL_VERSION,
      capabilities: SERVER_CAPABILITIES,
      serverInfo: SERVER_INFO,
    };
  });

  server.mcpMiddleware("notifications/initialized", (_request, _extra, next) => {
    if (state.initializeAccepted) {
      state.initialized = true;
    }
    return next();
  });

  server.mcpMiddleware("tools/*", (request, _extra, next) => {
    if (!state.initialized) {
      throw new McpError(-32002, "Server not initialized");
    }
    if (request.method === "tools/call") {
      assertValidToolCall(request.params);
      normalizeEmptyToolArguments(request);
    }
    return next();
  });

  server.mcpMiddleware("tools/list", async (_request, _extra, next) => {
    const result = await next() as {
      tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }>;
    };
    const whiteboxTool = result.tools?.find(
      (tool) => tool.name === "sthrip_start_whitebox",
    );

    if (whiteboxTool?.inputSchema) {
      whiteboxTool.inputSchema = {
        ...whiteboxTool.inputSchema,
        ...WHITEBOX_REPO_REQUIREMENT_SCHEMA,
      };
    }

    return result;
  });
}

function registerSthripTools(server: McpServer, client: SthripAgentClient): void {
  for (const config of STHRIP_TOOL_CONFIGS) {
    registerSthripTool(server, client, config);
  }
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function getRequestId(message: JSONRPCMessage): RequestId | null {
  if (
    "method" in message &&
    "id" in message &&
    typeof message.id !== "undefined"
  ) {
    return message.id;
  }
  return null;
}

function getResponseId(message: JSONRPCMessage): RequestId | null {
  if (
    ("result" in message || "error" in message) &&
    "id" in message &&
    typeof message.id !== "undefined"
  ) {
    return message.id;
  }
  return null;
}

function extractValidId(line: string): RequestId | null {
  try {
    const message: unknown = JSON.parse(line);
    if (!isRecord(message)) return null;
    const { id } = message;
    if (typeof id === "string") return id;
    if (typeof id === "number" && Number.isInteger(id)) return id;
    return null;
  } catch {
    return null;
  }
}

async function waitForNotificationHandlers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class AsyncIterableJsonRpcTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private closed = false;
  private started = false;
  private readPromise: Promise<void> | null = null;
  private readonly decoder = createJsonLineDecoder();
  private readonly responseWaiters = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();

  constructor(
    private readonly input: AsyncIterable<string | Uint8Array>,
    private readonly write: (chunk: string) => void | Promise<void>,
    private readonly log: (line: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("AsyncIterableJsonRpcTransport already started");
    }
    this.started = true;
    this.readPromise = this.readInput();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.write(serializeMessage(message));

    const responseId = getResponseId(message);
    if (responseId !== null) {
      const key = requestKey(responseId);
      const waiter = this.responseWaiters.get(key);
      if (waiter) {
        this.responseWaiters.delete(key);
        waiter.resolve();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  async drain(): Promise<void> {
    await this.readPromise;
    await Promise.all(
      [...this.responseWaiters.values()].map((waiter) => waiter.promise),
    );
    await this.close();
  }

  private async readInput(): Promise<void> {
    try {
      for await (const chunk of this.input) {
        const lines = this.decoder.push(chunk);
        for (const line of lines) {
          await this.handleLine(line);
        }
      }

      const tailLines = this.decoder.finish();
      for (const line of tailLines) {
        await this.handleLine(line);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;

    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch (error) {
      await this.handleParseError(line, error);
      return;
    }

    const requestId = getRequestId(message);
    if (requestId !== null) {
      let resolveResponse!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      this.responseWaiters.set(requestKey(requestId), {
        promise,
        resolve: resolveResponse,
      });
    }
    this.onmessage?.(message);
    if (requestId === null) {
      await waitForNotificationHandlers();
    }
  }

  private async handleParseError(line: string, error: unknown): Promise<void> {
    const isParseError = error instanceof SyntaxError;
    this.log(`mcp parse error: ${getErrorMessage(error)}`);
    const errorMessage = {
      jsonrpc: "2.0",
      id: isParseError ? null : extractValidId(line),
      error: {
        code: isParseError ? ErrorCode.ParseError : ErrorCode.InvalidRequest,
        message: isParseError ? "Parse error" : "Invalid Request",
      },
    } as JSONRPCMessage;
    await this.send(errorMessage);
  }

  private onError(error: unknown): void {
    this.onerror?.(error instanceof Error ? error : new Error(String(error)));
  }
}

export function createSthripMcpServer(options: CreateSthripMcpServerOptions) {
  const state: McpLifecycleState = {
    initializeAccepted: false,
    initialized: false,
  };
  const server = new McpServer(SERVER_INFO, { capabilities: {} });

  installLifecycleMiddleware(server, state);
  registerSthripTools(server, options.client);
  server.server.registerCapabilities(SERVER_CAPABILITIES);

  return server;
}

export async function runMcpStdioServer(
  options: RunMcpStdioServerOptions,
): Promise<void> {
  const server = createSthripMcpServer(options);
  const transport = new AsyncIterableJsonRpcTransport(
    options.input,
    options.write,
    options.log ?? (() => {}),
  );

  await server.connect(transport);
  await transport.drain();
}

function stderrLogger(line: string): void {
  process.stderr.write(`${line}\n`);
}

export interface RunMcpMainOptions {
  readonly input: AsyncIterable<string | Uint8Array>;
  readonly write: (chunk: string) => void | Promise<void>;
  readonly log?: (line: string) => void;
  readonly clientFactory?: () => SthripAgentClient;
}

export async function runMcpMain(
  options: RunMcpMainOptions,
): Promise<number> {
  const log = options.log ?? stderrLogger;
  try {
    const client = (options.clientFactory ?? createHttpSthripAgentClientFromEnv)();
    await runMcpStdioServer({
      client,
      input: options.input,
      write: options.write,
      log,
    });
    return 0;
  } catch (error) {
    log(`mcp fatal: ${getErrorMessage(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  void runMcpMain({
    input: process.stdin as AsyncIterable<string | Uint8Array>,
    write: (chunk) => {
      process.stdout.write(chunk);
    },
    log: stderrLogger,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      stderrLogger(`mcp fatal: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    });
}
