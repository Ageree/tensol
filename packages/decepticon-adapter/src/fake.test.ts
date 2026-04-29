// Sprint 8 — FakeDecepticonAdapter unit tests.

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeDecepticonAdapter } from './fake.ts';
import { createFsFixtureLoader } from './fixture-loader.ts';
import { NotImplementedError, type Opplan } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, '..', '..', '..', 'tests', 'fixtures', 'decepticon');

const buildOpplan = (assessmentId: string): Opplan => ({
  assessmentId,
  targets: ['http://localhost:9999/'],
  authorizedScope: ['http://localhost:9999/'],
  exclusions: [],
  testingWindow: { start: null, end: null },
  allowedTools: [],
  unavailableTools: [],
  engagementProfile: 'recon-only',
  foothold: false,
  postExploit: false,
  c2: false,
  ad: false,
});

const buildAdapter = (opts?: { scenario?: string; uuids?: string[]; clock?: string[] }) => {
  const loader = createFsFixtureLoader({ fixturesDir: FIXTURES_DIR });
  let uuidIdx = 0;
  let clockIdx = 0;
  return new FakeDecepticonAdapter({
    loader,
    defaultScenario: opts?.scenario ?? 'xss-reflected',
    sleep: (): Promise<void> => Promise.resolve(),
    randomUUID: opts?.uuids
      ? (): string => {
          const v = opts.uuids?.[uuidIdx++];
          if (!v) throw new Error('uuid_pool_exhausted');
          return v;
        }
      : (): string => crypto.randomUUID(),
    clockIso: opts?.clock
      ? (): string => {
          const v = opts.clock?.[clockIdx++];
          if (!v) throw new Error('clock_pool_exhausted');
          return v;
        }
      : (): string => new Date().toISOString(),
  });
};

describe('FakeDecepticonAdapter', () => {
  test('start() loads fixture, returns SessionHandle bound to the assessment', async () => {
    const adapter = buildAdapter();
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const assessmentId = '22222222-2222-2222-2222-222222222222';
    const handle = await adapter.start({ tenantId, opplan: buildOpplan(assessmentId) });
    expect(handle.tenantId).toBe(tenantId);
    expect(handle.assessmentId).toBe(assessmentId);
    expect(typeof handle.sessionId).toBe('string');
    expect(handle.sessionId.length).toBeGreaterThan(10);
    expect(typeof handle.startedAt).toBe('string');
  });

  test('streamStatus() yields full timeline ending in `completed` for happy path', async () => {
    const adapter = buildAdapter();
    const handle = await adapter.start({
      tenantId: '11111111-1111-1111-1111-111111111111',
      opplan: buildOpplan('22222222-2222-2222-2222-222222222222'),
    });
    const events = [];
    for await (const e of adapter.streamStatus(handle.sessionId)) events.push(e);
    expect(events.map((e) => e.status)).toEqual([
      'started',
      'planning',
      'recon',
      'exploit',
      'reporting',
      'completed',
    ]);
    expect(events.every((e) => e.sessionId === handle.sessionId)).toBe(true);
  });

  test('streamCandidates() yields exactly one xss_reflected candidate', async () => {
    const adapter = buildAdapter();
    const handle = await adapter.start({
      tenantId: '11111111-1111-1111-1111-111111111111',
      opplan: buildOpplan('22222222-2222-2222-2222-222222222222'),
    });
    const candidates = [];
    for await (const c of adapter.streamCandidates(handle.sessionId)) candidates.push(c);
    expect(candidates.length).toBe(1);
    const first = candidates[0];
    if (!first) throw new Error('expected candidate');
    expect(first.type).toBe('xss_reflected');
    expect(first.severity).toBe('high');
    expect(first.affectedUrl).toBe('http://localhost:9999/xss?q=');
    expect(first.payload.parameter).toBe('q');
  });

  test('crash fixture marks failed + appends `failed` status event', async () => {
    const adapter = buildAdapter({ scenario: 'xss-reflected-crash' });
    const handle = await adapter.start({
      tenantId: '11111111-1111-1111-1111-111111111111',
      opplan: buildOpplan('22222222-2222-2222-2222-222222222222'),
    });
    expect(adapter.hasFailed(handle.sessionId)).toBe(true);
    expect(adapter.finalStatus(handle.sessionId)).toBe('failed');
    const events = [];
    for await (const e of adapter.streamStatus(handle.sessionId)) events.push(e);
    expect(events[events.length - 1]?.status).toBe('failed');
    // Crash at recon → no candidates emitted.
    const cands = [];
    for await (const c of adapter.streamCandidates(handle.sessionId)) cands.push(c);
    expect(cands.length).toBe(0);
  });

  test('two parallel sessions in different tenants do not cross-talk', async () => {
    const adapter = buildAdapter();
    const t1 = '11111111-1111-1111-1111-111111111111';
    const t2 = '33333333-3333-3333-3333-333333333333';
    const a1 = '22222222-2222-2222-2222-222222222222';
    const a2 = '44444444-4444-4444-4444-444444444444';
    const [h1, h2] = await Promise.all([
      adapter.start({ tenantId: t1, opplan: buildOpplan(a1) }),
      adapter.start({ tenantId: t2, opplan: buildOpplan(a2) }),
    ]);
    expect(h1.sessionId).not.toBe(h2.sessionId);
    const c1: string[] = [];
    for await (const c of adapter.streamCandidates(h1.sessionId)) c1.push(c.sessionId);
    const c2: string[] = [];
    for await (const c of adapter.streamCandidates(h2.sessionId)) c2.push(c.sessionId);
    expect(c1.every((id) => id === h1.sessionId)).toBe(true);
    expect(c2.every((id) => id === h2.sessionId)).toBe(true);
    expect(c1.length).toBe(1);
    expect(c2.length).toBe(1);
  });

  test('streamStatus on unknown session throws NotImplementedError sentinel', () => {
    const adapter = buildAdapter();
    expect(() => adapter.streamStatus('00000000-0000-0000-0000-000000000000')).toThrow(
      NotImplementedError,
    );
  });

  test('pause/resume/stop/exportArtifacts no-ops compile + run', async () => {
    const adapter = buildAdapter();
    const handle = await adapter.start({
      tenantId: '11111111-1111-1111-1111-111111111111',
      opplan: buildOpplan('22222222-2222-2222-2222-222222222222'),
    });
    await expect(adapter.pause(handle.sessionId)).resolves.toBeUndefined();
    await expect(adapter.resume(handle.sessionId)).resolves.toBeUndefined();
    await expect(adapter.stop(handle.sessionId)).resolves.toBeUndefined();
    const artifacts = await adapter.exportArtifacts(handle.sessionId);
    expect(artifacts.length).toBe(0);
  });
});
