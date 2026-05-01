export const name = 'packages/browser-auth' as const;
export { CredentialSchema, type Credential } from './credential-schema.ts';
export {
  LoginRecipeSchema,
  RecipeStepSchema,
  type LoginRecipe,
  type RecipeStep,
} from './recipe-schema.ts';
export {
  executeRecipe,
  type AuthCookieResult,
  type ExecutorContext,
  type ExecutorPage,
  type LoginResult,
} from './executor.ts';
export { encryptCredential, parseKek, type EncryptedBlob } from './encrypt-shim.ts';
export { ConfigError, DecryptionError, LoginFailedError } from './errors.ts';
