import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import { authenticateAgentToken } from "./tokens.ts";

export interface AgentAuthVariables extends AuthVariables {
  agentToken: { id: string; name: string };
}

export interface CreateRequireAgentAuthDeps {
  readonly db: DB;
  readonly now?: () => number;
}

function unauthenticated() {
  return { error: "unauthenticated" as const };
}

export function createRequireAgentAuth(
  deps: CreateRequireAgentAuthDeps,
): MiddlewareHandler<{ Variables: AgentAuthVariables }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return c.json(unauthenticated(), 401);
    const auth = await authenticateAgentToken({
      db: deps.db,
      token: match[1]!,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    if (!auth) return c.json(unauthenticated(), 401);
    c.set("user", auth.user);
    c.set("session", {
      id: `agent:${auth.token.id}`,
      user_id: auth.user.id,
      expires_at: Number.MAX_SAFE_INTEGER,
    });
    c.set("agentToken", auth.token);
    await next();
  };
}
