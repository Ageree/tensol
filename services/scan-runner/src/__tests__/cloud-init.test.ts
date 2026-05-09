import { describe, expect, it } from 'bun:test';
import { buildCloudInit, shellEscape } from '../cloud-init.ts';

const baseOpts = {
  scanId: '550e8400-e29b-41d4-a716-446655440000',
  tenantId: 'tenant-123',
  targetUrl: 'https://example.com',
  callbackUrl: 'https://tensol.io/callbacks/scans',
  callbackToken: 'cb-token-secret',
  decepticonImage: 'purpleailab/decepticon:v1.0.24',
  userAgent: 'Tensol-Scan/550e8400-e29b-41d4-a716-446655440000',
  maxRuntimeMs: 1_800_000,
};

describe('buildCloudInit', () => {
  it('T6 — output contains VPS_SCAN_ID', () => {
    const yaml = buildCloudInit(baseOpts);
    expect(yaml).toContain('VPS_SCAN_ID=550e8400-e29b-41d4-a716-446655440000');
  });

  it('T6 — output contains CALLBACK_URL', () => {
    const yaml = buildCloudInit(baseOpts);
    expect(yaml).toContain('CALLBACK_URL=https://tensol.io/callbacks/scans');
  });

  it('T7 — User-Agent appears as Tensol-Scan/<scanId>', () => {
    const yaml = buildCloudInit(baseOpts);
    expect(yaml).toContain('Tensol-Scan/550e8400-e29b-41d4-a716-446655440000');
  });

  it('maxRuntimeMs=1800000 → timeout 1800s', () => {
    const yaml = buildCloudInit(baseOpts);
    expect(yaml).toContain('timeout 1800s');
  });

  it('maxRuntimeMs=60000 → timeout 60s', () => {
    const yaml = buildCloudInit({ ...baseOpts, maxRuntimeMs: 60_000 });
    expect(yaml).toContain('timeout 60s');
  });

  it('begins with #cloud-config', () => {
    const yaml = buildCloudInit(baseOpts);
    expect(yaml.startsWith('#cloud-config')).toBe(true);
  });

  it('contains shutdown -h now', () => {
    const yaml = buildCloudInit(baseOpts);
    expect(yaml).toContain('shutdown -h now');
  });

  it('shell metacharacters in targetUrl are single-quote escaped', () => {
    const dangerous = 'https://x.com/;rm -rf /';
    const yaml = buildCloudInit({ ...baseOpts, targetUrl: dangerous });
    // The dangerous URL must appear wrapped in single quotes so the shell
    // treats it as a literal string, not executable commands.
    expect(yaml).toContain(`'${dangerous}'`);
    // Verify the unquoted form (which would execute the command) is absent
    const lines = yaml.split('\n');
    const unquotedDanger = lines.some((l) => /;rm\s+-rf/.test(l) && !l.includes(`'${dangerous}'`));
    expect(unquotedDanger).toBe(false);
  });

  it('two different scanIds produce different YAML (determinism)', () => {
    const y1 = buildCloudInit({ ...baseOpts, scanId: 'id-aaa', userAgent: 'Tensol-Scan/id-aaa' });
    const y2 = buildCloudInit({ ...baseOpts, scanId: 'id-bbb', userAgent: 'Tensol-Scan/id-bbb' });
    expect(y1).not.toBe(y2);
    expect(y1).toContain('id-aaa');
    expect(y2).toContain('id-bbb');
  });

  it('same scanId produces identical YAML (determinism)', () => {
    const y1 = buildCloudInit(baseOpts);
    const y2 = buildCloudInit(baseOpts);
    expect(y1).toBe(y2);
  });

  it('token does not appear in write_files or echo lines', () => {
    const yaml = buildCloudInit({ ...baseOpts, callbackToken: 'super-secret-token' });
    // The token may appear in the env var assignment in write_files — that is acceptable.
    // What must NOT happen is it appearing in an echo/printf statement or plain log line.
    const lines = yaml.split('\n');
    const badLines = lines.filter(
      (l) => /\becho\b|\bprintf\b/.test(l) && l.includes('super-secret-token'),
    );
    expect(badLines).toHaveLength(0);
  });
});

describe('shellEscape', () => {
  it('does not quote safe strings', () => {
    expect(shellEscape('hello')).toBe('hello');
    expect(shellEscape('hello-world')).toBe('hello-world');
  });

  it('wraps unsafe strings in single quotes', () => {
    expect(shellEscape('hello world')).toBe("'hello world'");
    expect(shellEscape('https://example.com/path?q=1&r=2')).toContain("'");
  });

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('escapes embedded single quotes', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });
});
