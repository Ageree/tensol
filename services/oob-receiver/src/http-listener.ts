// Sprint 18 — OOB HTTP callback listener.
//
// Accepts any HTTP method and path on OOB_HTTP_PORT (default 5082).
// Parses OOB token from path or _cs_token query param.
// Redacts Authorization + Cookie headers before DB insert.
// Body capped at 64KB.
// GET /healthz returns {ok:true, count:<n>}.
//
// NOT wired to prod compose; dev/lab fixture only.

import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';
import { redactHeaders } from './redact.ts';
import { extractTokenFromPath, parseToken } from './token.ts';

const BODY_LIMIT_BYTES = 64 * 1024;

export interface OobHttpListenerDeps {
  readonly db: Kysely<Database>;
  readonly port?: number;
}

export interface OobHttpListenerHandle {
  readonly port: number;
  stop(): Promise<void>;
}

export const startHttpListener = (deps: OobHttpListenerDeps): OobHttpListenerHandle => {
  const port = deps.port ?? Number(process.env.OOB_HTTP_PORT ?? 5082);

  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const row = await deps.db
          .selectFrom('oob_callbacks')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .executeTakeFirstOrThrow();
        return Response.json({ ok: true, count: Number(row.count) });
      }

      const queryToken = url.searchParams.get('_cs_token');
      const rawToken = extractTokenFromPath(url.pathname, queryToken);
      const parsed = parseToken(rawToken);

      const headersObj: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) {
        headersObj[k] = v;
      }
      const redacted = redactHeaders(headersObj);

      // Enforce 64KB cap before buffering to prevent DoS via huge body.
      const contentLength = req.headers.get('content-length');
      if (contentLength !== null && Number(contentLength) > BODY_LIMIT_BYTES) {
        return new Response('Payload Too Large', { status: 413 });
      }

      let body: string | null = null;
      try {
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 0) {
          const slice = buf.byteLength > BODY_LIMIT_BYTES ? buf.slice(0, BODY_LIMIT_BYTES) : buf;
          body = new TextDecoder().decode(slice);
        }
      } catch {
        // Body read failure is non-fatal — log with null body.
      }

      const sourceIp = server.requestIP(req)?.address ?? null;

      // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary.
      const headersJson = JSON.stringify(redacted) as any;

      await deps.db
        .insertInto('oob_callbacks')
        .values({
          token: rawToken,
          tenant_id: parsed?.tenantId ?? null,
          candidate_id: parsed?.candidateId ?? null,
          kind: 'http',
          method: req.method,
          path: url.pathname + (url.search || ''),
          headers: headersJson,
          body,
          source_ip: sourceIp,
        })
        .execute();

      return new Response('ok', { status: 200 });
    },
  });

  return {
    port: server.port,
    stop: async (): Promise<void> => {
      server.stop(true);
    },
  };
};
