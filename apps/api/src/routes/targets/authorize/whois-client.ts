import type { WhoisClient } from './whois-verifier.ts';

export class NodeWhoisClient implements WhoisClient {
  async lookup(domain: string): Promise<{ raw: string }> {
    // Lazy import — whois-json may not be installed in all envs.
    // @ts-expect-error — whois-json is an optional runtime dependency
    const whoisJson = await import('whois-json').catch(() => null);
    if (!whoisJson) {
      throw new Error('whois-json package not available');
    }
    const result = await whoisJson.default(domain);
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    return { raw };
  }
}
