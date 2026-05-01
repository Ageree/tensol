import { z } from 'zod';

export const appEnvSchema = z.enum(['local', 'dev', 'staging', 'production', 'internal-lab']);
export type AppEnv = z.infer<typeof appEnvSchema>;

export const NON_LOCAL_ENVS: ReadonlyArray<AppEnv> = [
  'dev',
  'staging',
  'production',
  'internal-lab',
];

export const isNonLocal = (env: AppEnv): boolean => env !== 'local';

export const SESSION_SECRET_MIN_LENGTH = 32;

export const DEFAULT_TENANT_ID =
  process.env['DEFAULT_TENANT_ID'] ?? '00000000-0000-0000-0000-000000000001';
