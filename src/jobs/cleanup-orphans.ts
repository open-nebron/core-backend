import { ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { getS3Client, deleteObject } from '../lib/r2.js';
import { getProfilesCollection } from '../db/mongo.js';
import { env } from '../config/env.js';

export interface CleanupResult {
  scannedCount: number;
  deletedCount: number;
  errors: string[];
}

export async function cleanupOrphanedMedia(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<CleanupResult> {
  const s3 = getS3Client();
  const collection = getProfilesCollection();
  const cutoffTime = new Date(Date.now() - maxAgeMs);

  let continuationToken: string | undefined = undefined;
  let scannedCount = 0;
  let deletedCount = 0;
  const errors: string[] = [];

  try {
    do {
      const listCommand: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: env.R2_BUCKET,
        Prefix: 'users/',
        ContinuationToken: continuationToken,
      });

      const response: ListObjectsV2CommandOutput = await s3.send(listCommand);
      const items = response.Contents || [];
      continuationToken = response.NextContinuationToken;

      for (const item of items) {
        if (!item.Key) continue;
        scannedCount++;

        // Only cleanup files inside avatar/ or banner/ folders
        if (!item.Key.includes('/avatar/') && !item.Key.includes('/banner/')) {
          continue;
        }

        // Check age: must be older than 24h
        if (item.LastModified && item.LastModified > cutoffTime) {
          continue;
        }

        // Check if object is referenced in profiles
        const isReferenced =
          (await collection.countDocuments(
            { $or: [{ avatarKey: item.Key }, { bannerKey: item.Key }] },
            { limit: 1 }
          )) > 0;

        if (!isReferenced) {
          try {
            await deleteObject(item.Key);
            deletedCount++;
            console.log(`[OrphanCleanup] Deleted orphaned media object: ${item.Key}`);
          } catch (delErr: any) {
            errors.push(`Failed to delete ${item.Key}: ${delErr.message}`);
          }
        }
      }
    } while (continuationToken);
  } catch (err: any) {
    console.error('[OrphanCleanup] Error during orphan cleanup job:', err.message);
    errors.push(err.message);
  }

  return { scannedCount, deletedCount, errors };
}
