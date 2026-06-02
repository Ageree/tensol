# Skybridge MCP Refactor

## Goal

Replace the handwritten MCP JSON-RPC dispatcher with Skybridge's `McpServer`
while preserving the Sthrip agent tool surface and stdio entrypoint.

Skybridge source of truth:

- Local clone: `external/skybridge`
- Commit inspected: `651657c`
- Relevant source:
  - `packages/core/src/server/server.ts`
  - `packages/core/src/server/express.ts`
  - `docs/api-reference/mcp-server.mdx`
  - `docs/api-reference/register-tool.mdx`

## Behavior Lock

Before edits:

```bash
cd server
bun test src/mcp/protocol.test.ts src/mcp/server.test.ts src/agent/client.test.ts src/cli/index.test.ts
```

Result: 22 tests passed.

## Implementation Tasks

1. Add runtime dependencies aligned with the inspected Skybridge source:
   - `skybridge@1.0.0`
   - `@modelcontextprotocol/sdk@1.29.0`
   - Skybridge's wider UI/devtools peer surface is accepted here because the
     user explicitly chose Skybridge as the MCP framework source of truth; the
     MCP entrypoint imports only `skybridge/server` and SDK stdio primitives.
2. Rebuild `server/src/mcp/server.ts` around `McpServer` from `skybridge/server`.
3. Register the existing six `sthrip_*` tools as plain Skybridge tools, with no UI views.
4. Use MCP SDK transport semantics for stdio while keeping the current injectable
   `AsyncIterable`/`write` test harness.
5. Keep agent API client exports stable for CLI/MCP consumers.
6. Update MCP tests to assert the same tool names, handlers, JSON-RPC framing,
   argument validation, and tool failure behavior through Skybridge.

## Review Gates

1. Spec reviewer: confirm Skybridge is the MCP implementation source and the
   Sthrip tool contract is still intact.
2. Code quality reviewer: inspect only the touched MCP/dependency scope.
3. AI slop cleanup: bounded to `server/src/mcp/*`, `server/package.json`, and
   lockfile changes caused by dependency installation.

## Verification

Minimum checks:

```bash
cd server
bun test src/mcp/protocol.test.ts src/mcp/server.test.ts src/agent/client.test.ts src/cli/index.test.ts
bunx tsc --noEmit
```

Final checks include `git diff --check` and `gitnexus_detect_changes`.
