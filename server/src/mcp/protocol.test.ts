import { describe, expect, test } from "bun:test";

import {
  createJsonLineDecoder,
  createJsonRpcError,
  createJsonRpcSuccess,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
} from "./protocol.ts";

describe("mcp/protocol", () => {
  test("decodes newline-delimited JSON-RPC messages across chunk boundaries", () => {
    const decoder = createJsonLineDecoder();

    expect(decoder.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0"')).toEqual(
      ['{"jsonrpc":"2.0","id":1,"method":"ping"}'],
    );
    expect(decoder.push(',"id":2,"method":"tools/list"}\n')).toEqual([
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  test("parseJsonRpcMessage rejects invalid JSON", () => {
    expect(() => parseJsonRpcMessage("{not-json}")).toThrow(/invalid json/i);
  });

  test("serializeJsonRpcMessage stays single-line and preserves escaped newlines", () => {
    const line = serializeJsonRpcMessage(
      createJsonRpcSuccess(1, {
        content: [{ type: "text", text: "line 1\nline 2" }],
      }),
    );

    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("\\n");
  });

  test("createJsonRpcError builds a JSON-RPC 2.0 error envelope", () => {
    expect(createJsonRpcError(7, -32601, "method not found")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32601,
        message: "method not found",
      },
    });
  });
});
