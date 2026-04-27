import type { ZodTypeAny, z } from 'zod';
import { type DeepReadonly, deepFreeze } from './deep-freeze.ts';
import { type ConfigIssue, ConfigValidationError } from './errors.ts';

export const name = 'packages/config' as const;

export { ConfigValidationError } from './errors.ts';
export type { ConfigIssue } from './errors.ts';
export { baseConfigSchema, type AppConfig } from './base-schema.ts';
export { appEnvSchema, type AppEnv, SESSION_SECRET_MIN_LENGTH } from './app-env.ts';
export { deepFreeze, type DeepReadonly } from './deep-freeze.ts';

export type EnvSource = Readonly<Record<string, string | undefined>>;

const toIssues = (zodIssues: ReadonlyArray<z.ZodIssue>): ReadonlyArray<ConfigIssue> =>
  zodIssues.map((i) => ({ path: [...i.path], message: i.message }));

export const loadConfig = <S extends ZodTypeAny>(
  schema: S,
  env: EnvSource = process.env as EnvSource,
): DeepReadonly<z.output<S>> => {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(toIssues(result.error.issues));
  }
  return deepFreeze(result.data) as DeepReadonly<z.output<S>>;
};
