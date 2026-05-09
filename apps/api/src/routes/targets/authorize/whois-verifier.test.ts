import { describe, expect, it } from 'bun:test';
import type { Mailer, TokenStore, WhoisClient } from './whois-verifier.ts';
import { lookupRegistrantEmail, sendVerificationEmail, verify } from './whois-verifier.ts';

const mockWhois = (raw: string): WhoisClient => ({
  lookup: async (_domain) => ({ raw }),
});

const throwingWhois = (): WhoisClient => ({
  lookup: async () => {
    throw new Error('whois timeout');
  },
});

describe('lookupRegistrantEmail', () => {
  it('registrant found — returns email', async () => {
    const raw = 'Domain: example.com\nRegistrant Email: owner@example.com\nAdmin Email: admin@example.com';
    const result = await lookupRegistrantEmail('example.com', { whoisClient: mockWhois(raw) });
    expect(result).toEqual({ email: 'owner@example.com' });
  });

  it('admin fallback when no registrant', async () => {
    const raw = 'Domain: example.com\nAdmin Email: admin@example.com';
    const result = await lookupRegistrantEmail('example.com', { whoisClient: mockWhois(raw) });
    expect(result).toEqual({ email: 'admin@example.com' });
  });

  it('multiple registrant lines — first wins', async () => {
    const raw = [
      'Registrant Email: first@example.com',
      'Registrant Email: second@example.com',
    ].join('\n');
    const result = await lookupRegistrantEmail('example.com', { whoisClient: mockWhois(raw) });
    expect(result).toEqual({ email: 'first@example.com' });
  });

  it('privacy proxy (REDACTED FOR PRIVACY) → privacy_proxy', async () => {
    const raw = 'Registrant Email: REDACTED FOR PRIVACY';
    const result = await lookupRegistrantEmail('example.com', { whoisClient: mockWhois(raw) });
    expect(result).toEqual({ reason: 'privacy_proxy' });
  });

  it('privacy proxy (whoisguard variant)', async () => {
    const raw = 'Registrant Email: proxy@whoisguard.com';
    const result = await lookupRegistrantEmail('example.com', { whoisClient: mockWhois(raw) });
    expect(result).toEqual({ reason: 'privacy_proxy' });
  });

  it('no email at all → no_registrant_email', async () => {
    const raw = 'Domain: example.com\nRegistrant Name: John Doe';
    const result = await lookupRegistrantEmail('example.com', { whoisClient: mockWhois(raw) });
    expect(result).toEqual({ reason: 'no_registrant_email' });
  });

  it('whois client throws → whois_lookup_error', async () => {
    const result = await lookupRegistrantEmail('example.com', { whoisClient: throwingWhois() });
    expect(result).toEqual({ reason: 'whois_lookup_error' });
  });
});

describe('sendVerificationEmail', () => {
  it('calls mailer.send once with link containing token', async () => {
    const sent: Parameters<Mailer['send']>[0][] = [];
    const mailer: Mailer = {
      send: async (args) => {
        sent.push(args);
        return { messageId: 'msg-123' };
      },
    };
    const result = await sendVerificationEmail(
      {
        email: 'owner@example.com',
        token: 'tok123',
        targetId: 'target-id',
        projectId: 'proj-id',
        baseUrl: 'https://app.tensol.io',
        traceId: 'trace-1',
      },
      { mailer },
    );
    expect(result).toEqual({ messageId: 'msg-123' });
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe('owner@example.com');
    expect(sent[0]!.textBody).toContain('tok123');
    expect(sent[0]!.textBody).toContain('/api/v1/targets/target-id/authorize/email-confirm?token=tok123');
  });

  it('mailer rejection bubbles up', async () => {
    const mailer: Mailer = {
      send: async () => {
        throw new Error('SMTP down');
      },
    };
    await expect(
      sendVerificationEmail(
        { email: 'x@x.com', token: 't', targetId: 'tid', projectId: 'pid', baseUrl: 'https://b', traceId: 'tr' },
        { mailer },
      ),
    ).rejects.toThrow('SMTP down');
  });
});

describe('verify (token store)', () => {
  const NOW = 1_700_000_000_000;
  const FUTURE = new Date(NOW + 10_000);
  const PAST = new Date(NOW - 1);

  const makeStore = (row: Awaited<ReturnType<TokenStore['findByPlaintext']>>) => {
    const calls: string[] = [];
    const store: TokenStore = {
      findByPlaintext: async () => row,
      markVerified: async (id) => { calls.push(id); },
    };
    return { store, calls };
  };

  it('happy path — pending + not expired → ok:true, markVerified called', async () => {
    const { store, calls } = makeStore({
      id: 'row-1',
      targetId: 'tgt-1',
      status: 'pending',
      expiresAt: FUTURE,
    });
    const result = await verify('token', NOW, { tokenStore: store });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['row-1']);
  });

  it('expired row → ok:false, reason:expired, markVerified NOT called', async () => {
    const { store, calls } = makeStore({
      id: 'row-2',
      targetId: 'tgt-1',
      status: 'pending',
      expiresAt: PAST,
    });
    const result = await verify('token', NOW, { tokenStore: store });
    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(calls).toEqual([]);
  });

  it('not found → ok:false, reason:not_found', async () => {
    const { store, calls } = makeStore(null);
    const result = await verify('token', NOW, { tokenStore: store });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(calls).toEqual([]);
  });

  it('replay — status already verified → ok:true, markVerified NOT called', async () => {
    const { store, calls } = makeStore({
      id: 'row-3',
      targetId: 'tgt-1',
      status: 'verified',
      expiresAt: FUTURE,
    });
    const result = await verify('token', NOW, { tokenStore: store });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  it('status=failed → ok:false, reason:expired', async () => {
    const { store, calls } = makeStore({
      id: 'row-4',
      targetId: 'tgt-1',
      status: 'failed',
      expiresAt: FUTURE,
    });
    const result = await verify('token', NOW, { tokenStore: store });
    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(calls).toEqual([]);
  });
});
