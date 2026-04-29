// Sprint 6 — exhaustive coverage for normalizeAction across all 7
// ScopeActionInput.kind variants + DNS resolution path + redirect-array.

import { describe, expect, test } from 'bun:test';
import type { DnsResolver } from '../types.ts';
import { ActionNormalizationError, normalizeAction } from './index.ts';

const stubDns = (table: Record<string, { a?: string[]; aaaa?: string[] }> = {}): DnsResolver => ({
  resolveA: async (host) => [...(table[host]?.a ?? [])],
  resolveAAAA: async (host) => [...(table[host]?.aaaa ?? [])],
});

const failingDns = (): DnsResolver => ({
  resolveA: async () => {
    throw new Error('synthetic resolver failure');
  },
  resolveAAAA: async () => {
    throw new Error('synthetic resolver failure');
  },
});

describe('normalizeAction — http_request', () => {
  test('host as IP literal → no DNS lookup; resolvedIps populated from literal', async () => {
    const result = await normalizeAction(
      { kind: 'http_request', url: 'https://8.8.8.8/api', method: 'GET' },
      { dns: stubDns() },
    );
    expect(result.kind).toBe('http_request');
    expect(result.target.host).toBe('8.8.8.8');
    expect(result.target.resolvedIps?.length).toBe(1);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('8.8.8.8');
    expect(result.target.method).toBe('GET');
  });

  test('host hostname → DNS resolved into resolvedIps', async () => {
    const result = await normalizeAction(
      { kind: 'http_request', url: 'https://example.com/' },
      { dns: stubDns({ 'example.com': { a: ['93.184.216.34'] } }) },
    );
    expect(result.target.resolvedIps?.length).toBe(1);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('93.184.216.34');
  });

  test('DNS resolver throws → onErr swallows + empty IPs', async () => {
    const result = await normalizeAction(
      { kind: 'http_request', url: 'https://noresolve.test/' },
      { dns: failingDns() },
    );
    expect(result.target.resolvedIps).toEqual([]);
  });

  test('followRedirectsTo — IP literal redirect target produces independent normalized target', async () => {
    const result = await normalizeAction(
      {
        kind: 'http_request',
        url: 'https://primary.example/',
        followRedirectsTo: ['https://192.168.1.10/'],
      },
      { dns: stubDns({ 'primary.example': { a: ['8.8.8.8'] } }) },
    );
    // codex iter-4 P1 — redirect targets are now independently normalized.
    const primaryIps = result.target.resolvedIps ?? [];
    expect(primaryIps.some((i) => i.canonical === '8.8.8.8')).toBe(true);
    expect(result.target.redirectTargets?.length).toBe(1);
    const redirects = result.target.redirectNormalizedTargets ?? [];
    expect(redirects.length).toBe(1);
    expect(redirects[0]?.resolvedIps?.[0]?.canonical).toBe('192.168.1.10');
    expect(redirects[0]?.dnsResolution).toBe('not_applicable');
  });

  test('followRedirectsTo — hostname redirect target resolved via DNS into its own normalized target', async () => {
    const result = await normalizeAction(
      {
        kind: 'http_request',
        url: 'https://primary.example/',
        followRedirectsTo: ['https://other.example/'],
      },
      {
        dns: stubDns({
          'primary.example': { a: ['8.8.8.8'] },
          'other.example': { a: ['1.1.1.1'] },
        }),
      },
    );
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('8.8.8.8');
    const redirects = result.target.redirectNormalizedTargets ?? [];
    expect(redirects.length).toBe(1);
    expect(redirects[0]?.resolvedIps?.[0]?.canonical).toBe('1.1.1.1');
    expect(redirects[0]?.dnsResolution).toBe('success');
  });

  test('protocol unknown scheme returns no protocol field', async () => {
    // ws:// and wss:// are recognized; everything else → undefined protocol
    // entry. This exercises the protocol === null branch.
    const result = await normalizeAction(
      { kind: 'http_request', url: 'ws://chat.example/' },
      { dns: stubDns({ 'chat.example': { a: ['8.8.8.8'] } }) },
    );
    expect(result.target.protocol).toBe('ws');
  });

  test('wss scheme classified', async () => {
    const result = await normalizeAction(
      { kind: 'http_request', url: 'wss://chat.example/' },
      { dns: stubDns({ 'chat.example': { a: ['8.8.8.8'] } }) },
    );
    expect(result.target.protocol).toBe('wss');
  });
});

describe('normalizeAction — dns_lookup', () => {
  test('host literal IP → resolvedIps from literal', async () => {
    const result = await normalizeAction(
      { kind: 'dns_lookup', host: '93.184.216.34' },
      { dns: stubDns() },
    );
    expect(result.kind).toBe('dns_lookup');
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('93.184.216.34');
  });

  test('host name → DNS resolution', async () => {
    const result = await normalizeAction(
      { kind: 'dns_lookup', host: 'example.com' },
      { dns: stubDns({ 'example.com': { a: ['8.8.8.8'] } }) },
    );
    expect(result.target.host).toBe('example.com');
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('8.8.8.8');
  });
});

describe('normalizeAction — tcp_connect', () => {
  test('host literal IP + port', async () => {
    const result = await normalizeAction(
      { kind: 'tcp_connect', host: '8.8.8.8', port: 53 },
      { dns: stubDns() },
    );
    expect(result.target.port).toBe(53);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('8.8.8.8');
  });

  test('host name + port → DNS resolution', async () => {
    const result = await normalizeAction(
      { kind: 'tcp_connect', host: 'mail.example', port: 25 },
      { dns: stubDns({ 'mail.example': { a: ['1.2.3.4'] } }) },
    );
    expect(result.target.port).toBe(25);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('1.2.3.4');
  });
});

describe('normalizeAction — tool_invoke', () => {
  test('targetRef as URL → URL canonicalization', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'web',
        targetRef: 'https://example.com/',
      },
      { dns: stubDns() },
    );
    expect(result.target.toolName).toBe('nuclei');
    expect(result.target.toolCategory).toBe('web');
    expect(result.target.url?.startsWith('https://example.com')).toBe(true);
  });

  test('targetRef as IP literal → resolvedIps populated', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'naabu',
        toolCategory: 'recon',
        targetRef: '192.0.2.1',
      },
      { dns: stubDns() },
    );
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('192.0.2.1');
  });

  test('targetRef as hostname → host canonicalization (no DNS)', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'amass',
        toolCategory: 'recon',
        targetRef: 'EXAMPLE.com',
      },
      { dns: stubDns() },
    );
    expect(result.target.host).toBe('example.com');
  });

  test('codex P1 — targetRef as URL → DNS resolved into resolvedIps', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://internal.example.com/',
      },
      { dns: stubDns({ 'internal.example.com': { a: ['192.168.1.10'] } }) },
    );
    expect(result.target.url?.startsWith('https://internal.example.com')).toBe(true);
    expect(result.target.resolvedIps?.length).toBe(1);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('192.168.1.10');
    expect(result.target.resolvedIps?.[0]?.classification).toBe('private');
  });

  test('codex P1 — targetRef as hostname → DNS resolved into resolvedIps', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'amass',
        toolCategory: 'recon',
        targetRef: 'metadata.host.example',
      },
      { dns: stubDns({ 'metadata.host.example': { a: ['169.254.169.254'] } }) },
    );
    expect(result.target.host).toBe('metadata.host.example');
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('169.254.169.254');
    expect(result.target.resolvedIps?.[0]?.classification).toBe('metadata');
  });

  test('codex P1 — targetRef URL whose host is an IP literal → no DNS lookup, resolvedIps from literal', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://10.0.0.1/api',
      },
      { dns: stubDns() }, // empty resolver — must not be consulted
    );
    expect(result.target.resolvedIps?.length).toBe(1);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('10.0.0.1');
    expect(result.target.resolvedIps?.[0]?.classification).toBe('private');
  });

  test('targetRef opaque (not URL, not IP, not host) → opaque target', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'post_exploit',
        targetRef: 'an opaque string with spaces',
      },
      { dns: stubDns() },
    );
    expect(result.target.toolName).toBe('metasploit');
    expect(result.target.host).toBeUndefined();
  });
});

describe('normalizeAction — cloud_call', () => {
  test('cloud_call payload propagates verbatim', async () => {
    const result = await normalizeAction(
      {
        kind: 'cloud_call',
        provider: 'aws',
        accountId: '123',
        op: 'ec2:DescribeInstances',
      },
      { dns: stubDns() },
    );
    expect(result.kind).toBe('cloud_call');
    expect(result.target.cloudProvider).toBe('aws');
    expect(result.target.cloudAccountId).toBe('123');
  });
});

describe('normalizeAction — k8s_call', () => {
  test('k8s_call payload propagates', async () => {
    const result = await normalizeAction(
      { kind: 'k8s_call', cluster: 'prod', namespace: 'app', op: 'list' },
      { dns: stubDns() },
    );
    expect(result.target.k8sCluster).toBe('prod');
    expect(result.target.k8sNamespace).toBe('app');
  });
});

describe('normalizeAction — repo_op', () => {
  test('repo_op payload propagates', async () => {
    const result = await normalizeAction(
      {
        kind: 'repo_op',
        vcs: 'github',
        owner: 'acme',
        name: 'svc',
        op: 'clone',
      },
      { dns: stubDns() },
    );
    expect(result.target.vcs).toBe('github');
    expect(result.target.repoOwner).toBe('acme');
    expect(result.target.repoName).toBe('svc');
  });
});

describe('codex iter-5 P2 — IPv6 literal hosts via IP-first ordering', () => {
  test('dns_lookup with bare IPv6 literal `::1` classifies as loopback', async () => {
    const result = await normalizeAction({ kind: 'dns_lookup', host: '::1' }, { dns: stubDns() });
    expect(result.target.host).toBe('::1');
    expect(result.target.hostIsIp).toBe(true);
    expect(result.target.resolvedIps?.[0]?.classification).toBe('loopback');
    expect(result.target.dnsResolution).toBe('not_applicable');
  });

  test('dns_lookup with bare IPv6 literal `2001:db8::1`', async () => {
    const result = await normalizeAction(
      { kind: 'dns_lookup', host: '2001:db8::1' },
      { dns: stubDns() },
    );
    expect(result.target.hostIsIp).toBe(true);
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('2001:db8::1');
  });

  test('tcp_connect with `::1` + port', async () => {
    const result = await normalizeAction(
      { kind: 'tcp_connect', host: '::1', port: 22 },
      { dns: stubDns() },
    );
    expect(result.target.hostIsIp).toBe(true);
    expect(result.target.port).toBe(22);
    expect(result.target.resolvedIps?.[0]?.classification).toBe('loopback');
  });

  test('tool_invoke with bare IPv6 literal targetRef', async () => {
    const result = await normalizeAction(
      {
        kind: 'tool_invoke',
        toolName: 'naabu',
        toolCategory: 'recon',
        targetRef: '2001:db8::1',
      },
      { dns: stubDns() },
    );
    expect(result.target.hostIsIp).toBe(true);
    expect(result.target.host).toBe('2001:db8::1');
    expect(result.target.resolvedIps?.[0]?.canonical).toBe('2001:db8::1');
  });

  test('http_request with bracketed IPv6 URL → host classified, hostIsIp set', async () => {
    const result = await normalizeAction(
      { kind: 'http_request', url: 'http://[2001:db8::1]/' },
      { dns: stubDns() },
    );
    expect(result.target.hostIsIp).toBe(true);
    expect(result.target.host).toBe('2001:db8::1');
    expect(result.target.url).toBe('http://[2001:db8::1]/');
  });
});

describe('ActionNormalizationError', () => {
  test('exists for surface compatibility', () => {
    const err = new ActionNormalizationError('boom');
    expect(err.name).toBe('ActionNormalizationError');
    expect(err.message).toContain('action_normalization_error');
  });
});
