import { ObjectId, type Db } from 'mongodb';
import type { Redis } from 'ioredis';
import {
  getAnalyticsDailyCollection,
  getCommentThreadDepthCollection,
  getCommentsCollection,
  getDb,
  getEngagementEventsCollection,
  getImpressionsCollection,
  getPostsCollection,
  getProfilesCollection,
  getReelsCollection,
  getStoriesCollection,
  type AnalyticsContentType,
  type EngagementEventDocument,
  type EngagementEventType,
} from '../../db/mongo.js';
import { getRedisClient } from '../../db/redis.js';
import { computePublicUrl } from '../../lib/r2.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';

export interface DepthMetricCount {
  count: number;
  uniqueUsers: number;
}

export interface ReactionDepthCount extends DepthMetricCount {
  topEmojis: Array<{ emoji: string; count: number }>;
}

export interface TopCommenterEntry {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  commentCount: number;
}

export interface ContentEngagementDepthResponse {
  impressions: number;
  reach: number;
  engagements: {
    total: number;
    unique: number;
    breakdown: {
      like: DepthMetricCount;
      comment: DepthMetricCount;
      reply: DepthMetricCount;
      reaction: ReactionDepthCount;
      save: DepthMetricCount;
      share: DepthMetricCount;
      viewLong: DepthMetricCount;
    };
  };
  engagementRate: number;
  avgDepthPerUser: number;
  uniqueEngagedUsers: number;
  discussionScore: number;
  topCommenters: TopCommenterEntry[];
}

const DEPTH_CACHE_TTL_SECONDS = 60;

export class EngagementDepthService {
  private customDb?: Db;
  private customRedis?: Redis;

  constructor(customDb?: Db, customRedis?: Redis) {
    this.customDb = customDb;
    this.customRedis = customRedis;
  }

  private db(dbOverride?: Db): Db {
    return dbOverride ?? this.customDb ?? getDb();
  }

  private redis(): Redis | null {
    if (this.customRedis) return this.customRedis;
    try {
      return getRedisClient();
    } catch {
      return null;
    }
  }

  async recordThreadDepth(
    params: {
      commentId: ObjectId;
      postId: ObjectId;
      targetType: 'post' | 'reel';
      depth: number;
      authorId: string;
      createdAt?: Date;
    },
    dbOverride?: Db
  ): Promise<void> {
    const database = this.db(dbOverride);
    await getCommentThreadDepthCollection(database).updateOne(
      { _id: params.commentId },
      {
        $setOnInsert: {
          _id: params.commentId,
          commentId: params.commentId,
          postId: params.postId,
          targetType: params.targetType,
          depth: params.depth,
          authorId: params.authorId,
          createdAt: params.createdAt ?? new Date(),
        },
      },
      { upsert: true }
    );
  }

  async recordEngagementEvent(
    input: {
      contentType: AnalyticsContentType;
      contentId: string;
      userId: string;
      event: EngagementEventType;
      emoji?: string;
      refId?: string;
      at?: Date | string;
    },
    dbOverride?: Db
  ): Promise<void> {
    if (!input.contentId || !input.userId) return;
    const database = this.db(dbOverride);
    const col = getEngagementEventsCollection(database);
    const atDate =
      input.at instanceof Date ? input.at : input.at ? new Date(input.at) : new Date();

    const doc: Omit<EngagementEventDocument, '_id'> = {
      contentType: input.contentType,
      contentId: input.contentId,
      userId: input.userId,
      event: input.event,
      ...(input.emoji ? { emoji: input.emoji } : {}),
      ...(input.refId ? { refId: input.refId } : {}),
      at: Number.isNaN(atDate.getTime()) ? new Date() : atDate,
    };

    if (input.refId) {
      await col.updateOne({ refId: input.refId }, { $setOnInsert: doc }, { upsert: true });
    } else {
      await col.insertOne(doc);
    }
  }

  async removeEngagementEvent(
    filter: Partial<Pick<EngagementEventDocument, 'contentType' | 'contentId' | 'userId' | 'event' | 'refId'>>,
    dbOverride?: Db
  ): Promise<void> {
    const database = this.db(dbOverride);
    await getEngagementEventsCollection(database).deleteMany(filter as any);
  }

  /**
   * Maps events consumed from `nebron.events` into raw `engagement_events` rows.
   */
  async ingestStreamEvent(eventType: string, rawData: unknown, dbOverride?: Db): Promise<boolean> {
    const data = (rawData && typeof rawData === 'object' ? rawData : {}) as Record<string, any>;
    const database = this.db(dbOverride);

    switch (eventType) {
      case 'core.post.liked': {
        if (!data.postId || !data.userId) return true;
        await this.recordEngagementEvent(
          {
            contentType: 'post',
            contentId: data.postId,
            userId: data.userId,
            event: 'like',
            refId: `like:post:${data.postId}:${data.userId}`,
            at: data.at,
          },
          database
        );
        return true;
      }

      case 'core.post.unliked': {
        if (!data.postId || !data.userId) return true;
        await this.removeEngagementEvent(
          { contentType: 'post', contentId: data.postId, userId: data.userId, event: 'like' },
          database
        );
        return true;
      }

      case 'core.reel.liked': {
        if (!data.reelId || !data.userId) return true;
        await this.recordEngagementEvent(
          {
            contentType: 'reel',
            contentId: data.reelId,
            userId: data.userId,
            event: 'like',
            refId: `like:reel:${data.reelId}:${data.userId}`,
            at: data.at,
          },
          database
        );
        return true;
      }

      case 'core.reel.unliked': {
        if (!data.reelId || !data.userId) return true;
        await this.removeEngagementEvent(
          { contentType: 'reel', contentId: data.reelId, userId: data.userId, event: 'like' },
          database
        );
        return true;
      }

      case 'core.comment.created': {
        if (!data.commentId || !data.postId || !data.commentAuthorId) return true;
        let contentType: AnalyticsContentType = 'post';
        let engagementKind: 'comment' | 'reply' = 'comment';
        if (ObjectId.isValid(data.commentId)) {
          const comment = await getCommentsCollection(database).findOne(
            { _id: new ObjectId(data.commentId) },
            { projection: { targetType: 1, reelId: 1, postId: 1, parentCommentId: 1 } }
          );
          if (comment) {
            if (comment.targetType === 'reel' || (comment.reelId && !comment.postId)) {
              contentType = 'reel';
            }
            if (comment.parentCommentId) {
              engagementKind = 'reply';
            }
          }
        }
        await this.recordEngagementEvent(
          {
            contentType,
            contentId: data.postId,
            userId: data.commentAuthorId,
            event: engagementKind,
            refId: `comment:${data.commentId}`,
            at: data.at,
          },
          database
        );
        return true;
      }

      case 'core.comment.replied': {
        if (!data.commentId || !data.postId || !data.commentAuthorId) return true;
        let contentType: AnalyticsContentType = 'post';
        if (ObjectId.isValid(data.commentId)) {
          const comment = await getCommentsCollection(database).findOne(
            { _id: new ObjectId(data.commentId) },
            { projection: { targetType: 1, reelId: 1, postId: 1 } }
          );
          if (comment && (comment.targetType === 'reel' || (comment.reelId && !comment.postId))) {
            contentType = 'reel';
          }
        }
        await getEngagementEventsCollection(database).updateOne(
          { refId: `comment:${data.commentId}` },
          {
            $set: {
              contentType,
              contentId: data.postId,
              userId: data.commentAuthorId,
              event: 'reply',
              at: data.at ? new Date(data.at) : new Date(),
            },
          },
          { upsert: true }
        );
        return true;
      }

      case 'core.comment.reaction.added': {
        if (!data.commentId || !data.postId || !data.emoji || !data.userId) return true;
        let contentType: AnalyticsContentType = 'post';
        if (ObjectId.isValid(data.commentId)) {
          const comment = await getCommentsCollection(database).findOne(
            { _id: new ObjectId(data.commentId) },
            { projection: { targetType: 1, reelId: 1, postId: 1 } }
          );
          if (comment && (comment.targetType === 'reel' || (comment.reelId && !comment.postId))) {
            contentType = 'reel';
          }
        }
        await this.recordEngagementEvent(
          {
            contentType,
            contentId: data.postId,
            userId: data.userId,
            event: 'reaction',
            emoji: data.emoji,
            refId: `reaction:${data.commentId}:${data.emoji}:${data.userId}`,
            at: data.at,
          },
          database
        );
        return true;
      }

      case 'core.comment.reaction.removed': {
        if (!data.commentId || !data.emoji || !data.userId) return true;
        await this.removeEngagementEvent(
          { refId: `reaction:${data.commentId}:${data.emoji}:${data.userId}` },
          database
        );
        return true;
      }

      case 'core.post.saved': {
        if (!data.postId || !data.userId) return true;
        await this.recordEngagementEvent(
          {
            contentType: 'post',
            contentId: data.postId,
            userId: data.userId,
            event: 'save',
            refId: `save:post:${data.postId}:${data.userId}`,
            at: data.at,
          },
          database
        );
        return true;
      }

      case 'core.post.unsaved': {
        if (!data.postId || !data.userId) return true;
        await this.removeEngagementEvent(
          { contentType: 'post', contentId: data.postId, userId: data.userId, event: 'save' },
          database
        );
        return true;
      }

      case 'core.reel.saved': {
        if (!data.reelId || !data.userId) return true;
        await this.recordEngagementEvent(
          {
            contentType: 'reel',
            contentId: data.reelId,
            userId: data.userId,
            event: 'save',
            refId: `save:reel:${data.reelId}:${data.userId}`,
            at: data.at,
          },
          database
        );
        return true;
      }

      case 'core.reel.unsaved': {
        if (!data.reelId || !data.userId) return true;
        await this.removeEngagementEvent(
          { contentType: 'reel', contentId: data.reelId, userId: data.userId, event: 'save' },
          database
        );
        return true;
      }

      case 'core.content.shared': {
        if (!data.contentType || !data.contentId || !data.byUserId) return true;
        let targetType: AnalyticsContentType | null = null;
        let targetId = data.contentId as string;

        if (data.contentType === 'post' || data.contentType === 'reel') {
          targetType = data.contentType;
        } else if (data.contentType === 'comment' && ObjectId.isValid(data.contentId)) {
          const c = await getCommentsCollection(database).findOne(
            { _id: new ObjectId(data.contentId) },
            { projection: { targetType: 1, postId: 1, reelId: 1 } }
          );
          if (c) {
            if (c.targetType === 'reel' || (c.reelId && !c.postId)) {
              targetType = 'reel';
              targetId = c.reelId.toString();
            } else if (c.postId) {
              targetType = 'post';
              targetId = c.postId.toString();
            }
          }
        }

        if (targetType) {
          await this.recordEngagementEvent(
            {
              contentType: targetType,
              contentId: targetId,
              userId: data.byUserId,
              event: 'share',
              refId: `share:${data.contentType}:${data.contentId}:${data.byUserId}:${data.at || ''}`,
              at: data.at,
            },
            database
          );
        }
        return true;
      }

      default:
        return false;
    }
  }

  private async verifyContentOwnership(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string,
    database: Db
  ): Promise<void> {
    if (!ObjectId.isValid(contentId)) {
      const label = contentType.charAt(0).toUpperCase() + contentType.slice(1);
      throw new NotFoundError(`${label} not found`, `${contentType}_not_found`);
    }
    const oid = new ObjectId(contentId);

    if (contentType === 'post') {
      const doc = await getPostsCollection(database).findOne(
        { _id: oid, deleted: false },
        { projection: { authorId: 1 } }
      );
      if (!doc) throw new NotFoundError('Post not found', 'post_not_found');
      if (doc.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return;
    }

    if (contentType === 'reel') {
      const doc = await getReelsCollection(database).findOne(
        { _id: oid, deleted: false },
        { projection: { authorId: 1 } }
      );
      if (!doc) throw new NotFoundError('Reel not found', 'reel_not_found');
      if (doc.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return;
    }

    const story = await getStoriesCollection(database).findOne(
      { _id: oid },
      { projection: { authorId: 1 } }
    );
    if (story) {
      if (story.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return;
    }

    const dailyAny = await getAnalyticsDailyCollection(database).findOne(
      { contentType: 'story', contentId },
      { projection: { authorId: 1 } }
    );
    if (!dailyAny) throw new NotFoundError('Story not found', 'story_not_found');
    if (dailyAny.authorId !== creatorId) {
      throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
    }
  }

  async getContentDepth(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<ContentEngagementDepthResponse> {
    const database = this.db();
    await this.verifyContentOwnership(creatorId, contentType, contentId, database);

    const cacheKey = `analytics:depth:${creatorId}:${contentType}:${contentId}`;
    const r = this.redis();
    if (r) {
      try {
        const cached = await r.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as ContentEngagementDepthResponse;
        }
      } catch {
        // Ignore Redis cache read failure
      }
    }

    const targetFilter =
      contentType === 'reel'
        ? { reelId: new ObjectId(contentId), deleted: false }
        : { postId: new ObjectId(contentId), deleted: false };

    const [impressionDocs, eventDocs, commentAuthorDocs] = await Promise.all([
      getImpressionsCollection(database)
        .find({ contentType, contentId }, { projection: { _id: 0, userId: 1 } })
        .toArray(),
      getEngagementEventsCollection(database)
        .find(
          { contentType, contentId },
          { projection: { _id: 0, event: 1, userId: 1, emoji: 1 } }
        )
        .toArray(),
      contentType === 'post' || contentType === 'reel'
        ? getCommentsCollection(database)
            .find(targetFilter, { projection: { _id: 0, authorId: 1 } })
            .toArray()
        : Promise.resolve([]),
    ]);

    const impressions = impressionDocs.length;
    const reachUsers = new Set<string>();
    for (const imp of impressionDocs) {
      if (imp.userId) reachUsers.add(imp.userId);
    }
    const reach = reachUsers.size;

    const counters: Record<
      'like' | 'comment' | 'reply' | 'reaction' | 'save' | 'share' | 'viewLong',
      { count: number; users: Set<string> }
    > = {
      like: { count: 0, users: new Set() },
      comment: { count: 0, users: new Set() },
      reply: { count: 0, users: new Set() },
      reaction: { count: 0, users: new Set() },
      save: { count: 0, users: new Set() },
      share: { count: 0, users: new Set() },
      viewLong: { count: 0, users: new Set() },
    };

    const allEngagedUsers = new Set<string>();
    const emojiCounts = new Map<string, number>();
    let total = 0;

    for (const ev of eventDocs) {
      const bucket =
        ev.event === 'view_long'
          ? counters.viewLong
          : ev.event === 'like' ||
              ev.event === 'comment' ||
              ev.event === 'reply' ||
              ev.event === 'reaction' ||
              ev.event === 'save' ||
              ev.event === 'share'
            ? counters[ev.event]
            : null;
      if (!bucket) continue;

      bucket.count++;
      total++;
      if (ev.userId) {
        bucket.users.add(ev.userId);
        allEngagedUsers.add(ev.userId);
      }
      if (ev.event === 'reaction' && ev.emoji) {
        emojiCounts.set(ev.emoji, (emojiCounts.get(ev.emoji) ?? 0) + 1);
      }
    }

    const topEmojis = Array.from(emojiCounts.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const uniqueEngagedUsers = allEngagedUsers.size;
    const engagementRate = impressions > 0 ? Number((total / impressions).toFixed(4)) : 0;
    const avgDepthPerUser =
      uniqueEngagedUsers > 0 ? Number((total / uniqueEngagedUsers).toFixed(2)) : 0;
    const discussionScore = Number(
      (
        counters.comment.count +
        counters.reply.count * 2 +
        counters.reaction.count * 0.5
      ).toFixed(2)
    );

    const commenterCounts = new Map<string, number>();
    for (const doc of commentAuthorDocs) {
      if (doc.authorId) {
        commenterCounts.set(doc.authorId, (commenterCounts.get(doc.authorId) ?? 0) + 1);
      }
    }
    const sortedCommenters = Array.from(commenterCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const commenterIds = sortedCommenters.map(([uid]) => uid);
    const profiles =
      commenterIds.length > 0
        ? await getProfilesCollection(database)
            .find({ userId: { $in: commenterIds } })
            .toArray()
        : [];
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    const topCommenters: TopCommenterEntry[] = sortedCommenters.map(([userId, commentCount]) => {
      const p = profileMap.get(userId);
      return {
        userId,
        username: p?.username ?? 'unknown',
        name: p?.name ?? null,
        avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
        commentCount,
      };
    });

    const result: ContentEngagementDepthResponse = {
      impressions,
      reach,
      engagements: {
        total,
        unique: uniqueEngagedUsers,
        breakdown: {
          like: { count: counters.like.count, uniqueUsers: counters.like.users.size },
          comment: { count: counters.comment.count, uniqueUsers: counters.comment.users.size },
          reply: { count: counters.reply.count, uniqueUsers: counters.reply.users.size },
          reaction: {
            count: counters.reaction.count,
            uniqueUsers: counters.reaction.users.size,
            topEmojis,
          },
          save: { count: counters.save.count, uniqueUsers: counters.save.users.size },
          share: { count: counters.share.count, uniqueUsers: counters.share.users.size },
          viewLong: { count: counters.viewLong.count, uniqueUsers: counters.viewLong.users.size },
        },
      },
      engagementRate,
      avgDepthPerUser,
      uniqueEngagedUsers,
      discussionScore,
      topCommenters,
    };

    if (r) {
      try {
        await r.set(cacheKey, JSON.stringify(result), 'EX', DEPTH_CACHE_TTL_SECONDS);
      } catch {
        // Ignore Redis cache write failure
      }
    }

    return result;
  }
}

export const defaultEngagementDepthService = new EngagementDepthService();
