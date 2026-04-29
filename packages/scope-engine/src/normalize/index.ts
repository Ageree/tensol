// Sprint 6 — Action normalization orchestrator.
//
// `normalizeAction(input, deps)` is the single entry from the engine into the
// pure-but-DI-async normalization layer. DNS resolution goes through the
// injected `DnsResolver` interface — the engine NEVER imports `dns`.

import type { HttpMethod, Protocol, ScopeActionInput } from '@cyberstrike/contracts';
import type {
  DnsResolutionStatus,
  DnsResolver,
  NormalizedAction,
  NormalizedIp,
  ResolvedTarget,
} from '../types.ts';
import { normalizeHost } from './host.ts';
import { normalizeIp } from './ip.ts';
import { type NormalizedUrl, normalizeUrl } from './url.ts';

export class ActionNormalizationError extends Error {
  constructor(message: string) {
    super(`action_normalization_error: ${message}`);
    this.name = 'ActionNormalizationError';
  }
}

const tryClassifyAsIp = (raw: string): NormalizedIp | null => {
  try {
    return normalizeIp(raw);
  } catch {
    return null;
  }
};

const resolveHost = async (host: string, dns: DnsResolver): Promise<readonly NormalizedIp[]> => {
  const [v4s, v6s] = await Promise.all([
    dns.resolveA(host).catch(() => [] as string[]),
    dns.resolveAAAA(host).catch(() => [] as string[]),
  ]);
  const ips: NormalizedIp[] = [];
  for (const v of [...v4s, ...v6s]) {
    try {
      ips.push(normalizeIp(v));
    } catch {
      // skip un-parseable resolver responses
    }
  }
  return ips;
};

/**
 * Build a ResolvedTarget for an HTTP-style URL — used both for the primary
 * `http_request` URL and for each entry in `followRedirectsTo`. Each call
 * performs its own DNS resolution (codex iter-4 P1) and reports a
 * `dnsResolution` sentinel so decide() can fail closed on NXDOMAIN/empty.
 */
const buildHttpTarget = async (
  url: NormalizedUrl,
  method: HttpMethod | undefined,
  dns: DnsResolver,
): Promise<ResolvedTarget> => {
  const protocol: Protocol | null =
    url.scheme === 'https'
      ? 'https'
      : url.scheme === 'http'
        ? 'http'
        : url.scheme === 'ws'
          ? 'ws'
          : url.scheme === 'wss'
            ? 'wss'
            : null;
  const hostAsIp = tryClassifyAsIp(url.host);
  let resolvedIps: NormalizedIp[];
  let dnsResolution: DnsResolutionStatus;
  if (hostAsIp) {
    resolvedIps = [hostAsIp];
    dnsResolution = 'not_applicable';
  } else {
    const ips = await resolveHost(url.host, dns);
    resolvedIps = [...ips];
    dnsResolution = ips.length > 0 ? 'success' : 'failed';
  }
  return {
    host: url.host,
    hostHasMixedScript: url.hostHasMixedScript,
    ...(url.hostIsIp ? { hostIsIp: true } : {}),
    url: url.canonical,
    ...(protocol !== null ? { protocol } : {}),
    ...(url.port !== undefined ? { port: url.port } : {}),
    ...(url.effectivePort !== undefined ? { effectivePort: url.effectivePort } : {}),
    path: url.path,
    ...(method !== undefined ? { method } : {}),
    resolvedIps,
    dnsResolution,
  };
};

export const normalizeAction = async (
  input: ScopeActionInput,
  deps: { dns: DnsResolver },
): Promise<NormalizedAction> => {
  switch (input.kind) {
    case 'http_request': {
      const url = normalizeUrl(input.url);
      // Build the primary target (no redirects yet).
      const primary = await buildHttpTarget(url, input.method, deps.dns);
      // codex iter-4 P1 — each redirect is independently normalized so
      // decide() can run the full matcher against it.
      const redirectTargets: string[] = [];
      const redirectNormalizedTargets: ResolvedTarget[] = [];
      if (input.followRedirectsTo) {
        for (const r of input.followRedirectsTo) {
          const rn = normalizeUrl(r);
          redirectTargets.push(rn.canonical);
          redirectNormalizedTargets.push(await buildHttpTarget(rn, undefined, deps.dns));
        }
      }
      const finalTarget: ResolvedTarget = {
        ...primary,
        ...(redirectTargets.length > 0 ? { redirectTargets } : {}),
        ...(redirectNormalizedTargets.length > 0 ? { redirectNormalizedTargets } : {}),
      };
      return { kind: 'http_request', target: finalTarget };
    }
    case 'dns_lookup': {
      // codex iter-5 P2 — try IP classification FIRST. `normalizeHost`
      // rejects colons (LDH-only), so `::1` and `2001:db8::1` would otherwise
      // throw before classification. IPv6 zone-id stripped from canonical (R4).
      const ipFirst = tryClassifyAsIp(input.host);
      if (ipFirst !== null) {
        return {
          kind: 'dns_lookup',
          target: {
            host: ipFirst.canonical,
            hostHasMixedScript: false,
            hostIsIp: true,
            resolvedIps: [ipFirst],
            dnsResolution: 'not_applicable',
          },
        };
      }
      const host = normalizeHost(input.host);
      const ips = await resolveHost(host.canonical, deps.dns);
      const resolvedIps: NormalizedIp[] = [...ips];
      const dnsResolution: DnsResolutionStatus = ips.length > 0 ? 'success' : 'failed';
      return {
        kind: 'dns_lookup',
        target: {
          host: host.canonical,
          hostHasMixedScript: host.hasMixedScript,
          resolvedIps,
          dnsResolution,
        },
      };
    }
    case 'tcp_connect': {
      // codex iter-5 P2 — IP-first ordering, mirrors dns_lookup branch.
      const ipFirst = tryClassifyAsIp(input.host);
      if (ipFirst !== null) {
        return {
          kind: 'tcp_connect',
          target: {
            host: ipFirst.canonical,
            hostHasMixedScript: false,
            hostIsIp: true,
            port: input.port,
            effectivePort: input.port,
            resolvedIps: [ipFirst],
            dnsResolution: 'not_applicable',
          },
        };
      }
      const host = normalizeHost(input.host);
      const ips = await resolveHost(host.canonical, deps.dns);
      const resolvedIps: NormalizedIp[] = [...ips];
      const dnsResolution: DnsResolutionStatus = ips.length > 0 ? 'success' : 'failed';
      return {
        kind: 'tcp_connect',
        target: {
          host: host.canonical,
          hostHasMixedScript: host.hasMixedScript,
          port: input.port,
          effectivePort: input.port,
          resolvedIps,
          dnsResolution,
        },
      };
    }
    case 'tool_invoke': {
      // The targetRef may be a URL, host, or IP. Try parsing in that order.
      // For URL/host targetRefs we MUST resolve DNS so platform private/
      // metadata-IP guards run on the final target — otherwise a tool action
      // against an internal hostname slips past SSRF defenses (codex P1).
      const target: ResolvedTarget = {
        toolName: input.toolName,
        toolCategory: input.toolCategory,
      };
      let withTarget: ResolvedTarget = target;
      let hostForDns: string | null = null;
      let ipFromLiteral: NormalizedIp | null = null;
      // codex iter-5 P2 — try IP literal FIRST (covers bare `::1` / IPv4
      // before normalizeUrl/normalizeHost reject the colon).
      const ipFirst = tryClassifyAsIp(input.targetRef);
      if (ipFirst !== null) {
        withTarget = {
          ...withTarget,
          host: ipFirst.canonical,
          hostIsIp: true,
          resolvedIps: [ipFirst],
          dnsResolution: 'not_applicable',
        };
        ipFromLiteral = ipFirst;
      } else {
        try {
          const url = normalizeUrl(input.targetRef);
          // codex iter-7 P1 — populate `protocol` for tool_invoke URL targets
          // so protocol allow/deny rules apply (mirror http_request branch).
          const urlProtocol: Protocol | null =
            url.scheme === 'https'
              ? 'https'
              : url.scheme === 'http'
                ? 'http'
                : url.scheme === 'ws'
                  ? 'ws'
                  : url.scheme === 'wss'
                    ? 'wss'
                    : null;
          withTarget = {
            ...withTarget,
            host: url.host,
            hostHasMixedScript: url.hostHasMixedScript,
            ...(url.hostIsIp ? { hostIsIp: true } : {}),
            url: url.canonical,
            path: url.path,
            ...(urlProtocol !== null ? { protocol: urlProtocol } : {}),
            ...(url.port !== undefined ? { port: url.port } : {}),
            ...(url.effectivePort !== undefined ? { effectivePort: url.effectivePort } : {}),
          };
          hostForDns = url.host;
        } catch {
          try {
            const host = normalizeHost(input.targetRef);
            withTarget = {
              ...withTarget,
              host: host.canonical,
              hostHasMixedScript: host.hasMixedScript,
            };
            hostForDns = host.canonical;
          } catch {
            // Leave targetRef opaque; engine will treat dimensions as absent.
          }
        }
      }
      if (hostForDns !== null) {
        // If the host is itself an IP literal (URL like `https://10.0.0.1/`),
        // synthesize resolvedIps from the literal; otherwise resolve through
        // the injected DNS resolver. Mirrors http_request/network branches.
        const hostAsIp = tryClassifyAsIp(hostForDns);
        if (hostAsIp) {
          withTarget = {
            ...withTarget,
            resolvedIps: [hostAsIp],
            dnsResolution: 'not_applicable',
          };
        } else {
          const resolved = await resolveHost(hostForDns, deps.dns);
          // codex iter-4 P1 — always populate dnsResolution sentinel so
          // decide() can distinguish "DNS attempted but empty" (fail-closed)
          // from "DNS not applicable" (raw IP).
          withTarget = {
            ...withTarget,
            resolvedIps: [...resolved],
            dnsResolution: resolved.length > 0 ? 'success' : 'failed',
          };
        }
      }
      // Suppress unused — kept for parity with previous shape.
      void ipFromLiteral;
      return { kind: 'tool_invoke', target: withTarget };
    }
    case 'cloud_call':
      return {
        kind: 'cloud_call',
        target: {
          cloudProvider: input.provider,
          cloudAccountId: input.accountId,
        },
      };
    case 'k8s_call':
      return {
        kind: 'k8s_call',
        target: {
          k8sCluster: input.cluster,
          k8sNamespace: input.namespace,
        },
      };
    case 'repo_op':
      return {
        kind: 'repo_op',
        target: {
          vcs: input.vcs,
          repoOwner: input.owner,
          repoName: input.name,
        },
      };
  }
};

export { normalizeHost } from './host.ts';
export { normalizeIp } from './ip.ts';
export { normalizeUrl } from './url.ts';
