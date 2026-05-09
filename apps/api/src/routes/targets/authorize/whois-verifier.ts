import type { VerifierResult } from './types.ts';

export interface WhoisClient {
  lookup(domain: string): Promise<{ raw: string }>;
}

export interface Mailer {
  send(args: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    traceId: string;
  }): Promise<{ messageId: string }>;
}

export interface TokenStore {
  findByPlaintext(
    token: string,
    nowMs: number,
  ): Promise<{ id: string; targetId: string; status: string; expiresAt: Date } | null>;
  markVerified(id: string, nowMs: number): Promise<void>;
}

const PRIVACY_PROXY_RE = /(REDACTED FOR PRIVACY|whoisguard|privacyprotect|whois-protect)/i;

export const lookupRegistrantEmail = async (
  domain: string,
  deps: { whoisClient: WhoisClient },
): Promise<{ email?: string; reason?: string }> => {
  let raw: string;
  try {
    const result = await deps.whoisClient.lookup(domain);
    raw = result.raw;
  } catch {
    return { reason: 'whois_lookup_error' };
  }

  // Check the rest-of-line after "Registrant Email:" for privacy markers before extracting.
  const registrantLineRe = /^Registrant Email:\s*(.+)/im;
  const adminLineRe = /^Admin Email:\s*(.+)/im;

  const registrantLine = registrantLineRe.exec(raw)?.[1]?.trim();
  const adminLine = adminLineRe.exec(raw)?.[1]?.trim();

  const candidateLine = registrantLine ?? adminLine;

  if (!candidateLine) {
    return { reason: 'no_registrant_email' };
  }

  if (PRIVACY_PROXY_RE.test(candidateLine)) {
    return { reason: 'privacy_proxy' };
  }

  // Extract the first non-whitespace token as the email address.
  const candidate = candidateLine.split(/\s+/)[0];
  if (!candidate) {
    return { reason: 'no_registrant_email' };
  }

  return { email: candidate };
};

export const sendVerificationEmail = async (
  args: {
    email: string;
    token: string;
    targetId: string;
    projectId: string;
    baseUrl: string;
    traceId: string;
  },
  deps: { mailer: Mailer },
): Promise<{ messageId: string }> => {
  const link = `${args.baseUrl}/api/v1/targets/${args.targetId}/authorize/email-confirm?token=${args.token}`;

  const textBody = [
    'Tensol — подтверждение прав на домен / Domain authorization',
    '',
    'RU: Для подтверждения прав на домен перейдите по ссылке:',
    link,
    '',
    'EN: To confirm domain ownership, follow the link:',
    link,
    '',
    'Ссылка действительна 24 часа. / Link is valid for 24 hours.',
  ].join('\n');

  const htmlBody = [
    '<p><strong>Tensol — подтверждение прав на домен / Domain authorization</strong></p>',
    '<p>RU: Для подтверждения прав на домен перейдите по ссылке:</p>',
    `<p><a href="${link}">${link}</a></p>`,
    '<p>EN: To confirm domain ownership, follow the link:</p>',
    `<p><a href="${link}">${link}</a></p>`,
    '<p>Ссылка действительна 24 часа. / Link is valid for 24 hours.</p>',
  ].join('\n');

  return deps.mailer.send({
    to: args.email,
    subject: 'Tensol — подтверждение прав на домен / Domain authorization',
    textBody,
    htmlBody,
    traceId: args.traceId,
  });
};

export const verify = async (
  token: string,
  nowMs: number,
  deps: { tokenStore: TokenStore },
): Promise<VerifierResult> => {
  const row = await deps.tokenStore.findByPlaintext(token, nowMs);

  if (!row) {
    return { ok: false, reason: 'not_found' };
  }

  if (row.status === 'verified') {
    return { ok: true };
  }

  if (row.status !== 'pending' || row.expiresAt.getTime() <= nowMs) {
    return { ok: false, reason: 'expired' };
  }

  await deps.tokenStore.markVerified(row.id, nowMs);
  return { ok: true };
};
