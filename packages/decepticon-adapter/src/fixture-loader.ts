// Sprint 8 — fixture loader for FakeDecepticonAdapter.
//
// Reads `<scenario>.json` from a configurable fixturesDir, validates with
// zod, returns a normalised PlaybackPlan. The fixture format is a closed
// shape: status timeline + candidate list + optional crash trigger.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CANDIDATE_TYPES, SESSION_STATUSES, SEVERITIES } from './types.ts';

const fixtureStatusEventSchema = z
  .object({
    status: z.enum(SESSION_STATUSES),
    delayMs: z.number().int().min(0).max(60_000).default(0),
    detail: z.record(z.unknown()).optional(),
  })
  .strict();

const fixtureCandidateSchema = z
  .object({
    type: z.enum(CANDIDATE_TYPES),
    severity: z.enum(SEVERITIES),
    affectedUrl: z.string().min(1),
    source: z.string().min(1).default('decepticon'),
    payload: z.record(z.unknown()),
    afterStatus: z.enum(SESSION_STATUSES).default('exploit'),
  })
  .strict();

export const fixtureSchema = z
  .object({
    scenario: z.string().min(1),
    description: z.string().min(1),
    statusTimeline: z.array(fixtureStatusEventSchema).min(1),
    candidates: z.array(fixtureCandidateSchema),
    /** Optional crash injection — adapter throws after this status step. */
    simulateCrashAt: z.enum(SESSION_STATUSES).optional(),
    /** Optional time-scaling — multiply every delayMs (default 1; tests use 0). */
    timeScale: z.number().min(0).max(100).default(1),
  })
  .strict();

export type FixtureDefinition = z.infer<typeof fixtureSchema>;

export interface FixtureLoader {
  load(scenario: string): Promise<FixtureDefinition>;
}

export interface FsFixtureLoaderDeps {
  readonly fixturesDir: string;
  /** Test seam — defaults to `node:fs/promises#readFile`. */
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export const createFsFixtureLoader = (deps: FsFixtureLoaderDeps): FixtureLoader => {
  const reader = deps.readFile ?? ((p: string, enc: 'utf8') => readFile(p, enc));
  return {
    load: async (scenario: string): Promise<FixtureDefinition> => {
      if (!SAFE_NAME.test(scenario)) {
        throw new Error(`unsafe_fixture_name: ${scenario}`);
      }
      const file = path.join(deps.fixturesDir, `${scenario}.json`);
      const raw = await reader(file, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`fixture_json_parse_failed: ${(e as Error).message}`);
      }
      const result = fixtureSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`fixture_schema_invalid: ${result.error.message}`);
      }
      return result.data;
    },
  };
};
