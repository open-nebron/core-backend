import type { Db } from 'mongodb';
import { getDb, getStoriesCollection } from '../db/mongo.js';
import { deleteObject } from '../lib/r2.js';

export interface StoryCleanupResult {
  scannedCount: number;
  deletedCount: number;
  errors: string[];
}

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * Deletes expired stories from both R2 object storage and MongoDB in batches of 100.
 */
export async function cleanupExpiredStories(
  batchSize: number = 100,
  customDb?: Db,
  maxBatches: number = 50
): Promise<StoryCleanupResult> {
  const collection = getStoriesCollection(customDb ?? getDb());
  const now = new Date();

  let scannedCount = 0;
  let deletedCount = 0;
  const errors: string[] = [];

  for (let batch = 0; batch < maxBatches; batch++) {
    const expiredStories = await collection
      .find({ expiresAt: { $lt: now } })
      .sort({ expiresAt: 1 })
      .limit(batchSize)
      .toArray();

    if (expiredStories.length === 0) {
      break;
    }

    for (const story of expiredStories) {
      scannedCount++;
      try {
        if (story.mediaKey) {
          await deleteObject(story.mediaKey);
        }
        if (story.thumbnailKey) {
          await deleteObject(story.thumbnailKey);
        }
        await collection.deleteOne({ _id: story._id });
        deletedCount++;
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed cleaning up story ${story._id?.toString()}: ${msg}`);
      }
    }

    if (expiredStories.length < batchSize) {
      break;
    }
  }

  return { scannedCount, deletedCount, errors };
}

export function startStoryCleanupScheduler(): void {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(async () => {
    try {
      const res = await cleanupExpiredStories();
      if (res.deletedCount > 0 || res.errors.length > 0) {
        console.log(
          `[StoryCleanup] Cleaned ${res.deletedCount}/${res.scannedCount} expired stories (errors: ${res.errors.length})`
        );
      }
    } catch (err: any) {
      console.error('[StoryCleanup] Scheduled cleanup failed:', err?.message || err);
    }
  }, CLEANUP_INTERVAL_MS);

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

export function stopStoryCleanupScheduler(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
