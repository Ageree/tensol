export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessShape {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorEnvelope {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorShape;
}

function normalizeChunk(chunk: string | Uint8Array, decoder: TextDecoder): string {
  return typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
}

export function createJsonLineDecoder() {
  const decoder = new TextDecoder();
  let pending = "";

  const flushLines = (): string[] => {
    const lines: string[] = [];
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex >= 0) {
      const raw = pending.slice(0, newlineIndex).replace(/\r$/, "");
      pending = pending.slice(newlineIndex + 1);
      if (raw.trim().length > 0) lines.push(raw);
      newlineIndex = pending.indexOf("\n");
    }
    return lines;
  };

  return {
    push(chunk: string | Uint8Array): string[] {
      pending += normalizeChunk(chunk, decoder);
      return flushLines();
    },
    finish(): string[] {
      pending += decoder.decode();
      const lines = flushLines();
      const tail = pending.replace(/\r$/, "");
      pending = "";
      if (tail.trim().length > 0) lines.push(tail);
      return lines;
    },
  };
}

export function parseJsonRpcMessage(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("invalid JSON-RPC message: invalid JSON");
  }
}

export function serializeJsonRpcMessage(message: unknown): string {
  return JSON.stringify(message);
}

export function createJsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessShape {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

export function createJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorEnvelope {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}
