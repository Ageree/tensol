import { z } from 'zod';

export const appEnvSchema = z.enum(['local', 'dev', 'staging', 'production', 'internal-lab']);
export type AppEnv = z.infer<typeof appEnvSchema>;

export const isNonLocal = (env: AppEnv): boolean => env !== 'local';

export const SESSION_SECRET_MIN_LENGTH = 32;

const { DEFAULT_TENANT_ID: envTenantId } = process.env;
export const DEFAULT_TENANT_ID = envTenantId ?? '00000000-0000-0000-0000-000000000001';
