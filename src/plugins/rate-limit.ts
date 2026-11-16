import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRedisClient } from '../db/redis.js';
import { RateLimitError } from '../utils/errors.js';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
}

export function createRedisRateLimiter(options: RateLimitOptions) {
  const { limit, windowSeconds, keyPrefix } = options;

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const redis = getRedisClient();
    const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
    const currentWindow = Math.floor(Date.now() / 1000 / windowSeconds);
    const redisKey = `${keyPrefix}:${ip}:${currentWindow}`;

    try {
      const pipeline = redis.pipeline();
      pipeline.incr(redisKey);
      pipeline.expire(redisKey, windowSeconds * 2); // safety buffer for key expiry
      const results = await pipeline.exec();

      const count = (results?.[0]?.[1] as number) || 1;
      const remaining = Math.max(0, limit - count);

      reply.header('X-RateLimit-Limit', limit);
      reply.header('X-RateLimit-Remaining', remaining);

      if (count > limit) {
        throw new RateLimitError(`Rate limit exceeded. Maximum ${limit} requests per minute.`);
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        throw err;
      }
      // If Redis has a transient failure, log warning and allow request to prevent downtime
      request.log.warn({ err }, 'Rate limiter Redis error, failing open');
    }
  };
}

export const checkUsernameRateLimiter = createRedisRateLimiter({
  limit: 20,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:username_check',
});
