import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import type { DB } from "../db/client.ts";
import {
  agentApiTokens as agentApiTokensTable,
  users as usersTable,
  type AgentApiToken,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";

export const AGENT_TOKEN_PREFIX = "sthrip_";
const TOKEN_RANDOM_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = 18;

export interface AgentTokenPublic {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export interface CreateAgentTokenArgs {
  readonly db: DB;
  readonly userId: string;
  readonly name: string;
  readonly now?: () => number;
  readonly randomTokenBytes?: () => Uint8Array;
}

export interface ListAgentTokensArgs {
  readonly db: DB;
  readonly userId: string;
}

export interface RevokeAgentTokenArgs {
  readonly db: DB;
  readonly userId: string;
  readonly tokenId: string;
  readonly now?: () => number;
}

export interface AuthenticateAgentTokenArgs {
  readonly db: DB;
  readonly token: string;
  readonly now?: () => number;
}

export interface AuthenticatedAgent {
  readonly user: { readonly id: string; readonly email: string };
  readonly token: { readonly id: string; readonly name: string };
}

function tokenToPublic(row: AgentApiToken): AgentTokenPublic {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function sha256Token(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function generateToken(randomTokenBytes?: () => Uint8Array): string {
  const bytes = randomTokenBytes?.() ?? new Uint8Array(randomBytes(TOKEN_RANDOM_BYTES));
  if (bytes.length < TOKEN_RANDOM_BYTES) {
    throw new Error("agent token entropy source returned too few bytes");
  }
  return `${AGENT_TOKEN_PREFIX}${base64Url(bytes)}`;
}

export async function createAgentToken(
  args: CreateAgentTokenArgs,
): Promise<{ token: string; record: AgentTokenPublic }> {
  const ts = (args.now ?? defaultNow)();
  const token = generateToken(args.randomTokenBytes);
  const tokenHash = sha256Token(token);
  const row = {
    id: ulid(ts),
    userId: args.userId,
    name: args.name,
    tokenHash,
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    createdAt: ts,
    updatedAt: ts,
    lastUsedAt: null,
    revokedAt: null,
  } satisfies AgentApiToken;
  args.db.insert(agentApiTokensTable).values(row).run();
  return { token, record: tokenToPublic(row) };
}

export async function listAgentTokens(
  args: ListAgentTokensArgs,
): Promise<AgentTokenPublic[]> {
  const rows = args.db
    .select()
    .from(agentApiTokensTable)
    .where(eq(agentApiTokensTable.userId, args.userId))
    .all() as AgentApiToken[];
  return rows.map(tokenToPublic);
}

export async function revokeAgentToken(
  args: RevokeAgentTokenArgs,
): Promise<boolean> {
  const ts = (args.now ?? defaultNow)();
  const existing = args.db
    .select()
    .from(agentApiTokensTable)
    .where(
      and(
        eq(agentApiTokensTable.id, args.tokenId),
        eq(agentApiTokensTable.userId, args.userId),
        isNull(agentApiTokensTable.revokedAt),
      ),
    )
    .get() as AgentApiToken | undefined;
  if (!existing) return false;
  args.db
    .update(agentApiTokensTable)
    .set({ revokedAt: ts, updatedAt: ts })
    .where(eq(agentApiTokensTable.id, existing.id))
    .run();
  return true;
}

export async function authenticateAgentToken(
  args: AuthenticateAgentTokenArgs,
): Promise<AuthenticatedAgent | null> {
  if (!args.token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const hash = sha256Token(args.token);
  const tokenRow = args.db
    .select()
    .from(agentApiTokensTable)
    .where(
      and(
        eq(agentApiTokensTable.tokenHash, hash),
        isNull(agentApiTokensTable.revokedAt),
      ),
    )
    .get() as AgentApiToken | undefined;
  if (!tokenRow || !constantTimeEqual(tokenRow.tokenHash, hash)) return null;
  const user = args.db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, tokenRow.userId))
    .get();
  if (!user) return null;
  const ts = (args.now ?? defaultNow)();
  args.db
    .update(agentApiTokensTable)
    .set({ lastUsedAt: ts, updatedAt: ts })
    .where(eq(agentApiTokensTable.id, tokenRow.id))
    .run();
  return {
    user: { id: user.id, email: user.email },
    token: { id: tokenRow.id, name: tokenRow.name },
  };
}
