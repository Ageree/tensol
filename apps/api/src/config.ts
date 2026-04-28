// apps/api auth config — Sprint 3 contracts C13b (BCRYPT_COST gate) + C19
// (cookie env-aware behaviour) + C21a (BOOTSTRAP_TOKEN strength) + C22
// (SESSION_SECRET min length, already enforced in packages/config).
//
// This loader extends the base packages/config schema with a small set of
// auth-only env knobs. It runs the C13b boot-time fail-fast gate: any
// non-`local` APP_ENV with BCRYPT_COST < 10 aborts boot via ConfigValidationError.

import {
  BCRYPT_DEFAULT_COST,
  BCRYPT_MIN_COST_NON_LOCAL,
  defaultBcryptCostForEnv,
} from '@cyberstrike/authz';
import {
  type AppEnv,
  ConfigValidationError,
  baseConfigSchema,
  loadConfig,
} from '@cyberstrike/config';
import { z } from 'zod';

const BOOTSTRAP_MIN_BYTES = 32;
const BOOTSTRAP_MIN_HEX_CHARS = BOOTSTRAP_MIN_BYTES * 2;

const authEnvShape = z.object({
  BCRYPT_COST: z.string().regex(/^\d+$/, 'BCRYPT_COST must be a positive integer').optional(),
  BOOTSTRAP_TOKEN: z.string().min(1).optional(),
  COOKIE_NAME_OVERRIDE: z.string().min(1).optional(),
});

export interface AuthApiConfig {
  readonly appEnv: AppEnv;
  readonly bcryptCost: number;
  readonly bootstrapToken: string | undefined;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly sessionSecret: string;
  readonly databaseUrl: string;
}

const cookieNameForEnv = (appEnv: AppEnv): string =>
  appEnv === 'local' ? 'cs_session' : '__Host-cs_session';

const cookieSecureForEnv = (appEnv: AppEnv): boolean => appEnv !== 'local';

const isNonLocal = (appEnv: AppEnv): boolean => appEnv !== 'local';

export const loadAuthApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<
    Record<string, string | undefined>
  >,
): AuthApiConfig => {
  // Base schema gives us appEnv + sessionSecret + databaseUrl (strict in non-local).
  const base = loadConfig(baseConfigSchema, env);

  const auth = authEnvShape.parse(env);

  const defaultCost = defaultBcryptCostForEnv(base.appEnv);
  const requestedCost = auth.BCRYPT_COST ? Number.parseInt(auth.BCRYPT_COST, 10) : defaultCost;

  // C13b — boot fail-fast in non-local environments.
  if (isNonLocal(base.appEnv) && requestedCost < BCRYPT_MIN_COST_NON_LOCAL) {
    throw new ConfigValidationError([
      {
        path: ['BCRYPT_COST'],
        message: `BCRYPT_COST=${requestedCost} below minimum ${BCRYPT_MIN_COST_NON_LOCAL} for env ${base.appEnv}`,
      },
    ]);
  }

  // C13b — sanity bounds (mirrors createBcryptHasher).
  if (requestedCost < 4 || requestedCost > 16) {
    throw new ConfigValidationError([
      {
        path: ['BCRYPT_COST'],
        message: `BCRYPT_COST must be in [4, 16] (got ${requestedCost})`,
      },
    ]);
  }

  // C21a — BOOTSTRAP_TOKEN strength gate (non-local).
  if (isNonLocal(base.appEnv)) {
    if (!auth.BOOTSTRAP_TOKEN) {
      throw new ConfigValidationError([
        {
          path: ['BOOTSTRAP_TOKEN'],
          message: `BOOTSTRAP_TOKEN required in env ${base.appEnv}`,
        },
      ]);
    }
    if (auth.BOOTSTRAP_TOKEN.length < BOOTSTRAP_MIN_HEX_CHARS) {
      throw new ConfigValidationError([
        {
          path: ['BOOTSTRAP_TOKEN'],
          message: `BOOTSTRAP_TOKEN must be ≥${BOOTSTRAP_MIN_HEX_CHARS} chars (≥${BOOTSTRAP_MIN_BYTES} bytes) in env ${base.appEnv}`,
        },
      ]);
    }
  }

  return Object.freeze({
    appEnv: base.appEnv,
    bcryptCost: requestedCost,
    bootstrapToken: auth.BOOTSTRAP_TOKEN,
    cookieName: auth.COOKIE_NAME_OVERRIDE ?? cookieNameForEnv(base.appEnv),
    cookieSecure: cookieSecureForEnv(base.appEnv),
    sessionSecret: base.sessionSecret,
    databaseUrl: base.database.url,
  });
};

export {
  BCRYPT_DEFAULT_COST,
  BCRYPT_MIN_COST_NON_LOCAL,
  BOOTSTRAP_MIN_BYTES,
  BOOTSTRAP_MIN_HEX_CHARS,
  cookieNameForEnv,
  cookieSecureForEnv,
};
