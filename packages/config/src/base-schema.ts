import { z } from 'zod';
import { type AppEnv, SESSION_SECRET_MIN_LENGTH, appEnvSchema, isNonLocal } from './app-env.ts';

const requiredString = (label: string) =>
  z
    .string({
      required_error: `${label} is required`,
      invalid_type_error: `${label} must be a string`,
    })
    .min(1, `${label} must not be empty`);

const optionalString = z.string().min(1).optional();

const envInputShape = z.object({
  APP_ENV: requiredString('APP_ENV'),
  DATABASE_URL: optionalString,
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_SECRET_KEY: optionalString,
  OBJECT_STORAGE_BUCKET: optionalString,
  QUEUE_ADAPTER: optionalString,
  DECEPTICON_ADAPTER: optionalString,
  SESSION_SECRET: optionalString,
  SENTRY_DSN: optionalString,
});

export type EnvInput = z.infer<typeof envInputShape>;

const databaseSchema = z.object({
  url: z.string().min(1),
});

const objectStorageSchema = z.object({
  endpoint: z.string().min(1),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  bucket: z.string().min(1),
});

const queueSchema = z.object({
  adapter: z.enum(['local', 'yandex']),
});

const decepticonSchema = z.object({
  adapter: z.enum(['fake', 'real']),
});

const telemetrySchema = z.object({
  sentryDsn: z.string().min(1).optional(),
});

const localDefaults = {
  database: { url: 'postgres://cs:cs@localhost:5433/cyberstrike' },
  objectStorage: {
    endpoint: 'http://localhost:9000',
    accessKey: 'cs',
    secretKey: 'cs-secret',
    bucket: 'cs-local',
  },
  queue: { adapter: 'local' as const },
  decepticon: { adapter: 'fake' as const },
  sessionSecret: 'local-development-session-secret-not-for-prod',
} as const;

const buildConfig = (env: EnvInput, appEnv: AppEnv) => {
  if (!isNonLocal(appEnv)) {
    return {
      appEnv,
      database: { url: env.DATABASE_URL ?? localDefaults.database.url },
      objectStorage: {
        endpoint: env.OBJECT_STORAGE_ENDPOINT ?? localDefaults.objectStorage.endpoint,
        accessKey: env.OBJECT_STORAGE_ACCESS_KEY ?? localDefaults.objectStorage.accessKey,
        secretKey: env.OBJECT_STORAGE_SECRET_KEY ?? localDefaults.objectStorage.secretKey,
        bucket: env.OBJECT_STORAGE_BUCKET ?? localDefaults.objectStorage.bucket,
      },
      queue: { adapter: (env.QUEUE_ADAPTER ?? localDefaults.queue.adapter) as 'local' | 'yandex' },
      decepticon: {
        adapter: (env.DECEPTICON_ADAPTER ?? localDefaults.decepticon.adapter) as 'fake' | 'real',
      },
      sessionSecret: env.SESSION_SECRET ?? localDefaults.sessionSecret,
      telemetry: { sentryDsn: env.SENTRY_DSN },
    };
  }

  return {
    appEnv,
    database: { url: env.DATABASE_URL ?? '' },
    objectStorage: {
      endpoint: env.OBJECT_STORAGE_ENDPOINT ?? '',
      accessKey: env.OBJECT_STORAGE_ACCESS_KEY ?? '',
      secretKey: env.OBJECT_STORAGE_SECRET_KEY ?? '',
      bucket: env.OBJECT_STORAGE_BUCKET ?? '',
    },
    queue: { adapter: (env.QUEUE_ADAPTER ?? '') as 'local' | 'yandex' },
    decepticon: { adapter: (env.DECEPTICON_ADAPTER ?? '') as 'fake' | 'real' },
    sessionSecret: env.SESSION_SECRET ?? '',
    telemetry: { sentryDsn: env.SENTRY_DSN },
  };
};

const fullConfigSchema = z.object({
  appEnv: appEnvSchema,
  database: databaseSchema,
  objectStorage: objectStorageSchema,
  queue: queueSchema,
  decepticon: decepticonSchema,
  sessionSecret: z.string().min(SESSION_SECRET_MIN_LENGTH, {
    message: `session_secret must be at least ${SESSION_SECRET_MIN_LENGTH} characters`,
  }),
  telemetry: telemetrySchema,
});

export type AppConfig = z.infer<typeof fullConfigSchema>;

export const baseConfigSchema = envInputShape
  .superRefine((env, ctx) => {
    const appEnvResult = appEnvSchema.safeParse(env.APP_ENV);
    if (!appEnvResult.success) {
      for (const issue of appEnvResult.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['APP_ENV', ...(issue.path ?? [])],
        });
      }
    }
  })
  .transform((env, ctx) => {
    const appEnvResult = appEnvSchema.safeParse(env.APP_ENV);
    if (!appEnvResult.success) {
      return z.NEVER;
    }
    const built = buildConfig(env, appEnvResult.data);
    const parsed = fullConfigSchema.safeParse(built);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue(issue);
      }
      return z.NEVER;
    }
    return parsed.data;
  });
