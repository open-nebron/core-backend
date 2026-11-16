import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4002),
  MONGO_URL: z.string().default('mongodb://mongo:27017/zenuxs_core'),
  REDIS_URL: z.string().default('redis://redis:6379'),
  AUTH_JWKS_URL: z.string().url().default('http://auth:4001/.well-known/jwks.json'),
  EVENTS_STREAM: z.string().default('zenuxs.events'),
  EVENTS_GROUP: z.string().default('core-api'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8081'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
});

export type EnvConfig = z.infer<typeof envSchema>;

let parsedEnv: EnvConfig;

try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Invalid environment variables:', JSON.stringify(error.format(), null, 2));
  } else {
    console.error('❌ Failed to parse environment variables:', error);
  }
  process.exit(1);
}

export const env = parsedEnv;

export function getAllowedOrigins(): string[] {
  return env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
