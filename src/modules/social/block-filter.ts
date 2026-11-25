import type { Db } from 'mongodb';
import { getDb } from '../../db/mongo.js';
import { getRedisClient } from '../../db/redis.js';

export async function getBlockedUserIds(
  viewerId: string,
  candidateIds?: string[] | Set<string>,
  customDb?: Db
): Promise<Set<string>> {
  const redis = getRedisClient();
  const cacheKey = `rel:blocked:${viewerId}`;

  let allBlockedUserIds: string[] | null = null;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      allBlockedUserIds = JSON.parse(cached);
    }
  } catch {
    // Redis cache miss or error
  }

  if (!allBlockedUserIds) {
    try {
      const db = customDb ?? getDb();
      const relationships = db.collection('relationships');

      const docs = await relationships
        .find({
          $or: [
            { fromUserId: viewerId, blocked: true },
            { toUserId: viewerId, blocked: true },
          ],
        })
        .toArray();

      const blockedSet = new Set<string>();
      for (const doc of docs) {
        if (doc.fromUserId === viewerId && doc.toUserId) {
          blockedSet.add(doc.toUserId);
        }
        if (doc.toUserId === viewerId && doc.fromUserId) {
          blockedSet.add(doc.fromUserId);
        }
      }

      allBlockedUserIds = Array.from(blockedSet);

      try {
        await redis.set(cacheKey, JSON.stringify(allBlockedUserIds), 'EX', 60);
      } catch {
        // Ignore Redis set errors
      }
    } catch {
      allBlockedUserIds = [];
    }
  }

  const blockedSet = new Set(allBlockedUserIds);

  if (!candidateIds) {
    return blockedSet;
  }

  const result = new Set<string>();
  for (const id of candidateIds) {
    if (blockedSet.has(id)) {
      result.add(id);
    }
  }
  return result;
}

export async function isBlockedPair(
  userA: string,
  userB: string,
  customDb?: Db
): Promise<boolean> {
  const blockedFromA = await getBlockedUserIds(userA, [userB], customDb);
  return blockedFromA.has(userB);
}

export async function invalidateBlockedCache(userId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.del(`rel:blocked:${userId}`);
  } catch {
    // Ignore
  }
}
