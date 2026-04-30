export class LoginFailedError extends Error {
  override readonly name = 'LoginFailedError';
}

export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
