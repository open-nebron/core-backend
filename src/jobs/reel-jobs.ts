import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Redis } from 'ioredis';
import { getDb, getReelsCollection } from '../db/mongo.js';
import { getRedisClient } from '../db/redis.js';
import { deleteObject } from '../lib/r2.js';
import { SocialEventPublisher, defaultSocialEventPublisher } from '../modules/social/events.js';

export const REEL_VIEWS_BUFFER_KEY = 'reels:views:buffer';

const VIEW_FLUSH_INTERVAL_MS = 60 * 1000; // 60 seconds
const REEL_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let viewFlushTimer: NodeJS.Timeout | null = null;
let reelCleanupTimer: NodeJS.Timeout | null = null;

export interface ReelViewFlushResult {
  flushedReels: number;
  totalViewsFlushed: number;
  errors: string[];
}

export interface ReelCleanupResult {
  scannedCount: number;
  cleanedCount: number;
  errors: string[];
}

const POP_ALL_HASH_LUA = `
local entries = redis.call('HGETALL', KEYS[1])
if #entries > 0 then
  redis.call('DEL', KEYS[1])
end
return entries
`;

/**
 * Atomically drains Redis hash `reels:views:buffer`, increments MongoDB `reels.viewCount`,
 * and emits `core.reel.viewed` events.
 */
export async function flushBufferedReelViews(
  customDb?: Db,
  customRedis?: Redis,
  customPublisher?: SocialEventPublisher
): Promise<ReelViewFlushResult> {
  const redis = customRedis ?? getRedisClient();
  const collection = getReelsCollection(customDb ?? getDb());
  const publisher = customPublisher ?? defaultSocialEventPublisher;

  const deltaMap = new Map<string, number>();

  if (typeof (redis as any).eval === 'function') {
    const raw = (await (redis as any).eval(POP_ALL_HASH_LUA, 1, REEL_VIEWS_BUFFER_KEY)) as string[];
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        const reelId = raw[i];
        const delta = Number.parseInt(raw[i + 1] ?? '0', 10);
        if (reelId && Number.isFinite(delta) && delta > 0) {
          deltaMap.set(reelId, delta);
        }
      }
    }
  } else {
    const entries = await redis.hgetall(REEL_VIEWS_BUFFER_KEY);
    const keys = Object.keys(entries || {});
    for (const reelId of keys) {
      const delta = Number.parseInt(entries[reelId] ?? '0', 10);
      if (Number.isFinite(delta) && delta > 0) {
        deltaMap.set(reelId, delta);
        await redis.hincrby(REEL_VIEWS_BUFFER_KEY, reelId, -delta);
      }
    }
    if (keys.length > 0 && typeof (redis as any).del === 'function') {
      const remaining = await redis.hgetall(REEL_VIEWS_BUFFER_KEY);
      const nonZero = Object.values(remaining || {}).some((v) => Number.parseInt(v, 10) > 0);
      if (!nonZero) {
        await redis.del(REEL_VIEWS_BUFFER_KEY);
      }
    }
  }

  let flushedReels = 0;
  let totalViewsFlushed = 0;
  const errors: string[] = [];
  const nowIso = new Date().toISOString();

  for (const [reelIdStr, delta] of deltaMap.entries()) {
    if (!ObjectId.isValid(reelIdStr) || String(new ObjectId(reelIdStr)) !== reelIdStr) {
      continue;
    }

    try {
      const updated = await collection.findOneAndUpdate(
        { _id: new ObjectId(reelIdStr), deleted: false },
        { $inc: { viewCount: delta } },
        { returnDocument: 'after' }
      );

      if (updated) {
        flushedReels++;
        totalViewsFlushed += delta;
        await publisher.publishReelViewed({
          reelId: reelIdStr,
          viewDelta: delta,
          totalViews: updated.viewCount,
          at: nowIso,
        });
      }
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed flushing views for reel ${reelIdStr}: ${msg}`);
    }
  }

  return { flushedReels, totalViewsFlushed, errors };
}

/**
 * Deletes R2 video and thumbnail objects for soft-deleted reels whose R2 files have not yet been removed.
 */
export async function cleanupDeletedReels(
  batchSize: number = 100,
  customDb?: Db,
  maxBatches: number = 50
): Promise<ReelCleanupResult> {
  const collection = getReelsCollection(customDb ?? getDb());

  let scannedCount = 0;
  let cleanedCount = 0;
  const errors: string[] = [];

  for (let batch = 0; batch < maxBatches; batch++) {
    const deletedReels = await collection
      .find({
        deleted: true,
        $or: [{ r2DeletedAt: null }, { r2DeletedAt: { $exists: false } }],
      })
      .sort({ deletedAt: 1, createdAt: 1 })
      .limit(batchSize)
      .toArray();

    if (deletedReels.length === 0) {
      break;
    }

    for (const reel of deletedReels) {
      scannedCount++;
      try {
        if (reel.videoKey) {
          await deleteObject(reel.videoKey);
        }
        if (reel.thumbnailKey) {
          await deleteObject(reel.thumbnailKey);
        }
        await collection.updateOne(
          { _id: reel._id },
          { $set: { r2DeletedAt: new Date() } }
        );
        cleanedCount++;
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed cleaning up reel ${reel._id?.toString()}: ${msg}`);
      }
    }

    if (deletedReels.length < batchSize) {
      break;
    }
  }

  return { scannedCount, cleanedCount, errors };
}

export function startReelJobsScheduler(): void {
  if (!viewFlushTimer) {
    viewFlushTimer = setInterval(async () => {
      try {
        const res = await flushBufferedReelViews();
        if (res.flushedReels > 0 || res.errors.length > 0) {
          console.log(
            `[ReelViewsFlush] Flushed ${res.totalViewsFlushed} views across ${res.flushedReels} reels (errors: ${res.errors.length})`
          );
        }
      } catch (err: any) {
        console.error('[ReelViewsFlush] Scheduled flush failed:', err?.message || err);
      }
    }, VIEW_FLUSH_INTERVAL_MS);

    if (typeof viewFlushTimer.unref === 'function') {
      viewFlushTimer.unref();
    }
  }

  if (!reelCleanupTimer) {
    reelCleanupTimer = setInterval(async () => {
      try {
        const res = await cleanupDeletedReels();
        if (res.cleanedCount > 0 || res.errors.length > 0) {
          console.log(
            `[ReelCleanup] Cleaned R2 assets for ${res.cleanedCount}/${res.scannedCount} deleted reels (errors: ${res.errors.length})`
          );
        }
      } catch (err: any) {
        console.error('[ReelCleanup] Scheduled cleanup failed:', err?.message || err);
      }
    }, REEL_CLEANUP_INTERVAL_MS);

    if (typeof reelCleanupTimer.unref === 'function') {
      reelCleanupTimer.unref();
    }
  }
}

export function stopReelJobsScheduler(): void {
  if (viewFlushTimer) {
    clearInterval(viewFlushTimer);
    viewFlushTimer = null;
  }
  if (reelCleanupTimer) {
    clearInterval(reelCleanupTimer);
    reelCleanupTimer = null;
  }
}
