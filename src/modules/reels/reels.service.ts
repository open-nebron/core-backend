import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import {
  getDb,
  getProfilesCollection,
  getReelLikesCollection,
  getReelsCollection,
  runInTransaction,
  type ProfileDocument,
  type ReelDocument,
  type ReelLikeDocument,
} from '../../db/mongo.js';
import { getRedisClient } from '../../db/redis.js';
import { env } from '../../config/env.js';
import {
  ACCEPTED_IMAGE_TYPES,
  computePublicUrl,
  resolveMediaUrl,
  createPresignedUpload,
  headObject,
  isValidUserKey,
  type PresignedUploadSlot,
} from '../../lib/r2.js';
import {
  BadRequestError,
  BlockedError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import { FollowRepository, defaultFollowRepository } from '../social/follows/repository.js';
import { SaveRepository, defaultSaveRepository } from '../social/saves/repository.js';
import { getBlockedUserIds, isBlockedPair } from '../social/block-filter.js';
import { SocialEventPublisher, defaultSocialEventPublisher } from '../social/events.js';
import { REEL_VIEWS_BUFFER_KEY } from '../../jobs/reel-jobs.js';
import { defaultSocialSearchService } from '../search/meili.service.js';
import type { ReelConfirmInput } from './reels.schema.js';

export interface ReelAuthorResponse {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  isFollowing: boolean;
}

export interface ReelResponse {
  id: string;
  authorId: string;
  caption: string | null;
  videoUrl: string;
  thumbnailUrl: string | null;
  duration: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  shareCount: number;
  likedByMe: boolean;
  savedByViewer: boolean;
  savedAt?: string;
  createdAt: string;
  updatedAt: string;
  author: ReelAuthorResponse;
}

export interface ReelsPageResponse {
  items: ReelResponse[];
  nextCursor: string | null;
}

export interface ReelLikerItem {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

function encodeCursor(createdAt: Date, id: ObjectId): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id.toString() }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: ObjectId } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { c?: string; i?: string };
    if (!parsed.c || !parsed.i || !ObjectId.isValid(parsed.i)) {
      throw new Error('Invalid cursor');
    }
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error('Invalid cursor date');
    }
    return { createdAt, id: new ObjectId(parsed.i) };
  } catch {
    throw new BadRequestError('Invalid pagination cursor', 'invalid_cursor');
  }
}

export class ReelsService {
  private followRepo: FollowRepository;
  private saveRepo: SaveRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;
  private customRedis?: Redis;

  constructor(
    followRepo?: FollowRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient,
    customRedis?: Redis,
    saveRepo?: SaveRepository
  ) {
    this.followRepo = followRepo ?? (customDb ? new FollowRepository(customDb) : defaultFollowRepository);
    this.saveRepo = saveRepo ?? (customDb ? new SaveRepository(customDb) : defaultSaveRepository);
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customClient = customClient;
    this.customRedis = customRedis;
  }

  private getReelsCol(): Collection<ReelDocument> {
    return getReelsCollection(this.customDb ?? getDb());
  }

  private getReelLikesCol(): Collection<ReelLikeDocument> {
    return getReelLikesCollection(this.customDb ?? getDb());
  }

  private getProfilesCol(): Collection<ProfileDocument> {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  private getRedis(): Redis | null {
    try {
      return this.customRedis ?? getRedisClient();
    } catch {
      return null;
    }
  }

  private parseObjectId(id: string): ObjectId {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }
    return new ObjectId(id);
  }

  private async getBufferedViewsMap(reelIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (reelIds.length === 0) return map;
    const redis = this.getRedis();
    if (!redis) return map;

    try {
      const vals = await redis.hmget(REEL_VIEWS_BUFFER_KEY, ...reelIds);
      for (let i = 0; i < reelIds.length; i++) {
        const n = Number.parseInt(vals[i] ?? '0', 10);
        if (Number.isFinite(n) && n > 0) {
          map.set(reelIds[i], n);
        }
      }
    } catch {
      // Gracefully degrade to persisted viewCount
    }

    return map;
  }

  public async enrichReels(docs: ReelDocument[], viewerId: string): Promise<ReelResponse[]> {
    if (docs.length === 0) return [];

    const reelIds = docs.map((d) => d._id as ObjectId);
    const reelIdStrings = reelIds.map((id) => id.toString());
    const authorIds = Array.from(new Set(docs.map((d) => d.authorId)));

    const [profiles, likedDocs, savedSet, followingSet, bufferedViews] = await Promise.all([
      this.getProfilesCol().find({ userId: { $in: authorIds } }).toArray(),
      this.getReelLikesCol()
        .find({ userId: viewerId, reelId: { $in: reelIds } }, { projection: { reelId: 1 } })
        .toArray(),
      this.saveRepo.hasSavedBatch('reel', viewerId, reelIds),
      this.followRepo.isFollowingBatch(viewerId, authorIds.filter((id) => id !== viewerId)),
      this.getBufferedViewsMap(reelIdStrings),
    ]);

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    const likedSet = new Set(likedDocs.map((l) => l.reelId.toString()));

    return docs.map((doc) => {
      const id = doc._id.toString();
      const author = profileMap.get(doc.authorId);
      const createdAt = doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt);
      const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt);

      return {
        id,
        authorId: doc.authorId,
        caption: doc.caption ?? null,
        videoUrl: resolveMediaUrl(doc.videoKey, doc.videoUrl) ?? doc.videoUrl,
        thumbnailUrl: resolveMediaUrl(doc.thumbnailKey, doc.thumbnailUrl),
        duration: doc.duration,
        viewCount: (doc.viewCount ?? 0) + (bufferedViews.get(id) ?? 0),
        likeCount: doc.likeCount ?? 0,
        commentCount: doc.commentCount ?? 0,
        saveCount: doc.saveCount ?? 0,
        shareCount: doc.shareCount ?? 0,
        likedByMe: likedSet.has(id),
        savedByViewer: savedSet.has(id),
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
        author: {
          userId: doc.authorId,
          username: author?.username || 'unknown',
          name: author?.name ?? null,
          avatarUrl: author ? computePublicUrl(author.avatarKey, author.updatedAt) : null,
          isFollowing: doc.authorId === viewerId ? false : followingSet.has(doc.authorId),
        },
      };
    });
  }

  async createVideoUploadUrl(
    userId: string,
    contentType: 'video/mp4',
    contentLength: number
  ): Promise<PresignedUploadSlot> {
    if (contentType !== 'video/mp4') {
      throw new BadRequestError('Only video/mp4 is accepted for reels', 'invalid_media_type');
    }
    if (contentLength < 1 || contentLength > env.MAX_REEL_VIDEO_BYTES) {
      throw new BadRequestError(
        `Reel video exceeds maximum size of ${env.MAX_REEL_VIDEO_BYTES} bytes`,
        'file_too_large'
      );
    }
    return createPresignedUpload(userId, 'reel', contentType, contentLength);
  }

  async createThumbnailUploadUrl(
    userId: string,
    contentType: 'image/jpeg' | 'image/png' | 'image/webp',
    contentLength: number
  ): Promise<PresignedUploadSlot> {
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(contentType)) {
      throw new BadRequestError('Thumbnail must be jpeg, png, or webp', 'invalid_media_type');
    }
    if (contentLength < 1 || contentLength > env.MAX_REEL_THUMBNAIL_BYTES) {
      throw new BadRequestError(
        `Thumbnail exceeds maximum size of ${env.MAX_REEL_THUMBNAIL_BYTES} bytes`,
        'file_too_large'
      );
    }
    return createPresignedUpload(userId, 'reel', contentType, contentLength);
  }

  async confirmReel(userId: string, input: ReelConfirmInput): Promise<ReelResponse> {
    if (!isValidUserKey(userId, 'reel', input.videoKey)) {
      throw new BadRequestError('Invalid video objectKey prefix for user', 'invalid_object_key');
    }

    const head = await headObject(input.videoKey);
    if (!head) {
      throw new BadRequestError('Uploaded video not found in storage', 'media_not_found');
    }

    const actualType = head.contentType?.split(';')[0]?.trim().toLowerCase();
    if (actualType !== 'video/mp4') {
      throw new BadRequestError('Uploaded reel video must have Content-Type video/mp4', 'invalid_media_type');
    }

    const actualLength = head.contentLength ?? 0;
    if (actualLength < 1 || actualLength > env.MAX_REEL_VIDEO_BYTES) {
      throw new BadRequestError(
        `Uploaded reel video exceeds max allowed size (${env.MAX_REEL_VIDEO_BYTES} bytes)`,
        'file_too_large'
      );
    }

    const thumbnailKey = input.thumbnailKey ?? null;
    let thumbnailUrl: string | null = null;
    if (thumbnailKey) {
      if (!isValidUserKey(userId, 'reel', thumbnailKey)) {
        throw new BadRequestError('Invalid thumbnail objectKey prefix for user', 'invalid_object_key');
      }
      const thumbHead = await headObject(thumbnailKey);
      if (!thumbHead) {
        throw new BadRequestError('Uploaded thumbnail not found in storage', 'media_not_found');
      }
      const thumbType = thumbHead.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(thumbType)) {
        throw new BadRequestError('Thumbnail must be jpeg, png, or webp', 'invalid_media_type');
      }
      const thumbLength = thumbHead.contentLength ?? 0;
      if (thumbLength < 1 || thumbLength > env.MAX_REEL_THUMBNAIL_BYTES) {
        throw new BadRequestError('Thumbnail exceeds max allowed size', 'file_too_large');
      }
      thumbnailUrl = computePublicUrl(thumbnailKey);
    }

    const caption = input.caption && input.caption.length > 0 ? input.caption : null;
    const videoUrl = computePublicUrl(input.videoKey);
    if (!videoUrl) {
      throw new BadRequestError('Could not compute public video URL', 'invalid_object_key');
    }

    const now = new Date();
    const doc: Omit<ReelDocument, '_id'> = {
      authorId: userId,
      caption,
      videoKey: input.videoKey,
      videoUrl,
      thumbnailKey,
      thumbnailUrl,
      duration: input.duration,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      deleted: false,
      deletedAt: null,
      r2DeletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const res = await this.getReelsCol().insertOne(doc as any);
    const createdDoc: ReelDocument = { _id: res.insertedId, ...doc };

    await this.publisher.publishReelCreated({
      reelId: res.insertedId.toString(),
      authorId: userId,
      duration: input.duration,
      at: now.toISOString(),
    });
    await defaultSocialSearchService.indexReel({
      id: res.insertedId.toString(),
      authorId: userId,
      caption,
      createdAt: now,
      likeCount: 0,
      viewCount: 0,
    });

    const [enriched] = await this.enrichReels([createdDoc], userId);
    return enriched;
  }

  async getFeedReels(
    viewerId: string,
    cursor?: string,
    limit: number = 10
  ): Promise<ReelsPageResponse> {
    const followingIds = await this.followRepo.getAllFollowingIds(viewerId);
    const candidateIds = Array.from(new Set([viewerId, ...followingIds]));

    const otherCandidates = candidateIds.filter((id) => id !== viewerId);
    const blockedIds = await getBlockedUserIds(viewerId, otherCandidates, this.customDb);
    const nonBlockedIds = candidateIds.filter((id) => !blockedIds.has(id));

    if (nonBlockedIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const activeProfiles = await this.getProfilesCol()
      .find({ userId: { $in: nonBlockedIds }, isBanned: { $ne: true } }, { projection: { userId: 1 } })
      .toArray();
    const allowedAuthorIds = activeProfiles.map((p) => p.userId);
    if (allowedAuthorIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const filter: Record<string, any> = {
      authorId: { $in: allowedAuthorIds },
      deleted: false,
    };

    if (cursor) {
      const decoded = decodeCursor(cursor);
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }

    const docs = await this.getReelsCol()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const pageDocs = hasMore ? docs.slice(0, limit) : docs;
    const last = pageDocs[pageDocs.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt),
            last._id as ObjectId
          )
        : null;

    const items = await this.enrichReels(pageDocs, viewerId);
    return { items, nextCursor };
  }

  async getReelById(viewerId: string, reelIdStr: string): Promise<ReelResponse> {
    const reelId = this.parseObjectId(reelIdStr);
    const reel = await this.getReelsCol().findOne({ _id: reelId, deleted: false });
    if (!reel) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    const authorProfile = await this.getProfilesCol().findOne({ userId: reel.authorId });
    if (authorProfile?.isBanned && reel.authorId !== viewerId) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    if (reel.authorId !== viewerId) {
      const blocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    const [enriched] = await this.enrichReels([reel], viewerId);
    return enriched;
  }

  async recordView(viewerId: string, reelIdStr: string): Promise<void> {
    const reelId = this.parseObjectId(reelIdStr);
    const reel = await this.getReelsCol().findOne({ _id: reelId, deleted: false });
    if (!reel) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    if (reel.authorId !== viewerId) {
      const blocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    const redis = this.getRedis();
    if (redis) {
      await redis.hincrby(REEL_VIEWS_BUFFER_KEY, reelIdStr, 1);
    }
  }

  async likeReel(viewerId: string, reelIdStr: string): Promise<{ liked: boolean; likeCount: number }> {
    const reelId = this.parseObjectId(reelIdStr);
    const reel = await this.getReelsCol().findOne({ _id: reelId, deleted: false });
    if (!reel) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    const authorProfile = await this.getProfilesCol().findOne({ userId: reel.authorId });
    if (authorProfile?.isBanned) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    if (reel.authorId !== viewerId) {
      const blocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    let inserted = false;
    await runInTransaction(this.customClient, async (session?: ClientSession) => {
      const existing = await this.getReelLikesCol().findOne({ reelId, userId: viewerId }, { session });
      if (existing) {
        return;
      }
      const res = await this.getReelLikesCol().updateOne(
        { reelId, userId: viewerId },
        { $setOnInsert: { reelId, userId: viewerId, createdAt: new Date() } },
        { upsert: true, session }
      );
      inserted = (res.upsertedCount ?? 0) > 0;
      if (inserted) {
        await this.getReelsCol().updateOne({ _id: reelId }, { $inc: { likeCount: 1 } }, { session });
      }
    });

    const updated = await this.getReelsCol().findOne({ _id: reelId }, { projection: { likeCount: 1 } });

    if (inserted) {
      await this.publisher.publishReelLiked({
        reelId: reelIdStr,
        authorId: reel.authorId,
        userId: viewerId,
        at: new Date().toISOString(),
      });
    }

    return {
      liked: true,
      likeCount: updated?.likeCount ?? reel.likeCount + (inserted ? 1 : 0),
    };
  }

  async unlikeReel(viewerId: string, reelIdStr: string): Promise<{ liked: boolean; likeCount: number }> {
    const reelId = this.parseObjectId(reelIdStr);
    const reel = await this.getReelsCol().findOne({ _id: reelId, deleted: false });
    if (!reel) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    if (reel.authorId !== viewerId) {
      const blocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    let removed = false;
    await runInTransaction(this.customClient, async (session?: ClientSession) => {
      const res = await this.getReelLikesCol().deleteOne({ reelId, userId: viewerId }, { session });
      removed = (res.deletedCount ?? 0) > 0;
      if (removed) {
        await this.getReelsCol().updateOne(
          { _id: reelId, likeCount: { $gt: 0 } },
          { $inc: { likeCount: -1 } },
          { session }
        );
      }
    });

    const updated = await this.getReelsCol().findOne({ _id: reelId }, { projection: { likeCount: 1 } });

    if (removed) {
      await this.publisher.publishReelUnliked({
        reelId: reelIdStr,
        authorId: reel.authorId,
        userId: viewerId,
        at: new Date().toISOString(),
      });
    }

    return {
      liked: false,
      likeCount: updated?.likeCount ?? Math.max(0, reel.likeCount - (removed ? 1 : 0)),
    };
  }

  async getReelLikes(
    viewerId: string,
    reelIdStr: string,
    limit: number = 30,
    before?: string
  ): Promise<ReelLikerItem[]> {
    const reelId = this.parseObjectId(reelIdStr);
    const reel = await this.getReelsCol().findOne({ _id: reelId, deleted: false });
    if (!reel) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    if (reel.authorId !== viewerId) {
      const blocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    const filter: Record<string, any> = { reelId };
    if (before) {
      filter.createdAt = { $lt: new Date(before) };
    }

    const likes = await this.getReelLikesCol()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    if (likes.length === 0) return [];

    const likerIds = likes.map((l) => l.userId);
    const blockedIds = await getBlockedUserIds(viewerId, likerIds, this.customDb);
    const allowedIds = likerIds.filter((id) => !blockedIds.has(id));
    if (allowedIds.length === 0) return [];

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedIds }, isBanned: { $ne: true } })
      .toArray();
    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    return allowedIds
      .filter((id) => profileMap.has(id))
      .map((id) => {
        const p = profileMap.get(id)!;
        return {
          userId: id,
          username: p.username,
          name: p.name ?? null,
          avatarUrl: computePublicUrl(p.avatarKey, p.updatedAt),
        };
      });
  }

  async deleteReel(viewerId: string, reelIdStr: string): Promise<void> {
    const reelId = this.parseObjectId(reelIdStr);
    const reel = await this.getReelsCol().findOne({ _id: reelId, deleted: false });
    if (!reel) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    if (reel.authorId !== viewerId) {
      throw new ForbiddenError('Only the reel author can delete this reel', 'not_reel_author');
    }

    const now = new Date();
    await this.getReelsCol().updateOne(
      { _id: reelId, deleted: false },
      {
        $set: {
          deleted: true,
          deletedAt: now,
          r2DeletedAt: null,
          updatedAt: now,
        },
      }
    );
    await defaultSocialSearchService.deleteReel(reelIdStr);
  }

  async getUserReels(
    viewerId: string,
    targetUserId: string,
    cursor?: string,
    limit: number = 12
  ): Promise<ReelsPageResponse> {
    if (targetUserId !== viewerId) {
      const blocked = await isBlockedPair(viewerId, targetUserId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    const targetProfile = await this.getProfilesCol().findOne({ userId: targetUserId });
    if (!targetProfile || (targetUserId !== viewerId && targetProfile.isBanned)) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    const filter: Record<string, any> = {
      authorId: targetUserId,
      deleted: false,
    };

    if (cursor) {
      const decoded = decodeCursor(cursor);
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }

    const docs = await this.getReelsCol()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const pageDocs = hasMore ? docs.slice(0, limit) : docs;
    const last = pageDocs[pageDocs.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt),
            last._id as ObjectId
          )
        : null;

    const items = await this.enrichReels(pageDocs, viewerId);
    return { items, nextCursor };
  }
}

export const defaultReelsService = new ReelsService();
