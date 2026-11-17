import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z
  .object({
    PORT: z.coerce.number().default(4002),
    MONGO_URL: z.string().default('mongodb://mongo:27017/nebron_core'),
    REDIS_URL: z.string().default('redis://redis:6379'),
    AUTH_JWKS_URL: z.string().url().default('http://auth:4001/.well-known/jwks.json'),
    EVENTS_STREAM: z.string().default('zenuxs.events'),
    EVENTS_GROUP: z.string().default('core-api'),
    ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8081'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.string().default('info'),

    // Cloudflare R2 / S3 Storage
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ENDPOINT: z.string().default('http://localhost:9000'),
    R2_ACCESS_KEY_ID: z.string().default('minioadmin'),
    R2_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
    R2_BUCKET: z.string().default('zenuxs-media'),
    R2_PUBLIC_BASE_URL: z.string().default('https://media.zenuxs.com'),
    MAX_AVATAR_BYTES: z.coerce.number().default(5242880), // 5 MB
    MAX_BANNER_BYTES: z.coerce.number().default(10485760), // 10 MB

    // Preferences & Localization
    SUPPORTED_LANGUAGES: z.string().default('en,hi,ta,te,ml,kn,bn,mr,gu,pa,ur'),
    DEFAULT_LANGUAGE: z.string().default('en'),

    // Internal operations token (cron / orphan cleanup)
    INTERNAL_TOKEN: z.string().default('dev-internal-token'),
  })
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        return (
          !!data.R2_ACCOUNT_ID &&
          !!data.R2_ACCESS_KEY_ID &&
          !!data.R2_SECRET_ACCESS_KEY &&
          !!data.R2_ENDPOINT &&
          !!data.R2_BUCKET &&
          !!data.R2_PUBLIC_BASE_URL &&
          !!data.INTERNAL_TOKEN
        );
      }
      return true;
    },
    {
      message: 'All R2 credentials and INTERNAL_TOKEN are required in production mode',
    }
  );

export type EnvConfig = z.infer<typeof envSchema>;

let parsedEnv: EnvConfig;

try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('[Config] Invalid environment variables:', JSON.stringify(error.format(), null, 2));
  } else {
    console.error('[Config] Failed to parse environment variables:', error);
  }
  process.exit(1);
}

export const env = parsedEnv;

export function getAllowedOrigins(): string[] {
  return env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getSupportedLanguages(): string[] {
  return env.SUPPORTED_LANGUAGES.split(',')
    .map((lang) => lang.trim().toLowerCase())
    .filter(Boolean);
}
