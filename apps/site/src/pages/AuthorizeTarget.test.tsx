import { describe, expect, it } from 'bun:test';
import { copyToClipboard, pollOnce } from '../lib/authorize-api.ts';
import type { ApiResponse, AuthStatusData, ChallengeData } from '../lib/authorize-api.ts';
import { reducer } from './AuthorizeTarget.tsx';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseState = {
  step: 1 as const,
  method: null,
  challenge: null,
  verifyState: 'idle' as const,
  errorReason: null,
  copiedDnsName: false,
  copiedDnsValue: false,
  copiedFileUrl: false,
  copiedFileBody: false,
};

const fakeChallenge: ChallengeData = {
  id: 'ch-1',
  method: 'dns_txt',
  status: 'pending',
  expiresAt: '2099-01-01T00:00:00Z',
  instructions: {
    kind: 'dns_txt',
    txtRecord: { name: '_tensol.example.com', value: 'tensol-verify=abc123' },
  },
};

// ─── Case 1: pickMethod ────────────────────────────────────────────────────────

describe('reducer — pickMethod', () => {
  it('sets method and clears errorReason', () => {
    const s = reducer(
      { ...baseState, errorReason: 'previous_error' },
      { type: 'pickMethod', method: 'dns_txt' },
    );
    expect(s.method).toBe('dns_txt');
    expect(s.errorReason).toBeNull();
    expect(s.step).toBe(1);
  });
});

// ─── Case 4: startSuccess / startFailure ──────────────────────────────────────

describe('reducer — startSuccess', () => {
  it('advances to step 2 and stores challenge', () => {
    const s = reducer(
      { ...baseState, method: 'dns_txt' },
      { type: 'startSuccess', challenge: fakeChallenge },
    );
    expect(s.step).toBe(2);
    expect(s.challenge).toEqual(fakeChallenge);
    expect(s.errorReason).toBeNull();
  });
});

describe('reducer — startFailure', () => {
  it('stores errorReason without advancing step', () => {
    const s = reducer(baseState, { type: 'startFailure', reason: 'too_many_attempts' });
    expect(s.step).toBe(1);
    expect(s.errorReason).toBe('too_many_attempts');
  });
});

// ─── Case 5: goBack ───────────────────────────────────────────────────────────

describe('reducer — goBack', () => {
  it('decrements step and resets verifyState', () => {
    const s = reducer(
      { ...baseState, step: 2, verifyState: 'failure', errorReason: 'e' },
      { type: 'goBack' },
    );
    expect(s.step).toBe(1);
    expect(s.verifyState).toBe('idle');
    expect(s.errorReason).toBeNull();
  });

  it('stays at step 1 when already at step 1', () => {
    const s = reducer(baseState, { type: 'goBack' });
    expect(s.step).toBe(1);
  });
});

// ─── Case 6: verifySuccess ───────────────────────────────────────────────────

describe('reducer — verifySuccess / verifyFailure', () => {
  it('verifySuccess advances to step 3 with success state', () => {
    const s = reducer({ ...baseState, step: 2, verifyState: 'loading' }, { type: 'verifySuccess' });
    expect(s.step).toBe(3);
    expect(s.verifyState).toBe('success');
  });

  it('verifyFailure stores reason without advancing step', () => {
    const s = reducer(
      { ...baseState, step: 2, verifyState: 'loading' },
      { type: 'verifyFailure', reason: 'token_mismatch' },
    );
    expect(s.step).toBe(2);
    expect(s.verifyState).toBe('failure');
    expect(s.errorReason).toBe('token_mismatch');
  });
});

// ─── Case 8: setCopied ───────────────────────────────────────────────────────

describe('reducer — setCopied', () => {
  it('sets copiedDnsName true then false', () => {
    const s1 = reducer(baseState, { type: 'setCopied', field: 'dnsName', value: true });
    expect(s1.copiedDnsName).toBe(true);
    const s2 = reducer(s1, { type: 'setCopied', field: 'dnsName', value: false });
    expect(s2.copiedDnsName).toBe(false);
  });
});

// ─── Case 9: immutability ────────────────────────────────────────────────────

describe('reducer — immutability', () => {
  it('returns a new object reference', () => {
    const s = reducer(baseState, { type: 'pickMethod', method: 'file_upload' });
    expect(s).not.toBe(baseState);
  });
});

// ─── Case 3: copyToClipboard ─────────────────────────────────────────────────

describe('copyToClipboard', () => {
  it('calls writeText, invokes onCopied immediately, invokes onReset after 1500ms', async () => {
    const written: string[] = [];
    const originalClipboard = globalThis.navigator.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (t: string) => {
          written.push(t);
        },
      },
      configurable: true,
      writable: true,
    });

    const copiedCalls: number[] = [];
    const resetCalls: number[] = [];
    await copyToClipboard(
      'hello',
      () => copiedCalls.push(1),
      () => resetCalls.push(1),
    );

    expect(written).toEqual(['hello']);
    expect(copiedCalls).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 1600));
    expect(resetCalls).toHaveLength(1);

    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    }
  });
});

// ─── Case 2/7: pollOnce ──────────────────────────────────────────────────────

describe('pollOnce', () => {
  it('dispatches verifySuccess when authorizedTargetVerified=true', async () => {
    const mockStatus = async (_id: string): Promise<ApiResponse<AuthStatusData>> => ({
      data: { authorizedTargetVerified: true, attempts: [] },
    });
    const dispatched: { type: string }[] = [];
    await pollOnce(mockStatus, 'tgt-1', (a) => dispatched.push(a));
    expect(dispatched).toEqual([{ type: 'verifySuccess' }]);
  });

  it('does not dispatch when authorizedTargetVerified=false', async () => {
    const mockStatus = async (_id: string): Promise<ApiResponse<AuthStatusData>> => ({
      data: { authorizedTargetVerified: false, attempts: [] },
    });
    const dispatched: { type: string }[] = [];
    await pollOnce(mockStatus, 'tgt-2', (a) => dispatched.push(a));
    expect(dispatched).toHaveLength(0);
  });
});
