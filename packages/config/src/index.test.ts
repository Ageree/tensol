import { describe, expect, test } from 'bun:test';
import { ConfigValidationError, baseConfigSchema, loadConfig } from './index.ts';

const VALID_SECRET = 'a'.repeat(32);
const SHORT_SECRET = 'a'.repeat(31);

const fullStagingEnv = {
  APP_ENV: 'staging',
  DATABASE_URL: 'postgres://cs:cs@host:5432/cyberstrike',
  OBJECT_STORAGE_ENDPOINT: 'https://storage.example',
  OBJECT_STORAGE_ACCESS_KEY: 'access-key',
  OBJECT_STORAGE_SECRET_KEY: 'secret-key',
  OBJECT_STORAGE_BUCKET: 'cs-bucket',
  QUEUE_ADAPTER: 'local',
  DECEPTICON_ADAPTER: 'fake',
  SESSION_SECRET: VALID_SECRET,
};

describe('packages/config :: name export', () => {
  test('A18 — name equals workspace directory key', async () => {
    const mod = await import('./index.ts');
    expect(mod.name).toBe('packages/config');
  });
});

describe('packages/config :: loadConfig (A12)', () => {
  test('A12 — APP_ENV=local with no other keys returns defaults, no throw', () => {
    const config = loadConfig(baseConfigSchema, { APP_ENV: 'local' });
    expect(config.appEnv).toBe('local');
    expect(config.queue.adapter).toBe('local');
    expect(config.decepticon.adapter).toBe('fake');
  });
});

describe('packages/config :: loadConfig (A13 fail-fast in non-local)', () => {
  test('A13 — staging missing DATABASE_URL throws ConfigValidationError', () => {
    const { DATABASE_URL: _omit, ...rest } = fullStagingEnv;
    expect(() => loadConfig(baseConfigSchema, rest)).toThrow(ConfigValidationError);

    try {
      loadConfig(baseConfigSchema, rest);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      const paths = err.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('database'))).toBe(true);
    }
  });

  test('A13 — production missing OBJECT_STORAGE_BUCKET throws', () => {
    const { OBJECT_STORAGE_BUCKET: _omit, ...rest } = {
      ...fullStagingEnv,
      APP_ENV: 'production',
    };
    expect(() => loadConfig(baseConfigSchema, rest)).toThrow(ConfigValidationError);
  });

  test('A13 — dev missing SESSION_SECRET throws', () => {
    const { SESSION_SECRET: _omit, ...rest } = {
      ...fullStagingEnv,
      APP_ENV: 'dev',
    };
    expect(() => loadConfig(baseConfigSchema, rest)).toThrow(ConfigValidationError);
  });

  test('A13 — internal-lab missing QUEUE_ADAPTER throws', () => {
    const { QUEUE_ADAPTER: _omit, ...rest } = {
      ...fullStagingEnv,
      APP_ENV: 'internal-lab',
    };
    expect(() => loadConfig(baseConfigSchema, rest)).toThrow(ConfigValidationError);
  });
});

describe('packages/config :: loadConfig (A14 deep immutability)', () => {
  test('A14a — config object and nested objects are deeply frozen', () => {
    const config = loadConfig(baseConfigSchema, {
      ...fullStagingEnv,
      APP_ENV: 'production',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.objectStorage)).toBe(true);
    expect(Object.isFrozen(config.queue)).toBe(true);
    expect(Object.isFrozen(config.decepticon)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  test('A14b — strict-mode top-level mutation throws TypeError', () => {
    const config = loadConfig(baseConfigSchema, {
      ...fullStagingEnv,
      APP_ENV: 'production',
    });
    expect(() => {
      (config as unknown as { appEnv: string }).appEnv = 'local';
    }).toThrow(TypeError);
  });

  test('A14b — strict-mode nested mutation throws TypeError', () => {
    const config = loadConfig(baseConfigSchema, {
      ...fullStagingEnv,
      APP_ENV: 'production',
    });
    expect(() => {
      (config.objectStorage as unknown as { bucket: string }).bucket = 'evil';
    }).toThrow(TypeError);
  });
});

describe('packages/config :: SESSION_SECRET length (A14b)', () => {
  test('A14b — SESSION_SECRET length 31 fails in staging', () => {
    expect(() =>
      loadConfig(baseConfigSchema, { ...fullStagingEnv, SESSION_SECRET: SHORT_SECRET }),
    ).toThrow(ConfigValidationError);
  });

  test('A14b — SESSION_SECRET length 31 fails in production', () => {
    expect(() =>
      loadConfig(baseConfigSchema, {
        ...fullStagingEnv,
        APP_ENV: 'production',
        SESSION_SECRET: SHORT_SECRET,
      }),
    ).toThrow(ConfigValidationError);
  });

  test('A14b — SESSION_SECRET length 31 fails in dev', () => {
    expect(() =>
      loadConfig(baseConfigSchema, {
        ...fullStagingEnv,
        APP_ENV: 'dev',
        SESSION_SECRET: SHORT_SECRET,
      }),
    ).toThrow(ConfigValidationError);
  });

  test('A14b — SESSION_SECRET length 31 fails in internal-lab', () => {
    expect(() =>
      loadConfig(baseConfigSchema, {
        ...fullStagingEnv,
        APP_ENV: 'internal-lab',
        SESSION_SECRET: SHORT_SECRET,
      }),
    ).toThrow(ConfigValidationError);
  });

  test('A14b — SESSION_SECRET length 32 passes in staging', () => {
    const config = loadConfig(baseConfigSchema, fullStagingEnv);
    expect(config.sessionSecret).toBe(VALID_SECRET);
  });
});

describe('packages/config :: invalid APP_ENV (A15)', () => {
  test('A15 — invalid APP_ENV value throws with app_env path', () => {
    try {
      loadConfig(baseConfigSchema, { APP_ENV: 'dev2' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      const paths = err.issues.map((i) => i.path.join('.').toLowerCase());
      expect(paths.some((p) => p.includes('app_env') || p.includes('appenv'))).toBe(true);
    }
  });

  test('A15 — empty APP_ENV throws', () => {
    expect(() => loadConfig(baseConfigSchema, { APP_ENV: '' })).toThrow(ConfigValidationError);
  });
});

describe('packages/config :: ConfigValidationError shape (A16)', () => {
  test('A16 — issues is array of {path, message}', () => {
    try {
      loadConfig(baseConfigSchema, { APP_ENV: 'staging' });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(Array.isArray(err.issues)).toBe(true);
      expect(err.issues.length).toBeGreaterThan(0);
      for (const issue of err.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe('string');
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });

  test('A16 — error message is non-empty', () => {
    try {
      loadConfig(baseConfigSchema, { APP_ENV: 'staging' });
    } catch (e) {
      expect((e as Error).message.length).toBeGreaterThan(0);
    }
  });
});

describe('packages/config :: process.env default (coverage)', () => {
  test('falls back to process.env when env arg omitted', () => {
    const original = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (
          key.startsWith('APP_ENV') ||
          key.startsWith('DATABASE_') ||
          key.startsWith('OBJECT_STORAGE_') ||
          key === 'QUEUE_ADAPTER' ||
          key === 'DECEPTICON_ADAPTER' ||
          key === 'SESSION_SECRET'
        ) {
          delete process.env[key];
        }
      }
      process.env.APP_ENV = 'local';
      const config = loadConfig(baseConfigSchema);
      expect(config.appEnv).toBe('local');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (
          key.startsWith('APP_ENV') ||
          key.startsWith('DATABASE_') ||
          key.startsWith('OBJECT_STORAGE_') ||
          key === 'QUEUE_ADAPTER' ||
          key === 'DECEPTICON_ADAPTER' ||
          key === 'SESSION_SECRET'
        ) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, original);
    }
  });
});
