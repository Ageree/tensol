// Sprint 18 — OOB DNS callback listener (UDP).
//
// Binds UDP on OOB_DNS_PORT (default 5353).
// Parses OOB token from leftmost label of qname.
// Always responds NXDOMAIN. Errors in DNS packet parsing → log warning, continue.
//
// NOT wired to prod compose; dev/lab fixture only.

import dgram from 'node:dgram';
import type { Database } from '@cyberstrike/db';
import type { Kysely } from 'kysely';
import { parseToken } from './token.ts';

// Minimal DNS NXDOMAIN response builder.
// Copies the query ID from the request and sets RCODE=3.
const buildNxdomainResponse = (queryBuf: Buffer): Buffer => {
  if (queryBuf.length < 12) return Buffer.alloc(0);
  const response = Buffer.alloc(queryBuf.length);
  queryBuf.copy(response);
  // Byte 2: QR=1 (response), Opcode=0, AA=0, TC=0, RD=1
  response[2] = 0x81;
  // Byte 3: RA=0, Z=0, RCODE=3 (NXDOMAIN)
  response[3] = 0x83;
  // ANCOUNT = 0, NSCOUNT = 0, ARCOUNT = 0 (already 0 from copy).
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
};

// Parse the first label from the DNS question section (offset 12).
const parseQname = (buf: Buffer): { qname: string; qtype: number } | null => {
  try {
    let offset = 12;
    const labels: string[] = [];
    while (offset < buf.length) {
      const len = buf[offset];
      if (len === undefined || len === 0) {
        offset++;
        break;
      }
      if ((len & 0xc0) === 0xc0) break; // compression pointer — stop
      offset++;
      if (offset + len > buf.length) return null;
      labels.push(buf.subarray(offset, offset + len).toString('ascii'));
      offset += len;
    }
    if (offset + 2 > buf.length) return null;
    const qtype = buf.readUInt16BE(offset);
    return { qname: labels.join('.'), qtype };
  } catch {
    return null;
  }
};

export interface OobDnsListenerDeps {
  readonly db: Kysely<Database>;
  readonly port?: number;
}

export interface OobDnsListenerHandle {
  readonly port: number;
  stop(): void;
}

export const startDnsListener = (deps: OobDnsListenerDeps): OobDnsListenerHandle => {
  const port = deps.port ?? Number(process.env.OOB_DNS_PORT ?? 5353);
  const socket = dgram.createSocket('udp4');

  socket.on('message', async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    let qname: string | null = null;
    let qtypeStr: string | null = null;
    let rawToken: string | null = null;
    let parsed = null;

    try {
      const parsed_ = parseQname(msg);
      if (parsed_) {
        qname = parsed_.qname;
        qtypeStr = String(parsed_.qtype);
        // Token spans the first 3 DNS labels: <candidateUUID>.<tenantUUID>.<hex8>
        const labels = qname.split('.');
        const threeLabel = labels.slice(0, 3).join('.');
        if (threeLabel) {
          rawToken = parseToken(threeLabel) ? threeLabel : null;
          parsed = parseToken(threeLabel);
        }
      }
    } catch (err) {
      console.warn('[oob-dns] DNS parse warning:', err instanceof Error ? err.message : err);
    }

    try {
      await deps.db
        .insertInto('oob_callbacks')
        .values({
          token: rawToken,
          tenant_id: parsed?.tenantId ?? null,
          candidate_id: parsed?.candidateId ?? null,
          kind: 'dns',
          qname,
          qtype: qtypeStr,
          source_ip: rinfo.address,
        })
        .execute();
    } catch (err) {
      console.warn('[oob-dns] DB insert warning:', err instanceof Error ? err.message : err);
    }

    // Always respond NXDOMAIN.
    try {
      const resp = buildNxdomainResponse(msg);
      if (resp.length > 0) {
        socket.send(resp, rinfo.port, rinfo.address);
      }
    } catch (err) {
      console.warn('[oob-dns] Send warning:', err instanceof Error ? err.message : err);
    }
  });

  socket.on('error', (err) => {
    console.warn('[oob-dns] Socket error:', err.message);
  });

  socket.bind(port);

  return {
    port,
    stop: (): void => {
      socket.close();
    },
  };
};
