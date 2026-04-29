import { describe, expect, test } from 'bun:test';
import { SCOPE_ACTION_KINDS, scopeActionInputSchema } from './scope-action.ts';

describe('contracts :: scope-action DTO', () => {
  test('SCOPE_ACTION_KINDS = 7 entries', () => {
    expect(SCOPE_ACTION_KINDS.length).toBe(7);
    expect(new Set(SCOPE_ACTION_KINDS).size).toBe(7);
  });

  test('http_request — accepts well-formed', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'http_request',
        url: 'https://example.com/api/v1/users',
        method: 'GET',
      }).success,
    ).toBe(true);
  });

  test('http_request — accepts followRedirectsTo list', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'http_request',
        url: 'https://example.com/r',
        followRedirectsTo: ['https://example.com/final'],
      }).success,
    ).toBe(true);
  });

  test('http_request — rejects non-URL', () => {
    expect(
      scopeActionInputSchema.safeParse({ kind: 'http_request', url: 'not a url' }).success,
    ).toBe(false);
  });

  test('http_request — rejects unknown method', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'http_request',
        url: 'https://x.io/',
        method: 'CONNECT',
      }).success,
    ).toBe(false);
  });

  test('dns_lookup — accepts host', () => {
    expect(scopeActionInputSchema.safeParse({ kind: 'dns_lookup', host: 'x.io' }).success).toBe(
      true,
    );
  });

  test('tcp_connect — port range enforced', () => {
    expect(
      scopeActionInputSchema.safeParse({ kind: 'tcp_connect', host: 'x.io', port: 0 }).success,
    ).toBe(false);
    expect(
      scopeActionInputSchema.safeParse({ kind: 'tcp_connect', host: 'x.io', port: 65536 }).success,
    ).toBe(false);
    expect(
      scopeActionInputSchema.safeParse({ kind: 'tcp_connect', host: 'x.io', port: 443 }).success,
    ).toBe(true);
  });

  test('tool_invoke — R7: rejects category outside TOOL_CATEGORIES', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'tool_invoke',
        toolName: 'metasploit',
        toolCategory: 'phishing',
        targetRef: 'https://x.io/',
      }).success,
    ).toBe(false);
  });

  test('tool_invoke — accepts valid category', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'tool_invoke',
        toolName: 'nuclei',
        toolCategory: 'recon',
        targetRef: 'https://x.io/',
      }).success,
    ).toBe(true);
  });

  test('cloud_call — provider closed set', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'cloud_call',
        provider: 'oracle',
        accountId: 'a',
        op: 'list',
      }).success,
    ).toBe(false);
  });

  test('k8s_call — namespace ≤ 63 chars (RFC 1123)', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'k8s_call',
        cluster: 'c',
        namespace: 'a'.repeat(64),
        op: 'list',
      }).success,
    ).toBe(false);
  });

  test('repo_op — vcs closed set', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'repo_op',
        vcs: 'sourcehut',
        owner: 'a',
        name: 'b',
        op: 'clone',
      }).success,
    ).toBe(false);
  });

  test('rejects extra keys (.strict)', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'dns_lookup',
        host: 'x.io',
        bonus: true,
      }).success,
    ).toBe(false);
  });

  test('rejects unknown kind', () => {
    expect(scopeActionInputSchema.safeParse({ kind: 'magic', host: 'x' }).success).toBe(false);
  });

  test('codex iter-4 P2 — http_request rejects ftp scheme', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'http_request',
        url: 'ftp://example.com/',
      }).success,
    ).toBe(false);
  });

  test('codex iter-4 P2 — http_request rejects gopher / file / data schemes', () => {
    for (const url of ['gopher://example.com/', 'file:///etc/passwd', 'data:text/html,<script>']) {
      expect(scopeActionInputSchema.safeParse({ kind: 'http_request', url }).success).toBe(false);
    }
  });

  test('codex iter-4 P2 — http_request accepts http/https/ws/wss', () => {
    for (const url of [
      'http://example.com/',
      'https://example.com/',
      'ws://example.com/',
      'wss://example.com/',
    ]) {
      expect(scopeActionInputSchema.safeParse({ kind: 'http_request', url }).success).toBe(true);
    }
  });

  test('codex iter-4 P2 — followRedirectsTo entries also restricted to allowed schemes', () => {
    expect(
      scopeActionInputSchema.safeParse({
        kind: 'http_request',
        url: 'https://example.com/',
        followRedirectsTo: ['ftp://example.com/'],
      }).success,
    ).toBe(false);
  });
});
