// Sprint 3 contract C13/C13b — bcrypt password hashing.
//
// Implementation uses `Bun.password` (Bun's native bcrypt implementation —
// no node-gyp build, no shared-library dependency). Cost is configurable
// via the constructor; the route layer reads `BCRYPT_COST` from packages/config
// and passes it in. C13b boot-time gate (`BCRYPT_COST < 10` aborts non-local
// boot) is enforced in `apps/api/src/config.ts`.

import { AuthError } from './errors.ts';

export const BCRYPT_MIN_COST_NON_LOCAL = 10 as const;
export const BCRYPT_DEFAULT_COST = 12 as const;

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
  /**
   * Constant-time dummy work that runs in the same time envelope as a real
   * verify. Used by the login route to flatten user-existence timing
   * (Sprint 3 C26 R7 — also reused by the failed-login path).
   */
  dummyVerify(plain: string): Promise<void>;
}

export interface BcryptHasherOptions {
  readonly cost: number;
}

class BcryptHasher implements PasswordHasher {
  private readonly cost: number;

  constructor(options: BcryptHasherOptions) {
    if (!Number.isInteger(options.cost)) {
      throw new AuthError('bcrypt cost must be an integer', 'invalid_bcrypt_cost');
    }
    if (options.cost < 4 || options.cost > 16) {
      throw new AuthError('bcrypt cost must be in [4, 16]', 'invalid_bcrypt_cost');
    }
    this.cost = options.cost;
  }

  async hash(plain: string): Promise<string> {
    if (plain.length === 0) {
      throw new AuthError('password must be non-empty', 'empty_password');
    }
    return await Bun.password.hash(plain, { algorithm: 'bcrypt', cost: this.cost });
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    if (plain.length === 0 || hash.length === 0) return false;
    try {
      return await Bun.password.verify(plain, hash);
    } catch {
      return false;
    }
  }

  async dummyVerify(plain: string): Promise<void> {
    // Hash a constant string at the same cost so the wall-clock time matches
    // a real verify against an existing user. Result is discarded.
    await Bun.password.hash(plain.length === 0 ? 'dummy' : plain, {
      algorithm: 'bcrypt',
      cost: this.cost,
    });
  }
}

export const createBcryptHasher = (options: BcryptHasherOptions): PasswordHasher =>
  new BcryptHasher(options);

/**
 * Resolve the default bcrypt cost for an APP_ENV. Used by `apps/api/src/config.ts`
 * to apply per-env defaults BEFORE the user-provided BCRYPT_COST overrides.
 *
 * Defaults per Sprint 3 C13b:
 *   local         → 4   (fast tests)
 *   dev           → 10
 *   staging       → 10
 *   internal-lab  → 10
 *   production    → 12
 */
export const defaultBcryptCostForEnv = (
  appEnv: 'local' | 'dev' | 'staging' | 'production' | 'internal-lab',
): number => {
  if (appEnv === 'local') return 4;
  if (appEnv === 'production') return 12;
  return 10;
};
