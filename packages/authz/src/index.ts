// Public surface for packages/authz.
// Sprint 1 invariant A18: `name` MUST equal the workspace key.

export const name = 'packages/authz' as const;

export { ACTIONS, type Action, actionSchema } from './actions.ts';
export type { Actor, ServiceActor, UserActor } from './actor.ts';
export { assertCan } from './assert-can.ts';
export { type Decision, type RoleResourceActionKey, buildKey } from './decision.ts';
export { AuthError, MfaError, RateLimitError, RbacDenyError } from './errors.ts';
export { RBAC_MATRIX, lookupDecision } from './matrix.ts';
export {
  type IssuedResetToken,
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TOKEN_HEX_LENGTH,
  PASSWORD_RESET_TTL_MS,
  generateResetToken,
  hashResetToken,
} from './password-reset.ts';
export {
  BCRYPT_DEFAULT_COST,
  BCRYPT_MIN_COST_NON_LOCAL,
  type BcryptHasherOptions,
  type PasswordHasher,
  createBcryptHasher,
  defaultBcryptCostForEnv,
} from './passwords.ts';
export { RESOURCES, type Resource, resourceSchema } from './resources.ts';
export { ROLES, type Role, isRole, roleSchema } from './roles.ts';
export {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  TOTP_VERIFICATION_WINDOW,
  type TotpVerifier,
  type TotpVerifyOptions,
  createTotpVerifier,
  requireValidTotp,
} from './totp.ts';
