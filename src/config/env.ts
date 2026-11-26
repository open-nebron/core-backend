import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z
  .object({
    PORT: z.coerce.number().default(4002),
    MONGO_URL: z.string().default('mongodb://localhost:27017/nebron_core'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    AUTH_JWKS_URL: z.string().url().default('http://auth:4001/.well-known/jwks.json'),
    EVENTS_STREAM: z.string().default('nebron.events'),
    EVENTS_GROUP: z.string().default('core-api'),
    ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8081'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.string().default('info'),

    // Cloudflare R2 / S3 Storage
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ENDPOINT: z.string().default('http://localhost:9000'),
    R2_CLIENT_ENDPOINT: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().default('minioadmin'),
    R2_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
    R2_BUCKET: z.string().default('nebron-media'),
    R2_PUBLIC_BASE_URL: z.string().default('https://media.nebron.com'),
    MAX_AVATAR_BYTES: z.coerce.number().default(5242880), // 5 MB
    MAX_BANNER_BYTES: z.coerce.number().default(10485760), // 10 MB
    MAX_POST_IMAGE_BYTES: z.coerce.number().default(10485760), // 10 MB
    MAX_STORY_IMAGE_BYTES: z.coerce.number().default(10485760), // 10 MB
    MAX_STORY_VIDEO_BYTES: z.coerce.number().default(52428800), // 50 MB

    // Preferences & Localization
    SUPPORTED_LANGUAGES: z.string().default('en,hi,ta,te,ml,kn,bn,mr,gu,pa,ur'),
    DEFAULT_LANGUAGE: z.string().default('en'),

    // Internal operations token (cron / orphan cleanup)
    INTERNAL_TOKEN: z.string().default('dev-internal-token'),

    // Cross-service URLs
    AUTH_SERVICE_URL: z.string().default('http://localhost:4001'),
    CHAT_SERVICE_URL: z.string().default('http://localhost:4003'),
    VOICE_SERVICE_URL: z.string().default('http://localhost:4004'),

    // Decisions & Notifications
    DECISION_REPORTS_NOTIFY: z.enum(['email', 'dashboard']).default('email'),
    ADMIN_NOTIFICATION_EMAIL: z.string().default('admin@nebron.com'),
    RESEND_API_KEY: z.string().optional(),
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
