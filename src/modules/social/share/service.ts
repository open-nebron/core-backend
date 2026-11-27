import { ObjectId, type Db } from 'mongodb';
import type { Redis } from 'ioredis';
import { env, getAllowedOrigins } from '../../../config/env.js';
import {
  getDb,
  getPostsCollection,
  getReelsCollection,
  getCommentsCollection,
  getProfilesCollection,
  getShareEventsCollection,
} from '../../../db/mongo.js';
import { getRedisClient } from '../../../db/redis.js';
import { SaveRepository, defaultSaveRepository, type SaveContentType } from '../saves/repository.js';
import { FollowRepository, defaultFollowRepository } from '../follows/repository.js';
import { SocialEventPublisher, defaultSocialEventPublisher } from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import { BlockedError, NotFoundError } from '../../../utils/errors.js';

export interface ShareContentResult {
  url: string;
  shareCount: number;
}

const SHARE_DEDUP_TTL_SECONDS = 86400; // 24 hours

interface ShareTargetMeta {
  targetId: ObjectId;
  ownerId: string;
  currentShareCount: number;
  url: string;
  postId?: string;
  reelId?: string;
}

/**
 * Tracks shares with per-user 24h Redis deduplication and emits canonical deep links.
 */
export class ShareService {
  private saveRepo: SaveRepository;
  private followRepo: FollowRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customRedis?: Redis;

  constructor(
    saveRepo?: SaveRepository,
    followRepo?: FollowRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customRedis?: Redis
  ) {
    this.saveRepo = saveRepo ?? (customDb ? new SaveRepository(customDb) : defaultSaveRepository);
    this.followRepo = followRepo ?? (customDb ? new FollowRepository(customDb) : defaultFollowRepository);
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customRedis = customRedis;
  }

  private db(): Db {
    return this.customDb ?? getDb();
  }

  private getWebBaseUrl(): string {
    const candidate =
      env.PUBLIC_WEB_URL ||
      getAllowedOrigins().find((origin) => origin !== '*' && /^https?:\/\//i.test(origin)) ||
      'http://localhost:3000';
    return candidate.replace(/\/+$/, '');
  }

  private async resolveTarget(
    viewerId: string,
    contentType: SaveContentType,
    contentId: string
  ): Promise<ShareTargetMeta> {
    if (!ObjectId.isValid(contentId) || String(new ObjectId(contentId)) !== contentId) {
      const label = contentType.charAt(0).toUpperCase() + contentType.slice(1);
      throw new NotFoundError(`${label} not found`, `${contentType}_not_found`);
    }

    const targetId = new ObjectId(contentId);
    const profilesCol = getProfilesCollection(this.db());
    const baseUrl = this.getWebBaseUrl();

    if (contentType === 'post') {
      const post = await getPostsCollection(this.db()).findOne({ _id: targetId });
      if (!post || post.deleted) {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      const author = await profilesCol.findOne({ userId: post.authorId });
      if (author?.isBanned && post.authorId !== viewerId) {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      if (post.authorId !== viewerId && (await isBlockedPair(viewerId, post.authorId, this.db()))) {
        throw new BlockedError();
      }
      return {
        targetId,
        ownerId: post.authorId,
        currentShareCount: post.shareCount ?? 0,
        url: `${baseUrl}/posts/${contentId}`,
        postId: contentId,
      };
    }

    if (contentType === 'reel') {
      const reel = await getReelsCollection(this.db()).findOne({ _id: targetId });
      if (!reel || reel.deleted) {
        throw new NotFoundError('Reel not found', 'reel_not_found');
      }
      const author = await profilesCol.findOne({ userId: reel.authorId });
      if (author?.isBanned && reel.authorId !== viewerId) {
        throw new NotFoundError('Reel not found', 'reel_not_found');
      }
      if (reel.authorId !== viewerId && (await isBlockedPair(viewerId, reel.authorId, this.db()))) {
        throw new BlockedError();
      }
      return {
        targetId,
        ownerId: reel.authorId,
        currentShareCount: reel.shareCount ?? 0,
        url: `${baseUrl}/reels/${contentId}`,
        reelId: contentId,
      };
    }

    const comment = await getCommentsCollection(this.db()).findOne({ _id: targetId });
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }
    const author = await profilesCol.findOne({ userId: comment.authorId });
    if (author?.isBanned && comment.authorId !== viewerId) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }
    if (comment.authorId !== viewerId && (await isBlockedPair(viewerId, comment.authorId, this.db()))) {
      throw new BlockedError();
    }

    const isReel = comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
    if (isReel && comment.reelId) {
      const reel = await getReelsCollection(this.db()).findOne({ _id: comment.reelId });
      if (!reel || reel.deleted) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      const parentAuthor = await profilesCol.findOne({ userId: reel.authorId });
      if (parentAuthor?.isBanned && reel.authorId !== viewerId) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      if (reel.authorId !== viewerId && (await isBlockedPair(viewerId, reel.authorId, this.db()))) {
        throw new BlockedError();
      }
      const rid = comment.reelId.toString();
      return {
        targetId,
        ownerId: reel.authorId,
        currentShareCount: comment.shareCount ?? 0,
        url: `${baseUrl}/reels/${rid}#comment-${contentId}`,
        reelId: rid,
      };
    }

    if (comment.postId) {
      const post = await getPostsCollection(this.db()).findOne({ _id: comment.postId });
      if (!post || post.deleted) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      const parentAuthor = await profilesCol.findOne({ userId: post.authorId });
      if (parentAuthor?.isBanned && post.authorId !== viewerId) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      if (post.authorId !== viewerId && (await isBlockedPair(viewerId, post.authorId, this.db()))) {
        throw new BlockedError();
      }
      const pid = comment.postId.toString();
      return {
        targetId,
        ownerId: post.authorId,
        currentShareCount: comment.shareCount ?? 0,
        url: `${baseUrl}/posts/${pid}#comment-${contentId}`,
        postId: pid,
      };
    }

    throw new NotFoundError('Comment not found', 'comment_not_found');
  }

  async shareContent(
    viewerId: string,
    contentType: SaveContentType,
    contentId: string
  ): Promise<ShareContentResult> {
    const target = await this.resolveTarget(viewerId, contentType, contentId);

    const redis = this.customRedis ?? getRedisClient();
    const dedupKey = `share:dedup:${viewerId}:${contentType}:${contentId}`;
    const setRes = await redis.set(dedupKey, '1', 'EX', SHARE_DEDUP_TTL_SECONDS, 'NX');
    const shouldIncrement = setRes === 'OK';

    let shareCount = target.currentShareCount;
    if (shouldIncrement) {
      shareCount = await this.saveRepo.incrementShareCount(contentType, target.targetId);
      const now = new Date();
      const at = now.toISOString();

      try {
        await getShareEventsCollection(this.db()).insertOne({
          contentType,
          contentId,
          byUserId: viewerId,
          at: now,
        });
      } catch {
        // Non-blocking raw share event log
      }

      await this.publisher.publishContentShared({
        contentType,
        contentId,
        byUserId: viewerId,
        at,
      });

      try {
        const followerIds = await this.followRepo.getAllFollowerIds(target.ownerId);
        const candidates = Array.from(new Set([viewerId, target.ownerId, ...followerIds]));
        const blockedByOwner = await getBlockedUserIds(target.ownerId, candidates, this.db());
        const recipients = candidates.filter((id) => !blockedByOwner.has(id));
        await this.publisher.publishWsToUsers(recipients, 'core.content.shared', {
          contentType,
          contentId,
          byUserId: viewerId,
          shareCount,
          ...(target.postId ? { postId: target.postId } : {}),
          ...(target.reelId ? { reelId: target.reelId } : {}),
          at,
        });
      } catch {
        // Non-blocking WS broadcast
      }
    }

    return {
      url: target.url,
      shareCount,
    };
  }
}

export const defaultShareService = new ShareService();
