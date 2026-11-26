import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRedisClient } from '../db/redis.js';
import { RateLimitError } from '../utils/errors.js';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  keyPrefix: string;
  keyGenerator?: (request: FastifyRequest) => string;
}

export function createRedisRateLimiter(options: RateLimitOptions) {
  const { limit, windowSeconds, keyPrefix, keyGenerator } = options;

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const redis = getRedisClient();
    const identifier = keyGenerator
      ? keyGenerator(request)
      : request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';

    const currentWindow = Math.floor(Date.now() / 1000 / windowSeconds);
    const redisKey = `${keyPrefix}:${identifier}:${currentWindow}`;

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

// 20 requests/min per IP for public username check
export const checkUsernameRateLimiter = createRedisRateLimiter({
  limit: 20,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:username_check',
  keyGenerator: (req) => req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
});

// User-keyed rate limiters
const userKeyGen = (req: FastifyRequest) => req.user?.userId || req.ip || 'anonymous';

export const uploadUrlRateLimiter = createRedisRateLimiter({
  limit: 5,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:upload_url',
  keyGenerator: userKeyGen,
});

export const confirmUploadRateLimiter = createRedisRateLimiter({
  limit: 10,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:confirm_upload',
  keyGenerator: userKeyGen,
});

export const patchMeRateLimiter = createRedisRateLimiter({
  limit: 30,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:patch_me',
  keyGenerator: userKeyGen,
});

export const deleteMediaRateLimiter = createRedisRateLimiter({
  limit: 10,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:delete_media',
  keyGenerator: userKeyGen,
});

// Relationship rate limiters
export const blockRateLimiter = createRedisRateLimiter({
  limit: 30,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:rel_block',
  keyGenerator: userKeyGen,
});

export const muteRateLimiter = createRedisRateLimiter({
  limit: 30,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:rel_mute',
  keyGenerator: userKeyGen,
});

export const getRelationshipRateLimiter = createRedisRateLimiter({
  limit: 300,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:rel_get',
  keyGenerator: userKeyGen,
});

export const getBlockedRateLimiter = createRedisRateLimiter({
  limit: 60,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:rel_blocked',
  keyGenerator: userKeyGen,
});

export const checkRelationshipsRateLimiter = createRedisRateLimiter({
  limit: 600,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:rel_check',
  keyGenerator: (req) =>
    (req.headers['x-internal-token'] as string) || req.ip || 'internal',
});

// User search & public profile rate limiters
export const userSearchRateLimiter = createRedisRateLimiter({
  limit: 30,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:user_search',
  keyGenerator: userKeyGen,
});

export const userGetRateLimiter = createRedisRateLimiter({
  limit: 60,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:user_get',
  keyGenerator: userKeyGen,
});

export const createPostRateLimiter = createRedisRateLimiter({
  limit: 10,
  windowSeconds: 3600,
  keyPrefix: 'ratelimit:posts_create',
  keyGenerator: userKeyGen,
});

export const feedRateLimiter = createRedisRateLimiter({
  limit: 100,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:feed',
  keyGenerator: userKeyGen,
});

export const createCommentRateLimiter = createRedisRateLimiter({
  limit: 30,
  windowSeconds: 3600,
  keyPrefix: 'ratelimit:comments_create',
  keyGenerator: userKeyGen,
});

export const storyUploadUrlRateLimiter = createRedisRateLimiter({
  limit: 20,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:story_upload_url',
  keyGenerator: userKeyGen,
});

export const createStoryRateLimiter = createRedisRateLimiter({
  limit: 30,
  windowSeconds: 3600,
  keyPrefix: 'ratelimit:stories_create',
  keyGenerator: userKeyGen,
});

export const reelUploadUrlRateLimiter = createRedisRateLimiter({
  limit: 20,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:reel_upload_url',
  keyGenerator: userKeyGen,
});

export const createReelRateLimiter = createRedisRateLimiter({
  limit: 10,
  windowSeconds: 3600,
  keyPrefix: 'ratelimit:reels_create',
  keyGenerator: userKeyGen,
});
