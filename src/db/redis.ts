import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let redisClient: Redis | null = null;

export function getRedisClient(url: string = env.REDIS_URL): Redis {
  if (redisClient) {
    return redisClient;
  }

  redisClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
    lazyConnect: false,
  });

  redisClient.on('error', (err) => {
    // Only log if not during teardown
    if (redisClient?.status === 'ready' || redisClient?.status === 'connecting') {
      console.error('Redis Client Error:', err.message);
    }
  });

  return redisClient;
}

export async function isRedisHealthy(): Promise<boolean> {
  try {
    if (!redisClient) return false;
    const pong = await redisClient.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
