import crypto from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import type { Redis } from 'ioredis';
import {
  getAnalyticsDailyCollection,
  getContentViewsCollection,
  getCreatorDailyStatsCollection,
  getDb,
  getFollowSourcesCollection,
  getFollowsCollection,
  getImpressionsCollection,
  getPostsCollection,
  getProfileVisitsCollection,
  getProfilesCollection,
  getReelsCollection,
  getStoriesCollection,
  type AnalyticsContentType,
  type AnalyticsDailyDocument,
  type AnalyticsSource,
  type CreatorDailyStatsDocument,
} from '../../db/mongo.js';
import { computePublicUrl, resolveMediaUrl } from '../../lib/r2.js';
import { getRedisClient } from '../../db/redis.js';
import { defaultEngagementDepthService } from './engagement-depth.js';
import { REEL_VIEWS_BUFFER_KEY } from '../../jobs/reel-jobs.js';
import { BlockedError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { isBlockedPair } from '../social/block-filter.js';
import {
  aggregateRawMetricsWindow,
  createEmptyDayMetrics,
  dayCompositeKey,
  getPeriodRange,
  itemCompositeKey,
  toUtcDateKey,
  type AnalyticsPeriod,
  type ContentTargetRef,
  type DayContentMetrics,
} from './analytics.helpers.js';

const IMPRESSION_DEDUP_TTL = 24 * 60 * 60; // 24h
const PROFILE_VISIT_DEDUP_TTL = 6 * 60 * 60; // 6h

export interface OverviewTopContentItem {
  contentType: AnalyticsContentType;
  contentId: string;
  preview: string;
  thumbnailUrl?: string | null;
  metrics: {
    impressions: number;
    reach: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    engagementScore: number;
  };
}

export interface OverviewDailyActivityPoint {
  date: string;
  followersGained: number;
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagement: number;
}

export interface OverviewMetricsResponse {
  period: AnalyticsPeriod;
  followers: { total: number; gained: number };
  profileVisits: number;
  content: { posts: number; reels: number; stories: number };
  engagement: {
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    views: number;
    impressions: number;
    reach: number;
  };
  topContent: OverviewTopContentItem[];
  topByType: {
    post: OverviewTopContentItem | null;
    reel: OverviewTopContentItem | null;
    story: OverviewTopContentItem | null;
  };
  dailyActivity: OverviewDailyActivityPoint[];
  activityHeatmap: number[][];
  bestPerformingDay: string | null;
  bestTimeToPost: number[];
}

export interface PostAnalyticsRow {
  postId: string;
  preview: string;
  thumbnailUrl: string | null;
  createdAt: string;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  profileVisits: number;
  newFollowers: number;
  engagementRate: number;
}

export interface ReelAnalyticsRow {
  reelId: string;
  preview: string;
  thumbnailUrl: string | null;
  createdAt: string;
  views: number;
  uniqueViews: number;
  watchSeconds: number;
  avgWatchSeconds: number;
  completionRate: number;
  replays: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  newFollowers: number;
}

export interface StoryAnalyticsRow {
  storyId: string;
  preview: string;
  thumbnailUrl: string | null;
  mediaType: 'image' | 'video' | null;
  createdAt: string;
  uniqueViewers: number;
  totalViews: number;
  completionRate: number;
  tapsForward: number;
  tapsBack: number;
  exits: number;
  replies: number;
}

export interface TimeSeriesBucket {
  date: string;
  impressions: number;
  reach: number;
  views: number;
  uniqueViews: number;
  watchSeconds: number;
  completions: number;
  tapsForward: number;
  tapsBack: number;
  exits: number;
  replays: number;
  likes: number;
  comments: number;
  replies: number;
  shares: number;
  saves: number;
}

export interface ContentDeepDiveResponse {
  contentType: AnalyticsContentType;
  contentId: string;
  preview: string;
  thumbnailUrl: string | null;
  mediaType?: 'image' | 'video' | null;
  createdAt: string;
  period: AnalyticsPeriod;
  profileVisits: number;
  newFollowers: number;
  totals: Omit<TimeSeriesBucket, 'date'>;
  series: TimeSeriesBucket[];
  trafficSources: Array<{ source: string; count: number }>;
  watchThroughBuckets?: Array<{
    bucket: string;
    minPct: number;
    count: number;
    percentage: number;
  }>;
  funnel?: {
    impressions: number;
    views: number;
    completed: number;
    replied: number;
  };
  hourlyViews?: Array<{ hourOffset: number; label: string; views: number }>;
}

export interface AudienceAnalyticsResponse {
  followerGrowth: Array<{ date: string; count: number }>;
  activeHours: Array<{ hour: number; followers: number }>;
  followSources: Array<{ source: string; count: number }>;
  activityHeatmap: number[][];
}

/**
 * Handles analytics beacon ingestion (with Redis dedup) and creator analytics queries.
 */
export class AnalyticsService {
  private customDb?: Db;
  private customRedis?: Redis;

  constructor(customDb?: Db, customRedis?: Redis) {
    this.customDb = customDb;
    this.customRedis = customRedis;
  }

  private db(): Db {
    return this.customDb ?? getDb();
  }

  private redis(): Redis {
    return this.customRedis ?? getRedisClient();
  }

  private async getBufferedReelViews(reelIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (reelIds.length === 0) return map;
    try {
      const vals = await this.redis().hmget(REEL_VIEWS_BUFFER_KEY, ...reelIds);
      for (let i = 0; i < reelIds.length; i++) {
        const n = Number.parseInt(vals[i] ?? '0', 10);
        if (Number.isFinite(n) && n > 0) map.set(reelIds[i], n);
      }
    } catch {
      // Gracefully fallback to DB viewCount only
    }
    return map;
  }

  private parseObjectId(id: string, code: string, label: string): ObjectId {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      throw new NotFoundError(`${label} not found`, code);
    }
    return new ObjectId(id);
  }

  private async resolveContentOwner(
    viewerId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<{ authorId: string; duration?: number }> {
    const oid = this.parseObjectId(contentId, `${contentType}_not_found`, contentType);

    let authorId: string | undefined;
    let duration: number | undefined;

    if (contentType === 'post') {
      const doc = await getPostsCollection(this.db()).findOne({ _id: oid, deleted: false });
      authorId = doc?.authorId;
    } else if (contentType === 'reel') {
      const doc = await getReelsCollection(this.db()).findOne({ _id: oid, deleted: false });
      authorId = doc?.authorId;
      duration = doc?.duration;
    } else {
      const doc = await getStoriesCollection(this.db()).findOne({ _id: oid });
      authorId = doc?.authorId;
      duration = doc?.duration;
    }

    if (!authorId) {
      const label = contentType.charAt(0).toUpperCase() + contentType.slice(1);
      throw new NotFoundError(`${label} not found`, `${contentType}_not_found`);
    }

    if (authorId !== viewerId && (await isBlockedPair(viewerId, authorId, this.db()))) {
      throw new BlockedError();
    }

    return { authorId, duration };
  }

  async recordImpression(
    viewerId: string,
    input: { contentType: AnalyticsContentType; contentId: string; source: AnalyticsSource }
  ): Promise<boolean> {
    await this.resolveContentOwner(viewerId, input.contentType, input.contentId);

    const dedupKey = `impression:${input.contentId}:${viewerId}`;
    const ok = await this.redis().set(dedupKey, '1', 'EX', IMPRESSION_DEDUP_TTL, 'NX');
    if (ok !== 'OK') {
      return false;
    }

    await getImpressionsCollection(this.db()).insertOne({
      userId: viewerId,
      contentType: input.contentType,
      contentId: input.contentId,
      source: input.source,
      seenAt: new Date(),
    });
    return true;
  }

  async startView(
    viewerId: string,
    input: {
      contentType: 'reel' | 'story';
      contentId: string;
      source?: string;
      sessionId?: string;
      totalSeconds?: number;
      replayed?: boolean;
    }
  ): Promise<{ viewId: string }> {
    const meta = await this.resolveContentOwner(viewerId, input.contentType, input.contentId);
    const res = await getContentViewsCollection(this.db()).insertOne({
      userId: viewerId,
      contentType: input.contentType,
      contentId: input.contentId,
      sessionId: input.sessionId || crypto.randomUUID(),
      startedAt: new Date(),
      endedAt: null,
      watchedSeconds: 0,
      totalSeconds: input.totalSeconds ?? meta.duration ?? 0,
      completed: false,
      source: input.source || 'feed',
      tapsForward: 0,
      tapsBack: 0,
      exited: false,
      replayed: Boolean(input.replayed),
    });
    return { viewId: res.insertedId.toString() };
  }

  async heartbeatView(
    viewerId: string,
    input: {
      viewId: string;
      watchedSeconds: number;
      currentPosition?: number;
      tapsForward?: number;
      tapsBack?: number;
    }
  ): Promise<void> {
    const oid = this.parseObjectId(input.viewId, 'view_not_found', 'View session');
    const col = getContentViewsCollection(this.db());
    const existing = await col.findOne({ _id: oid });
    if (!existing) {
      throw new NotFoundError('View session not found', 'view_not_found');
    }
    if (existing.userId !== viewerId) {
      throw new ForbiddenError('Cannot update another user view session', 'forbidden');
    }

    await col.updateOne(
      { _id: oid },
      {
        $set: {
          endedAt: new Date(),
          watchedSeconds: Math.max(0, input.watchedSeconds),
          ...(input.tapsForward !== undefined ? { tapsForward: input.tapsForward } : {}),
          ...(input.tapsBack !== undefined ? { tapsBack: input.tapsBack } : {}),
        },
      }
    );

    if (input.watchedSeconds >= 5) {
      await defaultEngagementDepthService.recordEngagementEvent(
        {
          contentType: existing.contentType,
          contentId: existing.contentId,
          userId: viewerId,
          event: 'view_long',
          refId: `view_long:${oid.toString()}`,
        },
        this.db()
      );
    }
  }

  async endView(
    viewerId: string,
    input: {
      viewId: string;
      watchedSeconds: number;
      completed: boolean;
      tapsForward?: number;
      tapsBack?: number;
      exited?: boolean;
      replayed?: boolean;
    }
  ): Promise<void> {
    const oid = this.parseObjectId(input.viewId, 'view_not_found', 'View session');
    const col = getContentViewsCollection(this.db());
    const existing = await col.findOne({ _id: oid });
    if (!existing) {
      throw new NotFoundError('View session not found', 'view_not_found');
    }
    if (existing.userId !== viewerId) {
      throw new ForbiddenError('Cannot finalize another user view session', 'forbidden');
    }

    await col.updateOne(
      { _id: oid },
      {
        $set: {
          endedAt: new Date(),
          watchedSeconds: Math.max(0, input.watchedSeconds),
          completed: input.completed,
          ...(input.tapsForward !== undefined ? { tapsForward: input.tapsForward } : {}),
          ...(input.tapsBack !== undefined ? { tapsBack: input.tapsBack } : {}),
          ...(input.exited !== undefined ? { exited: input.exited } : {}),
          ...(input.replayed !== undefined ? { replayed: input.replayed } : {}),
        },
      }
    );

    if (input.watchedSeconds >= 5) {
      await defaultEngagementDepthService.recordEngagementEvent(
        {
          contentType: existing.contentType,
          contentId: existing.contentId,
          userId: viewerId,
          event: 'view_long',
          refId: `view_long:${oid.toString()}`,
        },
        this.db()
      );
    }
  }

  async recordProfileVisit(visitorId: string, visitedUserId: string): Promise<boolean> {
    const target = await getProfilesCollection(this.db()).findOne({ userId: visitedUserId });
    if (!target) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    if (visitorId === visitedUserId) {
      return false;
    }

    if (await isBlockedPair(visitorId, visitedUserId, this.db())) {
      throw new BlockedError();
    }

    const dedupKey = `profile_visit:${visitedUserId}:${visitorId}`;
    const ok = await this.redis().set(dedupKey, '1', 'EX', PROFILE_VISIT_DEDUP_TTL, 'NX');
    if (ok !== 'OK') {
      return false;
    }

    await getProfileVisitsCollection(this.db()).insertOne({
      visitorId,
      visitedUserId,
      at: new Date(),
    });
    return true;
  }

  private dailyDocToDayMetrics(doc: AnalyticsDailyDocument): DayContentMetrics {
    const m = createEmptyDayMetrics();
    m.impressions = doc.impressions ?? 0;
    m.reach = doc.reach ?? 0;
    m.views = doc.views ?? 0;
    m.uniqueViews = doc.uniqueViews ?? 0;
    m.watchSeconds = doc.watchSeconds ?? 0;
    m.completions = doc.completions ?? 0;
    m.tapsForward = doc.tapsForward ?? 0;
    m.tapsBack = doc.tapsBack ?? 0;
    m.exits = doc.exits ?? 0;
    m.replays = doc.replays ?? 0;
    m.likes = doc.likes ?? 0;
    m.comments = doc.comments ?? 0;
    m.replies = doc.replies ?? 0;
    m.shares = doc.shares ?? 0;
    m.saves = doc.saves ?? 0;
    return m;
  }

  private async loadCreatorContentAndMetrics(
    creatorId: string,
    period: AnalyticsPeriod
  ) {
    const range = getPeriodRange(period);
    const database = this.db();

    const [posts, reels, stories, dailyDocs, creatorStatsDocs] = await Promise.all([
      getPostsCollection(database).find({ authorId: creatorId, deleted: false }).sort({ createdAt: -1 }).toArray(),
      getReelsCollection(database).find({ authorId: creatorId, deleted: false }).sort({ createdAt: -1 }).toArray(),
      getStoriesCollection(database).find({ authorId: creatorId }).sort({ createdAt: -1 }).toArray(),
      getAnalyticsDailyCollection(database)
        .find({ authorId: creatorId, date: { $in: range.dateKeys } })
        .toArray(),
      getCreatorDailyStatsCollection(database)
        .find({ userId: creatorId, date: { $in: range.dateKeys } })
        .toArray(),
    ]);

    const targets: ContentTargetRef[] = [];
    const seenKeys = new Set<string>();
    const postDocMap = new Map(posts.map((p) => [p._id.toString(), p]));
    const reelDocMap = new Map(reels.map((r) => [r._id.toString(), r]));
    const storyDocMap = new Map(stories.map((s) => [s._id.toString(), s]));

    for (const p of posts) {
      const cid = p._id.toString();
      seenKeys.add(itemCompositeKey('post', cid));
      targets.push({
        contentType: 'post',
        contentId: cid,
        authorId: p.authorId,
        preview: (p.body || '').slice(0, 120),
        createdAt: p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt),
      });
    }
    for (const r of reels) {
      const cid = r._id.toString();
      seenKeys.add(itemCompositeKey('reel', cid));
      targets.push({
        contentType: 'reel',
        contentId: cid,
        authorId: r.authorId,
        preview: (r.caption || 'Reel').slice(0, 120),
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
      });
    }
    for (const s of stories) {
      const cid = s._id.toString();
      seenKeys.add(itemCompositeKey('story', cid));
      targets.push({
        contentType: 'story',
        contentId: cid,
        authorId: s.authorId,
        preview: (s.caption || 'Story').slice(0, 120),
        createdAt: s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt),
        storyViewers: s.viewers ?? [],
      });
    }
    // Preserve expired/historical rolled-up content in analytics_daily
    for (const d of dailyDocs) {
      const key = itemCompositeKey(d.contentType, d.contentId);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      targets.push({
        contentType: d.contentType,
        contentId: d.contentId,
        authorId: d.authorId,
        preview: d.preview || d.contentType,
        createdAt: d.contentCreatedAt instanceof Date
          ? d.contentCreatedAt
          : new Date(d.contentCreatedAt ?? `${d.date}T00:00:00.000Z`),
      });
    }

    const dailyMap = new Map<string, AnalyticsDailyDocument>();
    for (const d of dailyDocs) {
      dailyMap.set(dayCompositeKey(d.contentType, d.contentId, d.date), d);
    }

    const creatorDailyMap = new Map<string, CreatorDailyStatsDocument>();
    for (const cs of creatorStatsDocs) {
      creatorDailyMap.set(cs.date, cs);
    }

    const { byItemDay } = await aggregateRawMetricsWindow(database, targets, range.start, range.end);

    return {
      range,
      targets,
      posts,
      reels,
      stories,
      postDocMap,
      reelDocMap,
      storyDocMap,
      dailyMap,
      creatorDailyMap,
      byItemDay,
    };
  }

  private mergePeriodTotalsForItem(
    target: ContentTargetRef,
    dateKeys: string[],
    todayKey: string,
    dailyMap: Map<string, AnalyticsDailyDocument>,
    byItemDay: Map<string, DayContentMetrics>
  ): {
    totals: DayContentMetrics;
    profileVisits: number;
    newFollowers: number;
    series: TimeSeriesBucket[];
    dayEngagementScores: Map<string, number>;
  } {
    const totals = createEmptyDayMetrics();
    let profileVisits = 0;
    let newFollowers = 0;
    const series: TimeSeriesBucket[] = [];
    const dayEngagementScores = new Map<string, number>();

    for (const dateKey of dateKeys) {
      const dk = dayCompositeKey(target.contentType, target.contentId, dateKey);
      const rolled = dailyMap.get(dk);
      const live = byItemDay.get(dk);

      let bucket: DayContentMetrics;
      if (rolled && dateKey !== todayKey) {
        bucket = this.dailyDocToDayMetrics(rolled);
        profileVisits += rolled.profileVisits ?? 0;
        newFollowers += rolled.newFollowers ?? 0;
      } else if (rolled && live) {
        bucket = createEmptyDayMetrics();
        const r = this.dailyDocToDayMetrics(rolled);
        bucket.impressions = Math.max(r.impressions, live.impressions);
        bucket.reach = Math.max(r.reach, live.reach);
        bucket.views = Math.max(r.views, live.views);
        bucket.uniqueViews = Math.max(r.uniqueViews, live.uniqueViews);
        bucket.watchSeconds = Math.max(r.watchSeconds, live.watchSeconds);
        bucket.completions = Math.max(r.completions, live.completions);
        bucket.tapsForward = Math.max(r.tapsForward, live.tapsForward);
        bucket.tapsBack = Math.max(r.tapsBack, live.tapsBack);
        bucket.exits = Math.max(r.exits, live.exits);
        bucket.replays = Math.max(r.replays, live.replays);
        bucket.likes = Math.max(r.likes, live.likes);
        bucket.comments = Math.max(r.comments, live.comments);
        bucket.replies = Math.max(r.replies, live.replies);
        bucket.shares = Math.max(r.shares, live.shares);
        bucket.saves = Math.max(r.saves, live.saves);
        bucket.hourEngagement = live.hourEngagement;
        profileVisits += rolled.profileVisits ?? 0;
        newFollowers += rolled.newFollowers ?? 0;
      } else if (rolled) {
        bucket = this.dailyDocToDayMetrics(rolled);
        profileVisits += rolled.profileVisits ?? 0;
        newFollowers += rolled.newFollowers ?? 0;
      } else {
        bucket = live ?? createEmptyDayMetrics();
      }

      totals.impressions += bucket.impressions;
      totals.reach += bucket.reach;
      totals.views += bucket.views;
      totals.uniqueViews += bucket.uniqueViews;
      totals.watchSeconds += bucket.watchSeconds;
      totals.completions += bucket.completions;
      totals.tapsForward += bucket.tapsForward;
      totals.tapsBack += bucket.tapsBack;
      totals.exits += bucket.exits;
      totals.replays += bucket.replays;
      totals.likes += bucket.likes;
      totals.comments += bucket.comments;
      totals.replies += bucket.replies;
      totals.shares += bucket.shares;
      totals.saves += bucket.saves;
      for (let h = 0; h < 24; h++) {
        totals.hourEngagement[h] += bucket.hourEngagement[h] ?? 0;
      }

      const dayScore =
        bucket.impressions +
        bucket.views +
        bucket.likes +
        bucket.comments +
        bucket.shares +
        bucket.saves;
      dayEngagementScores.set(dateKey, dayScore);

      series.push({
        date: dateKey,
        impressions: bucket.impressions,
        reach: bucket.reach,
        views: bucket.views,
        uniqueViews: bucket.uniqueViews,
        watchSeconds: bucket.watchSeconds,
        completions: bucket.completions,
        tapsForward: bucket.tapsForward,
        tapsBack: bucket.tapsBack,
        exits: bucket.exits,
        replays: bucket.replays,
        likes: bucket.likes,
        comments: bucket.comments,
        replies: bucket.replies,
        shares: bucket.shares,
        saves: bucket.saves,
      });
    }

    return { totals, profileVisits, newFollowers, series, dayEngagementScores };
  }

  async getOverview(creatorId: string, period: AnalyticsPeriod): Promise<OverviewMetricsResponse> {
    const data = await this.loadCreatorContentAndMetrics(creatorId, period);
    const { range, targets, posts, reels, stories, reelDocMap, postDocMap, storyDocMap, dailyMap, creatorDailyMap, byItemDay } = data;
    const database = this.db();
    const targetIds = targets.map((t) => t.contentId);
    const bufferedReelViews = await this.getBufferedReelViews(reels.map((r) => r._id.toString()));

    const [
      profile,
      rawFollowsInPeriod,
      rawProfileVisitsInPeriod,
      rawImpressionsInPeriod,
      rawViewsInPeriod,
    ] = await Promise.all([
      getProfilesCollection(database).findOne({ userId: creatorId }),
      getFollowsCollection(database)
        .find({ followingId: creatorId, createdAt: { $gte: range.start, $lt: range.end } })
        .toArray(),
      getProfileVisitsCollection(database)
        .find(
          { visitedUserId: creatorId, at: { $gte: range.start, $lt: range.end } },
          { projection: { _id: 0, at: 1 } }
        )
        .toArray(),
      targetIds.length > 0
        ? getImpressionsCollection(database)
            .find({
              contentId: { $in: targetIds },
              seenAt: { $gte: range.start, $lt: range.end },
            })
            .project({ _id: 0, userId: 1, seenAt: 1 })
            .toArray()
        : Promise.resolve([]),
      targetIds.length > 0
        ? getContentViewsCollection(database)
            .find({
              contentId: { $in: targetIds },
              startedAt: { $gte: range.start, $lt: range.end },
            })
            .project({ _id: 0, startedAt: 1 })
            .toArray()
        : Promise.resolve([]),
    ]);

    const hourHistogram = new Array(24).fill(0);
    const activityHeatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const dayScoreTotals = new Map<string, number>();

    const dailyActivityMap = new Map<string, OverviewDailyActivityPoint>();
    for (const dateKey of range.dateKeys) {
      dailyActivityMap.set(dateKey, {
        date: dateKey,
        followersGained: 0,
        impressions: 0,
        reach: 0,
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        engagement: 0,
      });
    }

    let likes = 0;
    let comments = 0;
    let shares = 0;
    let saves = 0;
    let views = 0;
    let impressions = 0;
    let rolledPastReach = 0;

    const topCandidates: OverviewTopContentItem[] = [];

    for (const target of targets) {
      const merged = this.mergePeriodTotalsForItem(
        target,
        range.dateKeys,
        range.todayKey,
        dailyMap,
        byItemDay
      );
      const t = merged.totals;
      const inPeriod = target.createdAt >= range.start && target.createdAt <= range.end;
      let itemLikes = t.likes;
      let itemComments = t.comments;
      let itemShares = t.shares;
      let itemSaves = t.saves;
      let itemViews = t.views;
      let thumbnailUrl: string | null = null;

      if (target.contentType === 'post') {
        const pDoc = postDocMap.get(target.contentId);
        thumbnailUrl = pDoc ? resolveMediaUrl(pDoc.imageKey, pDoc.imageUrl) : null;
        if (inPeriod && pDoc) {
          itemLikes = Math.max(itemLikes, pDoc.likeCount ?? 0);
          itemComments = Math.max(itemComments, pDoc.commentCount ?? 0);
          itemShares = Math.max(itemShares, pDoc.shareCount ?? 0);
          itemSaves = Math.max(itemSaves, pDoc.saveCount ?? 0);
        }
      } else if (target.contentType === 'reel') {
        const rDoc = reelDocMap.get(target.contentId);
        thumbnailUrl = rDoc ? resolveMediaUrl(rDoc.thumbnailKey, rDoc.thumbnailUrl) : null;
        if (inPeriod && rDoc) {
          itemLikes = Math.max(itemLikes, rDoc.likeCount ?? 0);
          itemComments = Math.max(itemComments, rDoc.commentCount ?? 0);
          itemShares = Math.max(itemShares, rDoc.shareCount ?? 0);
          itemSaves = Math.max(itemSaves, rDoc.saveCount ?? 0);
          itemViews = Math.max(itemViews, (rDoc.viewCount ?? 0) + (bufferedReelViews.get(target.contentId) ?? 0));
        }
      } else {
        const sDoc = storyDocMap.get(target.contentId);
        if (sDoc) {
          thumbnailUrl = sDoc.thumbnailKey
            ? computePublicUrl(sDoc.thumbnailKey)
            : sDoc.mediaType === 'image'
              ? resolveMediaUrl(sDoc.mediaKey, sDoc.mediaUrl)
              : null;
        }
      }

      for (const b of merged.series) {
        const dayPt = dailyActivityMap.get(b.date);
        if (!dayPt) continue;
        dayPt.impressions += b.impressions;
        dayPt.reach += b.reach;
        dayPt.views += b.views;
        dayPt.likes += b.likes;
        dayPt.comments += b.comments;
        dayPt.shares += b.shares;
        dayPt.saves += b.saves;
      }

      // Attribute any denormalized counter deltas on creation day inside period
      const createdDayPt = dailyActivityMap.get(toUtcDateKey(target.createdAt));
      if (inPeriod && createdDayPt) {
        createdDayPt.likes += Math.max(0, itemLikes - t.likes);
        createdDayPt.comments += Math.max(0, itemComments - t.comments);
        createdDayPt.shares += Math.max(0, itemShares - t.shares);
        createdDayPt.saves += Math.max(0, itemSaves - t.saves);
        createdDayPt.views += Math.max(0, itemViews - t.views);
      }

      likes += itemLikes;
      comments += itemComments;
      shares += itemShares;
      saves += itemSaves;
      views += itemViews;
      impressions += t.impressions;

      for (let h = 0; h < 24; h++) {
        hourHistogram[h] += t.hourEngagement[h] ?? 0;
      }
      for (const [dKey, sc] of merged.dayEngagementScores.entries()) {
        dayScoreTotals.set(dKey, (dayScoreTotals.get(dKey) ?? 0) + sc);
      }

      const engagementScore =
        t.impressions + itemViews + itemLikes * 2 + itemComments * 3 + itemShares * 4 + itemSaves * 3;
      if (engagementScore > 0 || target.createdAt >= range.start) {
        topCandidates.push({
          contentType: target.contentType,
          contentId: target.contentId,
          preview: target.preview,
          thumbnailUrl,
          metrics: {
            impressions: t.impressions,
            reach: t.reach,
            views: itemViews,
            likes: itemLikes,
            comments: itemComments,
            shares: itemShares,
            saves: itemSaves,
            engagementScore,
          },
        });
      }
    }

    // Compute unique reach across period: raw unique userIds + any rolled past dates missing raw logs
    const uniqueReachSet = new Set<string>();
    const rawDatesSeen = new Set<string>();
    for (const imp of rawImpressionsInPeriod) {
      if (imp.userId) uniqueReachSet.add(String(imp.userId));
      if (imp.seenAt) {
        const d = imp.seenAt instanceof Date ? imp.seenAt : new Date(imp.seenAt);
        rawDatesSeen.add(toUtcDateKey(d));
        activityHeatmap[d.getUTCDay()][d.getUTCHours()]++;
      }
    }
    for (const vw of rawViewsInPeriod) {
      if (vw.startedAt) {
        const d = vw.startedAt instanceof Date ? vw.startedAt : new Date(vw.startedAt);
        activityHeatmap[d.getUTCDay()][d.getUTCHours()]++;
      }
    }
    for (const dateKey of range.dateKeys) {
      if (dateKey !== range.todayKey && !rawDatesSeen.has(dateKey)) {
        const cs = creatorDailyMap.get(dateKey);
        if (cs) rolledPastReach += cs.totalReach ?? 0;
      }
    }
    const totalReach = uniqueReachSet.size + rolledPastReach;

    // Gained followers combining rolled past dates + raw follows
    const rawFollowsByDay = new Map<string, number>();
    for (const f of rawFollowsInPeriod) {
      const d = f.createdAt instanceof Date ? f.createdAt : new Date(f.createdAt);
      const dk = toUtcDateKey(d);
      rawFollowsByDay.set(dk, (rawFollowsByDay.get(dk) ?? 0) + 1);
      activityHeatmap[d.getUTCDay()][d.getUTCHours()]++;
    }
    const rawVisitsByDay = new Map<string, number>();
    for (const pv of rawProfileVisitsInPeriod) {
      const d = pv.at instanceof Date ? pv.at : new Date(pv.at);
      const dk = toUtcDateKey(d);
      rawVisitsByDay.set(dk, (rawVisitsByDay.get(dk) ?? 0) + 1);
      activityHeatmap[d.getUTCDay()][d.getUTCHours()]++;
    }

    let followersGained = 0;
    let profileVisits = 0;
    for (const dateKey of range.dateKeys) {
      const cs = creatorDailyMap.get(dateKey);
      const rawCount = rawFollowsByDay.get(dateKey) ?? 0;
      const dayFollows =
        cs && dateKey !== range.todayKey ? Math.max(cs.followersGained ?? 0, rawCount) : rawCount;
      followersGained += dayFollows;

      const rawV = rawVisitsByDay.get(dateKey) ?? 0;
      profileVisits +=
        cs && dateKey !== range.todayKey ? Math.max(cs.profileVisits ?? 0, rawV) : rawV;

      const dayPt = dailyActivityMap.get(dateKey);
      if (dayPt) {
        dayPt.followersGained = dayFollows;
        dayPt.engagement = dayPt.likes + dayPt.comments + dayPt.shares + dayPt.saves;
      }
    }

    topCandidates.sort((a, b) => b.metrics.engagementScore - a.metrics.engagementScore);

    let bestPerformingDay: string | null = null;
    let bestDayScore = 0;
    for (const [dKey, sc] of dayScoreTotals.entries()) {
      if (sc > bestDayScore || (sc > 0 && sc === bestDayScore && dKey > (bestPerformingDay ?? ''))) {
        bestDayScore = sc;
        bestPerformingDay = dKey;
      }
    }

    const bestTimeToPost = hourHistogram
      .map((count, hour) => ({ count, hour }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.hour - b.hour)
      .slice(0, 5)
      .map((entry) => entry.hour);

    // Count content items created in period (avoiding double counting stories)
    const postsCreatedCount = posts.filter((p) => {
      const c = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
      return c >= range.start && c < range.end;
    }).length;
    const reelsCreatedCount = reels.filter((r) => {
      const c = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
      return c >= range.start && c < range.end;
    }).length;
    const periodStoryIds = new Set<string>(
      stories
        .filter((s) => {
          const c = s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt);
          return c >= range.start && c < range.end;
        })
        .map((s) => s._id.toString())
    );
    for (const d of targets) {
      if (d.contentType === 'story' && d.createdAt >= range.start && d.createdAt < range.end) {
        periodStoryIds.add(d.contentId);
      }
    }

    return {
      period,
      followers: {
        total: profile?.followerCount ?? 0,
        gained: followersGained,
      },
      profileVisits,
      content: {
        posts: postsCreatedCount,
        reels: reelsCreatedCount,
        stories: periodStoryIds.size,
      },
      engagement: {
        likes,
        comments,
        shares,
        saves,
        views,
        impressions,
        reach: totalReach,
      },
      topContent: topCandidates.slice(0, 5),
      topByType: {
        post: topCandidates.find((c) => c.contentType === 'post') ?? null,
        reel: topCandidates.find((c) => c.contentType === 'reel') ?? null,
        story: topCandidates.find((c) => c.contentType === 'story') ?? null,
      },
      dailyActivity: Array.from(dailyActivityMap.values()),
      activityHeatmap,
      bestPerformingDay,
      bestTimeToPost,
    };
  }

  private async getUnrolledCreatorTotals(
    creatorId: string,
    start: Date,
    end: Date
  ): Promise<{ totalVisits: number; totalFollows: number; reelFollows: number }> {
    const database = this.db();
    const [visits, follows, followSources] = await Promise.all([
      getProfileVisitsCollection(database).countDocuments({
        visitedUserId: creatorId,
        at: { $gte: start, $lt: end },
      }),
      getFollowsCollection(database).countDocuments({
        followingId: creatorId,
        createdAt: { $gte: start, $lt: end },
      }),
      getFollowSourcesCollection(database).countDocuments({
        followingId: creatorId,
        source: 'reel',
        at: { $gte: start, $lt: end },
      }),
    ]);
    return { totalVisits: visits, totalFollows: follows, reelFollows: followSources };
  }

  async getPostsAnalytics(
    creatorId: string,
    period: AnalyticsPeriod,
    limit: number = 20,
    before?: string
  ): Promise<PostAnalyticsRow[]> {
    const data = await this.loadCreatorContentAndMetrics(creatorId, period);
    const { range, posts, dailyMap, byItemDay } = data;
    const beforeDate = before ? new Date(before) : undefined;

    const filteredPosts = posts
      .filter((p) => {
        if (!beforeDate) return true;
        const c = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
        return c < beforeDate;
      })
      .slice(0, limit);

    if (filteredPosts.length === 0) return [];
    const creatorTotals = await this.getUnrolledCreatorTotals(creatorId, range.start, range.end);

    return filteredPosts.map((p) => {
      const cid = p._id.toString();
      const createdAt = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
      const merged = this.mergePeriodTotalsForItem(
        {
          contentType: 'post',
          contentId: cid,
          authorId: p.authorId,
          preview: (p.body || '').slice(0, 120),
          createdAt,
        },
        range.dateKeys,
        range.todayKey,
        dailyMap,
        byItemDay
      );
      const t = merged.totals;
      const inPeriod = createdAt >= range.start && createdAt <= range.end;
      const likes = inPeriod ? Math.max(t.likes, p.likeCount ?? 0) : t.likes;
      const comments = inPeriod ? Math.max(t.comments, p.commentCount ?? 0) : t.comments;
      const shares = inPeriod ? Math.max(t.shares, p.shareCount ?? 0) : t.shares;
      const saves = inPeriod ? Math.max(t.saves, p.saveCount ?? 0) : t.saves;
      const interactions = likes + comments + shares + saves;
      const engagementRate =
        t.impressions > 0 ? Number(((interactions / t.impressions) * 100).toFixed(2)) : 0;

      return {
        postId: cid,
        preview: (p.body || '').slice(0, 120),
        thumbnailUrl: resolveMediaUrl(p.imageKey, p.imageUrl),
        createdAt: createdAt.toISOString(),
        impressions: t.impressions,
        reach: t.reach,
        likes,
        comments,
        shares,
        saves,
        profileVisits: merged.profileVisits > 0 ? merged.profileVisits : creatorTotals.totalVisits,
        newFollowers: merged.newFollowers > 0 ? merged.newFollowers : creatorTotals.totalFollows,
        engagementRate,
      };
    });
  }

  async getReelsAnalytics(
    creatorId: string,
    period: AnalyticsPeriod,
    limit: number = 20,
    before?: string
  ): Promise<ReelAnalyticsRow[]> {
    const data = await this.loadCreatorContentAndMetrics(creatorId, period);
    const { range, reels, dailyMap, byItemDay } = data;
    const beforeDate = before ? new Date(before) : undefined;

    const filteredReels = reels
      .filter((r) => {
        if (!beforeDate) return true;
        const c = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        return c < beforeDate;
      })
      .slice(0, limit);

    if (filteredReels.length === 0) return [];
    const [creatorTotals, bufferedReelViews] = await Promise.all([
      this.getUnrolledCreatorTotals(creatorId, range.start, range.end),
      this.getBufferedReelViews(filteredReels.map((r) => r._id.toString())),
    ]);

    return filteredReels.map((r) => {
      const cid = r._id.toString();
      const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
      const merged = this.mergePeriodTotalsForItem(
        {
          contentType: 'reel',
          contentId: cid,
          authorId: r.authorId,
          preview: (r.caption || 'Reel').slice(0, 120),
          createdAt,
        },
        range.dateKeys,
        range.todayKey,
        dailyMap,
        byItemDay
      );
      const t = merged.totals;
      const inPeriod = createdAt >= range.start && createdAt <= range.end;
      const views = inPeriod
        ? Math.max(t.views, (r.viewCount ?? 0) + (bufferedReelViews.get(cid) ?? 0))
        : t.views;
      const uniqueViews = t.uniqueViews;
      const watchSeconds = Number(t.watchSeconds.toFixed(2));
      const avgWatchSeconds = views > 0 ? Number((watchSeconds / views).toFixed(2)) : 0;
      const completionRate = views > 0 ? Number(((t.completions / views) * 100).toFixed(2)) : 0;

      return {
        reelId: cid,
        preview: (r.caption || 'Reel').slice(0, 120),
        thumbnailUrl: resolveMediaUrl(r.thumbnailKey, r.thumbnailUrl),
        createdAt: createdAt.toISOString(),
        views,
        uniqueViews,
        watchSeconds,
        avgWatchSeconds,
        completionRate,
        replays: t.replays,
        likes: inPeriod ? Math.max(t.likes, r.likeCount ?? 0) : t.likes,
        comments: inPeriod ? Math.max(t.comments, r.commentCount ?? 0) : t.comments,
        shares: inPeriod ? Math.max(t.shares, r.shareCount ?? 0) : t.shares,
        saves: inPeriod ? Math.max(t.saves, r.saveCount ?? 0) : t.saves,
        newFollowers: merged.newFollowers > 0 ? merged.newFollowers : creatorTotals.reelFollows,
      };
    });
  }

  async getStoriesAnalytics(
    creatorId: string,
    period: AnalyticsPeriod,
    limit: number = 20,
    before?: string
  ): Promise<StoryAnalyticsRow[]> {
    const data = await this.loadCreatorContentAndMetrics(creatorId, period);
    const { range, targets, storyDocMap, dailyMap, byItemDay } = data;
    const beforeDate = before ? new Date(before) : undefined;

    const storyTargets = targets
      .filter((t) => {
        if (t.contentType !== 'story') return false;
        if (beforeDate && t.createdAt >= beforeDate) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    return storyTargets.map((s) => {
      const merged = this.mergePeriodTotalsForItem(
        s,
        range.dateKeys,
        range.todayKey,
        dailyMap,
        byItemDay
      );
      const t = merged.totals;
      const sDoc = storyDocMap.get(s.contentId);
      const thumbnailUrl = sDoc
        ? sDoc.thumbnailKey
          ? computePublicUrl(sDoc.thumbnailKey)
          : sDoc.mediaType === 'image'
            ? resolveMediaUrl(sDoc.mediaKey, sDoc.mediaUrl)
            : null
        : null;
      const completionRate =
        t.views > 0 ? Number(((t.completions / t.views) * 100).toFixed(2)) : 0;

      return {
        storyId: s.contentId,
        preview: s.preview,
        thumbnailUrl,
        mediaType: sDoc?.mediaType ?? null,
        createdAt: s.createdAt.toISOString(),
        uniqueViewers: t.uniqueViews,
        totalViews: t.views,
        completionRate,
        tapsForward: t.tapsForward,
        tapsBack: t.tapsBack,
        exits: t.exits,
        replies: t.replies,
      };
    });
  }

  async getContentDeepDive(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string,
    period: AnalyticsPeriod
  ): Promise<ContentDeepDiveResponse> {
    const oid = this.parseObjectId(contentId, `${contentType}_not_found`, contentType);
    const database = this.db();

    let targetRef: ContentTargetRef | null = null;
    let thumbnailUrl: string | null = null;
    let mediaType: 'image' | 'video' | null = null;
    let docLikes = 0;
    let docComments = 0;
    let docShares = 0;
    let docSaves = 0;
    let docViews = 0;

    if (contentType === 'post') {
      const post = await getPostsCollection(database).findOne({ _id: oid, deleted: false });
      if (post) {
        if (post.authorId !== creatorId) {
          throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
        }
        thumbnailUrl = resolveMediaUrl(post.imageKey, post.imageUrl);
        docLikes = post.likeCount ?? 0;
        docComments = post.commentCount ?? 0;
        docShares = post.shareCount ?? 0;
        docSaves = post.saveCount ?? 0;
        targetRef = {
          contentType: 'post',
          contentId,
          authorId: post.authorId,
          preview: (post.body || '').slice(0, 120),
          createdAt: post.createdAt instanceof Date ? post.createdAt : new Date(post.createdAt),
        };
      }
    } else if (contentType === 'reel') {
      const reel = await getReelsCollection(database).findOne({ _id: oid, deleted: false });
      if (reel) {
        if (reel.authorId !== creatorId) {
          throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
        }
        thumbnailUrl = resolveMediaUrl(reel.thumbnailKey, reel.thumbnailUrl);
        mediaType = 'video';
        docLikes = reel.likeCount ?? 0;
        docComments = reel.commentCount ?? 0;
        docShares = reel.shareCount ?? 0;
        docSaves = reel.saveCount ?? 0;
        const buf = await this.getBufferedReelViews([contentId]);
        docViews = (reel.viewCount ?? 0) + (buf.get(contentId) ?? 0);
        targetRef = {
          contentType: 'reel',
          contentId,
          authorId: reel.authorId,
          preview: (reel.caption || 'Reel').slice(0, 120),
          createdAt: reel.createdAt instanceof Date ? reel.createdAt : new Date(reel.createdAt),
        };
      }
    } else {
      const story = await getStoriesCollection(database).findOne({ _id: oid });
      if (story) {
        if (story.authorId !== creatorId) {
          throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
        }
        mediaType = story.mediaType;
        thumbnailUrl = story.thumbnailKey
          ? computePublicUrl(story.thumbnailKey)
          : story.mediaType === 'image'
            ? resolveMediaUrl(story.mediaKey, story.mediaUrl)
            : null;
        targetRef = {
          contentType: 'story',
          contentId,
          authorId: story.authorId,
          preview: (story.caption || 'Story').slice(0, 120),
          createdAt: story.createdAt instanceof Date ? story.createdAt : new Date(story.createdAt),
          storyViewers: story.viewers ?? [],
        };
      } else {
        // Fallback to historical daily aggregates for expired story
        const dailyAny = await getAnalyticsDailyCollection(database).findOne({
          contentType: 'story',
          contentId,
        });
        if (dailyAny) {
          if (dailyAny.authorId !== creatorId) {
            throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
          }
          targetRef = {
            contentType: 'story',
            contentId,
            authorId: dailyAny.authorId,
            preview: dailyAny.preview || 'Story',
            createdAt:
              dailyAny.contentCreatedAt instanceof Date
                ? dailyAny.contentCreatedAt
                : new Date(dailyAny.contentCreatedAt ?? `${dailyAny.date}T00:00:00.000Z`),
          };
        }
      }
    }

    if (!targetRef) {
      const label = contentType.charAt(0).toUpperCase() + contentType.slice(1);
      throw new NotFoundError(`${label} not found`, `${contentType}_not_found`);
    }

    const range = getPeriodRange(period);
    const [dailyDocs, rawRes, impressionSourcesDocs, rawViewsDocs, creatorTotals] = await Promise.all([
      getAnalyticsDailyCollection(database)
        .find({ contentType, contentId, date: { $in: range.dateKeys } })
        .toArray(),
      aggregateRawMetricsWindow(database, [targetRef], range.start, range.end),
      getImpressionsCollection(database)
        .find(
          { contentType, contentId, seenAt: { $gte: range.start, $lt: range.end } },
          { projection: { _id: 0, source: 1 } }
        )
        .toArray(),
      contentType !== 'post'
        ? getContentViewsCollection(database)
            .find(
              { contentType, contentId, startedAt: { $gte: range.start, $lt: range.end } },
              { projection: { _id: 0, startedAt: 1, watchedSeconds: 1, totalSeconds: 1, completed: 1 } }
            )
            .toArray()
        : Promise.resolve([]),
      this.getUnrolledCreatorTotals(creatorId, range.start, range.end),
    ]);

    const dailyMap = new Map<string, AnalyticsDailyDocument>();
    for (const d of dailyDocs) {
      dailyMap.set(dayCompositeKey(d.contentType, d.contentId, d.date), d);
    }

    const merged = this.mergePeriodTotalsForItem(
      targetRef,
      range.dateKeys,
      range.todayKey,
      dailyMap,
      rawRes.byItemDay
    );

    const { hourEngagement: _ignored, ...totals } = merged.totals;
    const inPeriod = targetRef.createdAt >= range.start && targetRef.createdAt <= range.end;
    if (inPeriod && (contentType === 'post' || contentType === 'reel')) {
      totals.likes = Math.max(totals.likes, docLikes);
      totals.comments = Math.max(totals.comments, docComments);
      totals.shares = Math.max(totals.shares, docShares);
      totals.saves = Math.max(totals.saves, docSaves);
      if (contentType === 'reel') {
        totals.views = Math.max(totals.views, docViews);
      }
    }

    const sourceMap = new Map<string, number>();
    for (const doc of impressionSourcesDocs) {
      const s = doc.source || 'feed';
      sourceMap.set(s, (sourceMap.get(s) ?? 0) + 1);
    }
    const trafficSources = Array.from(sourceMap.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    let watchThroughBuckets: ContentDeepDiveResponse['watchThroughBuckets'];
    if (contentType === 'reel') {
      const totalViewsCount = rawViewsDocs.length;
      watchThroughBuckets = Array.from({ length: 10 }, (_, idx) => {
        const minPct = idx * 10;
        const maxPct = minPct + 10;
        let reached = 0;
        for (const v of rawViewsDocs) {
          const pct =
            v.totalSeconds && v.totalSeconds > 0
              ? Math.min(100, ((v.watchedSeconds ?? 0) / v.totalSeconds) * 100)
              : v.completed
                ? 100
                : 0;
          if (pct >= minPct || (minPct === 90 && v.completed)) {
            reached++;
          }
        }
        return {
          bucket: `${minPct}-${maxPct}%`,
          minPct,
          count: reached,
          percentage: totalViewsCount > 0 ? Math.round((reached / totalViewsCount) * 100) : 0,
        };
      });
    }

    let funnel: ContentDeepDiveResponse['funnel'];
    let hourlyViews: ContentDeepDiveResponse['hourlyViews'];
    if (contentType === 'story') {
      funnel = {
        impressions: Math.max(totals.impressions, totals.views),
        views: totals.views,
        completed: totals.completions,
        replied: totals.replies,
      };

      const hourBuckets = new Array(24).fill(0);
      const storyStartMs = targetRef.createdAt.getTime();
      if (rawViewsDocs.length > 0) {
        for (const v of rawViewsDocs) {
          const ms = (v.startedAt instanceof Date ? v.startedAt : new Date(v.startedAt)).getTime();
          const offset = Math.floor((ms - storyStartMs) / 3_600_000);
          if (offset >= 0 && offset < 24) {
            hourBuckets[offset]++;
          }
        }
      } else if (targetRef.storyViewers?.length) {
        for (const sv of targetRef.storyViewers) {
          const ms = (sv.viewedAt instanceof Date ? sv.viewedAt : new Date(sv.viewedAt)).getTime();
          const offset = Math.floor((ms - storyStartMs) / 3_600_000);
          if (offset >= 0 && offset < 24) {
            hourBuckets[offset]++;
          }
        }
      }
      hourlyViews = hourBuckets.map((count, hourOffset) => ({
        hourOffset,
        label: `+${hourOffset}h`,
        views: count,
      }));
    }

    return {
      contentType,
      contentId,
      preview: targetRef.preview,
      thumbnailUrl,
      mediaType,
      createdAt: targetRef.createdAt.toISOString(),
      period,
      profileVisits: merged.profileVisits > 0 ? merged.profileVisits : creatorTotals.totalVisits,
      newFollowers:
        merged.newFollowers > 0
          ? merged.newFollowers
          : contentType === 'reel'
            ? creatorTotals.reelFollows
            : creatorTotals.totalFollows,
      totals,
      series: merged.series,
      trafficSources,
      ...(watchThroughBuckets ? { watchThroughBuckets } : {}),
      ...(funnel ? { funnel } : {}),
      ...(hourlyViews ? { hourlyViews } : {}),
    };
  }

  async getAudienceAnalytics(
    creatorId: string,
    period: AnalyticsPeriod
  ): Promise<AudienceAnalyticsResponse> {
    const range = getPeriodRange(period);
    const database = this.db();

    const [followsInPeriod, allFollowers, creatorDailyDocs, followSourceDocs] = await Promise.all([
      getFollowsCollection(database)
        .find({ followingId: creatorId, createdAt: { $gte: range.start, $lt: range.end } })
        .toArray(),
      getFollowsCollection(database)
        .find({ followingId: creatorId }, { projection: { followerId: 1 } })
        .toArray(),
      getCreatorDailyStatsCollection(database)
        .find({ userId: creatorId, date: { $in: range.dateKeys } })
        .toArray(),
      getFollowSourcesCollection(database)
        .find({ followingId: creatorId, at: { $gte: range.start, $lt: range.end } })
        .toArray(),
    ]);

    const rawFollowByDay = new Map<string, number>();
    for (const f of followsInPeriod) {
      const dk = toUtcDateKey(f.createdAt instanceof Date ? f.createdAt : new Date(f.createdAt));
      rawFollowByDay.set(dk, (rawFollowByDay.get(dk) ?? 0) + 1);
    }
    const rolledFollowByDay = new Map(creatorDailyDocs.map((cs) => [cs.date, cs.followersGained ?? 0]));

    const followerGrowth = range.dateKeys.map((date) => {
      const raw = rawFollowByDay.get(date) ?? 0;
      const rolled = rolledFollowByDay.get(date);
      const count = rolled !== undefined && date !== range.todayKey ? Math.max(rolled, raw) : raw;
      return { date, count };
    });

    const followerIds = allFollowers.map((f) => f.followerId);
    const activeSetsByHour: Set<string>[] = Array.from({ length: 24 }, () => new Set<string>());
    const heatmapSets: Set<string>[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => new Set<string>())
    );

    if (followerIds.length > 0) {
      const followerViews = await getContentViewsCollection(database)
        .find(
          { userId: { $in: followerIds }, startedAt: { $gte: range.start, $lt: range.end } },
          { projection: { userId: 1, startedAt: 1 } }
        )
        .toArray();

      for (const v of followerViews) {
        const d = v.startedAt instanceof Date ? v.startedAt : new Date(v.startedAt);
        activeSetsByHour[d.getUTCHours()].add(v.userId);
        heatmapSets[d.getUTCDay()][d.getUTCHours()].add(v.userId);
      }
    }

    const activeHours = activeSetsByHour.map((set, hour) => ({
      hour,
      followers: set.size,
    }));
    const activityHeatmap = heatmapSets.map((row) => row.map((set) => set.size));

    const sourceCounts = new Map<string, number>();
    for (const fs of followSourceDocs) {
      sourceCounts.set(fs.source, (sourceCounts.get(fs.source) ?? 0) + 1);
    }
    const followSources = Array.from(sourceCounts.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    return {
      followerGrowth,
      activeHours,
      followSources,
      activityHeatmap,
    };
  }
}

export const defaultAnalyticsService = new AnalyticsService();
