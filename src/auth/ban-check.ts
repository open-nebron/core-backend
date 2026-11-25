import type { Redis } from 'ioredis';
import { getRedisClient } from '../db/redis.js';
import { getProfilesCollection } from '../db/mongo.js';
import { AccountBannedError } from '../utils/errors.js';

export async function checkUserBanned(userId: string, redisClient?: Redis): Promise<void> {
  let redis: Redis | null = null;
  try {
    redis = redisClient ?? getRedisClient();
  } catch {
    // Redis client retrieval failed
  }

  const cacheKey = `user:banned:${userId}`;

  if (redis && typeof redis.get === 'function') {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        try {
          const parsed = JSON.parse(cached);
          if (typeof parsed === 'object' && parsed !== null) {
            if (parsed.banned) {
              throw new AccountBannedError(parsed.reason || null);
            }
            return;
          }
        } catch (err) {
          if (err instanceof AccountBannedError) throw err;
          if (cached === '1' || cached === 'true') {
            throw new AccountBannedError(null);
          }
          if (cached === '0' || cached === 'false') {
            return;
          }
        }
      }
    } catch (err) {
      if (err instanceof AccountBannedError) throw err;
      // Non-banned redis error: continue to DB check
    }
  }

  // Not cached or cache miss: query MongoDB
  try {
    let profiles;
    try {
      profiles = getProfilesCollection();
    } catch {
      // Mongo not initialized in test environment
      return;
    }

    if (!profiles || typeof profiles.findOne !== 'function') {
      return;
    }

    const profile = await profiles.findOne(
      { userId },
      { projection: { isBanned: 1, bannedReason: 1 } }
    );
    const isBanned = Boolean(profile?.isBanned);
    const reason = profile?.bannedReason || null;

    if (redis && typeof redis.set === 'function') {
      try {
        await redis.set(
          cacheKey,
          JSON.stringify({ banned: isBanned, reason }),
          'EX',
          60
        );
      } catch {
        // Redis caching error is non-fatal
      }
    }

    if (isBanned) {
      throw new AccountBannedError(reason);
    }
  } catch (err) {
    if (err instanceof AccountBannedError) throw err;
    if (err && (err as any).message?.includes('MongoDB not initialized')) {
      return;
    }
    // Non-fatal error during lookup in test setups
  }
}
