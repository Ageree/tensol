import type { VerifierResult } from './types.ts';

export interface TxtDnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const DNS_TOKEN_PREFIX = 'tensol-verify=';

const randomHex32 = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const generateChallenge = (
  _targetId: string,
  domain: string,
  randomBytes: () => string = randomHex32,
): { token: string; txtRecord: { name: string; value: string } } => {
  const hex = randomBytes();
  const token = `${DNS_TOKEN_PREFIX}${hex}`;
  return {
    token,
    txtRecord: {
      name: `_tensol-verify.${domain}`,
      value: token,
    },
  };
};

export const DNS_TIMEOUT_MS = 5_000;

export const verify = (
  domain: string,
  expectedToken: string,
  deps: { dnsResolver: TxtDnsResolver; timeoutMs?: number },
): Promise<VerifierResult> => {
  const ms = deps.timeoutMs ?? DNS_TIMEOUT_MS;

  const lookup = deps.dnsResolver
    .resolveTxt(`_tensol-verify.${domain}`)
    .then((records): VerifierResult => {
      const found = records.some((parts) => parts.join('') === expectedToken);
      if (found) return { ok: true };
      return { ok: false, reason: 'token_mismatch' };
    })
    .catch((): VerifierResult => ({ ok: false, reason: 'dns_lookup_error' }));

  const timeout = new Promise<VerifierResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
  });

  return Promise.race([lookup, timeout]);
};
