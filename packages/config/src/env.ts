import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().url().default('postgres://localmail:localmail@localhost:5432/localmail'),
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
    S3_ACCESS_KEY: z.string().min(1).default('minio'),
    S3_SECRET_KEY: z.string().min(8).default('minio12345'),
    S3_BUCKET: z.string().min(1).default('localmail'),
    SMTP_INBOUND_PORT: z.coerce.number().int().min(1).max(65535).default(2525),
    SMTP_OUTBOUND_HOST: z.string().min(1).default('localhost'),
    SMTP_OUTBOUND_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_MAX_HOPS: z.coerce.number().int().min(1).max(100).default(20),
    SCHEDULED_SEND_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(3600000).default(5000),
    RATE_LIMIT_RPS: z.coerce.number().finite().positive().default(10),
    RATE_LIMIT_BURST: z.coerce.number().finite().int().positive().default(20),
    RATE_LIMIT_POD_RPS: z.coerce.number().finite().positive().default(50),
    RATE_LIMIT_POD_BURST: z.coerce.number().finite().int().positive().default(100),
    MAIL_DOMAIN: z.string().min(1).default('localmail.test'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    ADMIN_API_KEY: z.string().min(16).default('lm_admin_change_me'),
    ATTACHMENT_SIGNING_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    APP_ENCRYPTION_KEY: z.string().optional(),
    /**
     * When a sender matches a `block` rule: `drop` rejects at RCPT TO (no DB row);
     * `spam` accepts and stores with `spam` + `skip_classify` (no Jev classify).
     */
    SENDER_BLOCK_MODE: z.enum(['drop', 'spam']).default('drop'),
    JEV_ENABLED: booleanFromString.default('false'),
    TYPESAFE_API_KEY: z.string().optional(),
  })
  .superRefine((env, context) => {
    if (env.JEV_ENABLED && !env.TYPESAFE_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TYPESAFE_API_KEY'],
        message: 'TYPESAFE_API_KEY is required when JEV_ENABLED=true',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(input: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return envSchema.parse(input);
}

export function loadEnv(path?: string): Env {
  loadDotenv(path ? { path } : undefined);
  return parseEnv(process.env);
}
