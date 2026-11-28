import type { Db } from 'mongodb';
import type { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import {
  getAdminActionsCollection,
  getCommentLikesCollection,
  getCommentReactionsCollection,
  getCommentsCollection,
  getContentViewsCollection,
  getDb,
  getEngagementEventsCollection,
  getFollowSourcesCollection,
  getImpressionsCollection,
  getPlatformDailyStatsCollection,
  getPostLikesCollection,
  getPostsCollection,
  getProfilesCollection,
  getReelLikesCollection,
  getReelsCollection,
  getReportsCollection,
  getSavedCommentsCollection,
  getSavedPostsCollection,
  getSavedReelsCollection,
  getShareEventsCollection,
  getStoriesCollection,
  getUnfollowEventsCollection,
  type AnalyticsContentType,
  type ReportReason,
  type ReportTargetType,
} from '../../db/mongo.js';
import { getRedisClient } from '../../db/redis.js';
import {
  computeAvgResolutionHours,
  fetchInternalAnalyticsJson,
  getActiveUserSetInWindow,
  type InternalChatMessagesStats,
  type InternalVoiceCallsStats,
} from '../../jobs/platform-rollup.js';
import {
  getPeriodRange,
  toUtcDateKey,
  type AnalyticsPeriod,
} from '../analytics/analytics.helpers.js';

export interface InternalSpacesStats {
  spaces: number;
  activeSpaces: number;
  members: number;
}

export interface AdminAnalyticsDeps {
  db?: Db;
  redis?: Redis;
  chatUrl?: string;
  voiceUrl?: string;
  spacesUrl?: string;
}

const AGE_BUCKETS = ['13-17', '18-24', '25-34', '35-44', '45-54', '55+', 'unknown'] as const;
const RESOLUTION_BUCKETS = ['<1h', '1-6h', '6-24h', '1-3d', '3d+'] as const;
const REPORT_TYPES: ReportTargetType[] = ['user', 'post', 'comment', 'message'];
const REPORT_REASONS: ReportReason[] = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'self_harm',
  'impersonation',
  'other',
];

function computeGrowthRate(current: number, previous: number): number {
  if (previous <= 0) {
    return current > 0 ? 100 : 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function getIsoWeekKey(dateInput: Date | string): string {
  const d = dateInput instanceof Date ? new Date(dateInput.getTime()) : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const day = d.getUTCDay();
  const diffToMon = (day + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon));
  return mon.toISOString().slice(0, 10);
}

function ageBucketForDob(dobInput: Date | string | null | undefined, now: Date): (typeof AGE_BUCKETS)[number] {
  if (!dobInput) return 'unknown';
  const dob = dobInput instanceof Date ? dobInput : new Date(dobInput);
  if (Number.isNaN(dob.getTime())) return 'unknown';
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const mDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  if (age < 13) return 'unknown';
  if (age <= 17) return '13-17';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  return '55+';
}

function resolutionBucketForHours(hours: number): (typeof RESOLUTION_BUCKETS)[number] {
  if (hours < 1) return '<1h';
  if (hours < 6) return '1-6h';
  if (hours < 24) return '6-24h';
  if (hours < 72) return '1-3d';
  return '3d+';
}

function durationBucketForSeconds(seconds: number): '<1m' | '1-5m' | '5-15m' | '15-30m' | '30m+' {
  if (seconds < 60) return '<1m';
  if (seconds < 300) return '1-5m';
  if (seconds < 900) return '5-15m';
  if (seconds < 1800) return '15-30m';
  return '30m+';
}

function buildEmptyDurationHistogram() {
  return [
    { bucket: '<1m', count: 0 },
    { bucket: '1-5m', count: 0 },
    { bucket: '5-15m', count: 0 },
    { bucket: '15-30m', count: 0 },
    { bucket: '30m+', count: 0 },
  ];
}

/**
 * Provides platform-wide administrative analytics across MongoDB collections,
 * Redis live counters, and internal chat/voice/spaces endpoints (no block filtering).
 */
export class AdminAnalyticsService {
  private customDb?: Db;
  private customRedis?: Redis;
  private chatUrlOverride?: string;
  private voiceUrlOverride?: string;
  private spacesUrlOverride?: string;

  constructor(deps: AdminAnalyticsDeps = {}) {
    this.customDb = deps.db;
    this.customRedis = deps.redis;
    this.chatUrlOverride = deps.chatUrl;
    this.voiceUrlOverride = deps.voiceUrl;
    this.spacesUrlOverride = deps.spacesUrl;
  }

  private db(): Db {
    return this.customDb ?? getDb();
  }

  private redis(): Redis {
    return this.customRedis ?? getRedisClient();
  }

  private chatUrl(): string {
    return this.chatUrlOverride ?? env.CHAT_SERVICE_URL;
  }

  private voiceUrl(): string {
    return this.voiceUrlOverride ?? env.VOICE_SERVICE_URL;
  }

  private spacesUrl(): string {
    return this.spacesUrlOverride ?? env.SPACES_SERVICE_URL;
  }

  private async getUserActivityLastDates(database: Db): Promise<Map<string, Date>> {
    const lastActiveMap = new Map<string, Date>();
    const bump = (uid: string | undefined | null, dInput: Date | string | null | undefined) => {
      if (!uid || !dInput) return;
      const d = dInput instanceof Date ? dInput : new Date(dInput);
      if (Number.isNaN(d.getTime())) return;
      const existing = lastActiveMap.get(uid);
      if (!existing || d.getTime() > existing.getTime()) {
        lastActiveMap.set(uid, d);
      }
    };

    const [profiles, posts, reels, stories, comments, impressions, views, engagements] =
      await Promise.all([
        getProfilesCollection(database)
          .find({}, { projection: { userId: 1, lastSeenAt: 1, createdAt: 1 } })
          .toArray(),
        getPostsCollection(database)
          .find({ deleted: false }, { projection: { authorId: 1, createdAt: 1 } })
          .toArray(),
        getReelsCollection(database)
          .find({ deleted: false }, { projection: { authorId: 1, createdAt: 1 } })
          .toArray(),
        getStoriesCollection(database)
          .find({}, { projection: { authorId: 1, createdAt: 1 } })
          .toArray(),
        getCommentsCollection(database)
          .find({ deleted: false }, { projection: { authorId: 1, createdAt: 1 } })
          .toArray(),
        getImpressionsCollection(database)
          .find({}, { projection: { userId: 1, seenAt: 1 } })
          .toArray(),
        getContentViewsCollection(database)
          .find({}, { projection: { userId: 1, startedAt: 1 } })
          .toArray(),
        getEngagementEventsCollection(database)
          .find({}, { projection: { userId: 1, at: 1 } })
          .toArray(),
      ]);

    for (const p of profiles) {
      bump(p.userId, p.lastSeenAt ?? p.createdAt);
    }
    for (const p of posts) bump(p.authorId, p.createdAt);
    for (const r of reels) bump(r.authorId, r.createdAt);
    for (const s of stories) bump(s.authorId, s.createdAt);
    for (const c of comments) bump(c.authorId, c.createdAt);
    for (const i of impressions) bump(i.userId, i.seenAt);
    for (const v of views) bump(v.userId, v.startedAt);
    for (const e of engagements) bump(e.userId, e.at);

    return lastActiveMap;
  }

  async getOverview(period: AnalyticsPeriod = '30d') {
    const database = this.db();
    const now = new Date();
    const { days, start, end, dateKeys } = getPeriodRange(period, now);
    const prevEnd = start;
    const prevStart = new Date(start.getTime() - days * 86_400_000);

    const d24h = new Date(now.getTime() - 86_400_000);
    const d7d = new Date(now.getTime() - 7 * 86_400_000);
    const d30d = new Date(now.getTime() - 30 * 86_400_000);

    const sinceIso = encodeURIComponent(start.toISOString());
    const untilIso = encodeURIComponent(end.toISOString());
    const prevSinceIso = encodeURIComponent(prevStart.toISOString());
    const prevUntilIso = encodeURIComponent(prevEnd.toISOString());

    const [
      totalUsers,
      newUsers,
      prevNewUsers,
      bannedUsers,
      verifiedUsers,
      active24hSet,
      active7dSet,
      active30dSet,
      postsInPeriod,
      prevPostsCount,
      reelsInPeriod,
      prevReelsCount,
      storiesInPeriod,
      prevStoriesCount,
      postLikesCount,
      reelLikesCount,
      commentLikesCount,
      commentsCount,
      sharesCount,
      savedPostsCount,
      savedReelsCount,
      savedCommentsCount,
      reportsCreated,
      resolvedReports,
      pendingBacklog,
      usersBanned,
      dailyProfiles,
      dailyPosts,
      dailyReels,
      dailyStories,
      dailyImpressions,
      dailyViews,
      dailyEngagements,
      dailyComments,
      rollupDocs,
      chatCurrent,
      chatPrev,
      voiceCurrent,
      voicePrev,
    ] = await Promise.all([
      getProfilesCollection(database).countDocuments(),
      getProfilesCollection(database).countDocuments({ createdAt: { $gte: start, $lt: end } }),
      getProfilesCollection(database).countDocuments({ createdAt: { $gte: prevStart, $lt: prevEnd } }),
      getProfilesCollection(database).countDocuments({ isBanned: true }),
      getProfilesCollection(database).countDocuments({ isVerified: true } as any),
      getActiveUserSetInWindow(database, d24h, now),
      getActiveUserSetInWindow(database, d7d, now),
      getActiveUserSetInWindow(database, d30d, now),
      getPostsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: start, $lt: end } }),
      getPostsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: prevStart, $lt: prevEnd } }),
      getReelsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: start, $lt: end } }),
      getReelsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: prevStart, $lt: prevEnd } }),
      getStoriesCollection(database).countDocuments({ createdAt: { $gte: start, $lt: end } }),
      getStoriesCollection(database).countDocuments({ createdAt: { $gte: prevStart, $lt: prevEnd } }),
      getPostLikesCollection(database).countDocuments({ createdAt: { $gte: start, $lt: end } }),
      getReelLikesCollection(database).countDocuments({ createdAt: { $gte: start, $lt: end } }),
      getCommentLikesCollection(database).countDocuments({ createdAt: { $gte: start, $lt: end } }),
      getCommentsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: start, $lt: end } }),
      getShareEventsCollection(database).countDocuments({ at: { $gte: start, $lt: end } }),
      getSavedPostsCollection(database).countDocuments({ savedAt: { $gte: start, $lt: end } }),
      getSavedReelsCollection(database).countDocuments({ savedAt: { $gte: start, $lt: end } }),
      getSavedCommentsCollection(database).countDocuments({ savedAt: { $gte: start, $lt: end } }),
      getReportsCollection(database).countDocuments({ createdAt: { $gte: start, $lt: end } }),
      getReportsCollection(database)
        .find({ status: { $in: ['resolved', 'dismissed'] }, resolvedAt: { $gte: start, $lt: end } })
        .project({ createdAt: 1, resolvedAt: 1 })
        .toArray(),
      getReportsCollection(database).countDocuments({ status: 'pending' }),
      getAdminActionsCollection(database).countDocuments({
        action: 'ban_user',
        createdAt: { $gte: start, $lt: end },
      }),
      getProfilesCollection(database)
        .find({ createdAt: { $gte: start, $lt: end } }, { projection: { userId: 1, createdAt: 1 } })
        .toArray(),
      getPostsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getReelsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getStoriesCollection(database)
        .find({ createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getImpressionsCollection(database)
        .find({ seenAt: { $gte: start, $lt: end } }, { projection: { userId: 1, seenAt: 1 } })
        .toArray(),
      getContentViewsCollection(database)
        .find({ startedAt: { $gte: start, $lt: end } }, { projection: { userId: 1, startedAt: 1 } })
        .toArray(),
      getEngagementEventsCollection(database)
        .find({ at: { $gte: start, $lt: end } }, { projection: { userId: 1, at: 1 } })
        .toArray(),
      getCommentsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getPlatformDailyStatsCollection(database).find({ date: { $in: dateKeys } }).toArray(),
      fetchInternalAnalyticsJson<InternalChatMessagesStats>(
        this.chatUrl(),
        `/internal/analytics/messages?since=${sinceIso}&until=${untilIso}`
      ),
      fetchInternalAnalyticsJson<InternalChatMessagesStats>(
        this.chatUrl(),
        `/internal/analytics/messages?since=${prevSinceIso}&until=${prevUntilIso}`
      ),
      fetchInternalAnalyticsJson<InternalVoiceCallsStats>(
        this.voiceUrl(),
        `/internal/analytics/calls?since=${sinceIso}&until=${untilIso}`
      ),
      fetchInternalAnalyticsJson<InternalVoiceCallsStats>(
        this.voiceUrl(),
        `/internal/analytics/calls?since=${prevSinceIso}&until=${prevUntilIso}`
      ),
    ]);

    const rollupMap = new Map(rollupDocs.map((d) => [d.date, d]));
    const chatDailyMap = new Map((chatCurrent?.daily ?? []).map((d) => [d.date, d.messages]));

    const activeByDay = new Map<string, Set<string>>();
    const newUsersByDay = new Map<string, number>();
    const postsByDay = new Map<string, number>();
    const reelsByDay = new Map<string, number>();
    const storiesByDay = new Map<string, number>();
    for (const dk of dateKeys) {
      activeByDay.set(dk, new Set());
      newUsersByDay.set(dk, 0);
      postsByDay.set(dk, 0);
      reelsByDay.set(dk, 0);
      storiesByDay.set(dk, 0);
    }

    const markActive = (dk: string, uid?: string | null) => {
      if (!uid) return;
      activeByDay.get(dk)?.add(uid);
    };

    for (const p of dailyProfiles) {
      const dk = toUtcDateKey(p.createdAt);
      newUsersByDay.set(dk, (newUsersByDay.get(dk) ?? 0) + 1);
      markActive(dk, p.userId);
    }
    for (const p of dailyPosts) {
      const dk = toUtcDateKey(p.createdAt);
      postsByDay.set(dk, (postsByDay.get(dk) ?? 0) + 1);
      markActive(dk, p.authorId);
    }
    for (const r of dailyReels) {
      const dk = toUtcDateKey(r.createdAt);
      reelsByDay.set(dk, (reelsByDay.get(dk) ?? 0) + 1);
      markActive(dk, r.authorId);
    }
    for (const s of dailyStories) {
      const dk = toUtcDateKey(s.createdAt);
      storiesByDay.set(dk, (storiesByDay.get(dk) ?? 0) + 1);
      markActive(dk, s.authorId);
    }
    for (const c of dailyComments) markActive(toUtcDateKey(c.createdAt), c.authorId);
    for (const i of dailyImpressions) markActive(toUtcDateKey(i.seenAt), i.userId);
    for (const v of dailyViews) markActive(toUtcDateKey(v.startedAt), v.userId);
    for (const e of dailyEngagements) markActive(toUtcDateKey(e.at), e.userId);

    const timeline = dateKeys.map((date) => {
      const rolled = rollupMap.get(date);
      const rawActive = activeByDay.get(date)?.size ?? 0;
      const rawNew = newUsersByDay.get(date) ?? 0;
      const rawPosts = postsByDay.get(date) ?? 0;
      const rawReels = reelsByDay.get(date) ?? 0;
      const rawStories = storiesByDay.get(date) ?? 0;
      const chatMsgs = chatDailyMap.get(date);

      return {
        date,
        users: {
          active: Math.max(rolled?.users?.dau ?? 0, rawActive),
          new: Math.max(rolled?.users?.new ?? 0, rawNew),
        },
        content: {
          posts: Math.max(rolled?.content?.postsCreated ?? 0, rawPosts),
          reels: Math.max(rolled?.content?.reelsCreated ?? 0, rawReels),
          stories: Math.max(rolled?.content?.storiesCreated ?? 0, rawStories),
        },
        chat: {
          messages: chatMsgs !== undefined ? chatMsgs : rolled?.chat?.messagesSent ?? 0,
        },
      };
    });

    const userGrowthRate = computeGrowthRate(newUsers, prevNewUsers);
    const postsGrowthRate = computeGrowthRate(postsInPeriod, prevPostsCount);
    const reelsGrowthRate = computeGrowthRate(reelsInPeriod, prevReelsCount);
    const storiesGrowthRate = computeGrowthRate(storiesInPeriod, prevStoriesCount);
    const contentGrowthRate = computeGrowthRate(
      postsInPeriod + reelsInPeriod + storiesInPeriod,
      prevPostsCount + prevReelsCount + prevStoriesCount
    );

    const messagesSent = chatCurrent?.totalMessages ?? 0;
    const prevMessagesSent = chatPrev?.totalMessages ?? 0;
    const callsMade = voiceCurrent?.totalCalls ?? 0;
    const prevCallsMade = voicePrev?.totalCalls ?? 0;
    const msgGrowthRate = computeGrowthRate(messagesSent, prevMessagesSent);
    const callGrowthRate = computeGrowthRate(callsMade, prevCallsMade);

    return {
      period,
      users: {
        total: totalUsers,
        new: newUsers,
        active24h: active24hSet.size,
        active7d: active7dSet.size,
        active30d: active30dSet.size,
        banned: bannedUsers,
        verified: verifiedUsers,
        growthRate: userGrowthRate,
      },
      content: {
        postsCreated: postsInPeriod,
        reelsCreated: reelsInPeriod,
        storiesCreated: storiesInPeriod,
        totalLikes: postLikesCount + reelLikesCount + commentLikesCount,
        totalComments: commentsCount,
        totalShares: sharesCount,
        totalSaves: savedPostsCount + savedReelsCount + savedCommentsCount,
        growthRate: {
          posts: postsGrowthRate,
          reels: reelsGrowthRate,
          stories: storiesGrowthRate,
        },
      },
      chat: {
        messagesSent,
        conversationsActive: chatCurrent?.activeConversations ?? 0,
        callsMade,
        callMinutes: voiceCurrent?.totalMinutes ?? 0,
        growthRate: {
          messages: msgGrowthRate,
          calls: callGrowthRate,
        },
      },
      moderation: {
        reportsCreated,
        reportsResolved: resolvedReports.length,
        usersBanned,
        avgResolutionTimeHours: computeAvgResolutionHours(resolvedReports),
        pendingBacklog,
      },
      timeline,
      trend: {
        users: userGrowthRate,
        content: contentGrowthRate,
        chat: msgGrowthRate,
      },
    };
  }

  async getUsersAnalytics(period: AnalyticsPeriod = '30d') {
    const database = this.db();
    const now = new Date();
    const { start, end, dateKeys } = getPeriodRange(period, now);

    const d1Start = new Date(now.getTime() - 86_400_000);
    const d7Start = new Date(now.getTime() - 7 * 86_400_000);
    const d30Start = new Date(now.getTime() - 30 * 86_400_000);

    const [profiles, lastActivityMap, d1Set, d7Set, d30Set] = await Promise.all([
      getProfilesCollection(database)
        .find({}, { projection: { userId: 1, dateOfBirth: 1, isVerified: 1, isPrivate: 1, createdAt: 1 } })
        .toArray(),
      this.getUserActivityLastDates(database),
      getActiveUserSetInWindow(database, d1Start, now),
      getActiveUserSetInWindow(database, d7Start, now),
      getActiveUserSetInWindow(database, d30Start, now),
    ]);

    const ageCounts = new Map<(typeof AGE_BUCKETS)[number], number>(AGE_BUCKETS.map((b) => [b, 0]));
    let verifiedCount = 0;
    let privateCount = 0;
    let newCount = 0;
    let beforeWindowUsers = 0;
    const newByDay = new Map<string, number>(dateKeys.map((dk) => [dk, 0]));

    let eligibleD1 = 0;
    let retainedD1 = 0;
    let eligibleD7 = 0;
    let retainedD7 = 0;
    let eligibleD30 = 0;
    let retainedD30 = 0;

    const cohortBuckets = new Map<string, { totalUsers: number; retainedAfter30d: number }>();

    for (const p of profiles as Array<any>) {
      const createdAt = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt ?? now);
      const ageMs = now.getTime() - createdAt.getTime();
      const lastActive = lastActivityMap.get(p.userId) ?? createdAt;

      ageCounts.set(ageBucketForDob(p.dateOfBirth, now), (ageCounts.get(ageBucketForDob(p.dateOfBirth, now)) ?? 0) + 1);
      if (p.isVerified) verifiedCount++;
      if (p.isPrivate) privateCount++;

      if (createdAt < start) {
        beforeWindowUsers++;
      } else if (createdAt >= start && createdAt < end) {
        newCount++;
        const dk = toUtcDateKey(createdAt);
        newByDay.set(dk, (newByDay.get(dk) ?? 0) + 1);
      }

      if (ageMs >= 86_400_000) {
        eligibleD1++;
        if (lastActive.getTime() >= createdAt.getTime() + 86_400_000) retainedD1++;
      }
      if (ageMs >= 7 * 86_400_000) {
        eligibleD7++;
        if (lastActive.getTime() >= createdAt.getTime() + 7 * 86_400_000) retainedD7++;
      }
      if (ageMs >= 30 * 86_400_000) {
        eligibleD30++;
        if (lastActive.getTime() >= createdAt.getTime() + 30 * 86_400_000) retainedD30++;
      }

      const weekKey = getIsoWeekKey(createdAt);
      const bucket = cohortBuckets.get(weekKey) ?? { totalUsers: 0, retainedAfter30d: 0 };
      bucket.totalUsers++;
      if (ageMs >= 30 * 86_400_000 && lastActive.getTime() >= createdAt.getTime() + 30 * 86_400_000) {
        bucket.retainedAfter30d++;
      }
      cohortBuckets.set(weekKey, bucket);
    }

    let runningTotal = beforeWindowUsers;
    const growth = dateKeys.map((date) => {
      const added = newByDay.get(date) ?? 0;
      runningTotal += added;
      return {
        date,
        total: runningTotal,
        new: added,
      };
    });

    const cohorts = Array.from(cohortBuckets.entries())
      .map(([signupWeek, info]) => ({
        signupWeek,
        totalUsers: info.totalUsers,
        retainedAfter30d: info.retainedAfter30d,
      }))
      .sort((a, b) => a.signupWeek.localeCompare(b.signupWeek))
      .slice(-12);

    return {
      period,
      total: profiles.length,
      new: newCount,
      active: {
        d1: d1Set.size,
        d7: d7Set.size,
        d30: d30Set.size,
      },
      retention: {
        d1: eligibleD1 > 0 ? Number((retainedD1 / eligibleD1).toFixed(4)) : 0,
        d7: eligibleD7 > 0 ? Number((retainedD7 / eligibleD7).toFixed(4)) : 0,
        d30: eligibleD30 > 0 ? Number((retainedD30 / eligibleD30).toFixed(4)) : 0,
      },
      cohorts,
      demographics: {
        ageDistribution: AGE_BUCKETS.map((bucket) => ({ bucket, count: ageCounts.get(bucket) ?? 0 })),
        verifiedCount,
        privateCount,
      },
      growth,
    };
  }

  async getContentAnalytics(period: AnalyticsPeriod = '30d') {
    const database = this.db();
    const { start, end } = getPeriodRange(period, new Date());

    const [
      postsDocs,
      reelsDocs,
      storiesDocs,
      impressionsDocs,
      viewsDocs,
      postLikesDocs,
      reelLikesDocs,
      commentsDocs,
      reactionsDocs,
      sharesDocs,
      savedPostsDocs,
      savedReelsDocs,
      engagementEventsDocs,
    ] = await Promise.all([
      getPostsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } })
        .toArray(),
      getReelsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } })
        .toArray(),
      getStoriesCollection(database)
        .find({ createdAt: { $gte: start, $lt: end } })
        .toArray(),
      getImpressionsCollection(database).find({ seenAt: { $gte: start, $lt: end } }).toArray(),
      getContentViewsCollection(database).find({ startedAt: { $gte: start, $lt: end } }).toArray(),
      getPostLikesCollection(database).find({ createdAt: { $gte: start, $lt: end } }).toArray(),
      getReelLikesCollection(database).find({ createdAt: { $gte: start, $lt: end } }).toArray(),
      getCommentsCollection(database).find({ deleted: false, createdAt: { $gte: start, $lt: end } }).toArray(),
      getCommentReactionsCollection(database).find({ createdAt: { $gte: start, $lt: end } }).toArray(),
      getShareEventsCollection(database).find({ at: { $gte: start, $lt: end } }).toArray(),
      getSavedPostsCollection(database).find({ savedAt: { $gte: start, $lt: end } }).toArray(),
      getSavedReelsCollection(database).find({ savedAt: { $gte: start, $lt: end } }).toArray(),
      getEngagementEventsCollection(database).find({ at: { $gte: start, $lt: end } }).toArray(),
    ]);

    type ItemStat = {
      contentType: AnalyticsContentType;
      contentId: string;
      authorId: string;
      preview: string;
      impressions: number;
      reachUsers: Set<string>;
      views: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
    };

    const itemsMap = new Map<string, ItemStat>();
    const ensureItem = (
      type: AnalyticsContentType,
      id: string,
      authorId = '',
      preview = ''
    ): ItemStat => {
      const key = `${type}:${id}`;
      let cur = itemsMap.get(key);
      if (!cur) {
        cur = {
          contentType: type,
          contentId: id,
          authorId,
          preview,
          impressions: 0,
          reachUsers: new Set<string>(),
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          saves: 0,
        };
        itemsMap.set(key, cur);
      }
      return cur;
    };

    for (const p of postsDocs) {
      ensureItem('post', p._id.toString(), p.authorId, (p.body || '').slice(0, 120));
    }
    for (const r of reelsDocs) {
      ensureItem('reel', r._id.toString(), r.authorId, (r.caption || 'Reel').slice(0, 120));
    }
    for (const s of storiesDocs) {
      ensureItem('story', s._id.toString(), s.authorId, (s.caption || 'Story').slice(0, 120));
    }

    let postImpressions = 0;
    const postReachUsers = new Set<string>();
    for (const imp of impressionsDocs) {
      const item = ensureItem(imp.contentType, imp.contentId);
      item.impressions++;
      item.reachUsers.add(imp.userId);
      if (imp.contentType === 'post') {
        postImpressions++;
        postReachUsers.add(imp.userId);
      }
    }

    let reelViews = 0;
    const reelUniqueUsers = new Set<string>();
    let reelWatchSum = 0;
    let reelCompletions = 0;
    let storyViews = 0;
    const storyUniqueUsers = new Set<string>();
    let storyCompletions = 0;

    for (const v of viewsDocs) {
      const item = ensureItem(v.contentType as AnalyticsContentType, v.contentId);
      item.views++;
      if (v.contentType === 'reel') {
        reelViews++;
        reelUniqueUsers.add(v.userId);
        reelWatchSum += Number(v.watchedSeconds ?? 0);
        if (v.completed) reelCompletions++;
      } else if (v.contentType === 'story') {
        storyViews++;
        storyUniqueUsers.add(v.userId);
        if (v.completed) storyCompletions++;
      }
    }

    // Include inline story.viewers entries not already reflected in content_views
    for (const s of storiesDocs) {
      const viewers = s.viewers ?? [];
      if (viewers.length > 0 && !viewsDocs.some((v) => v.contentId === s._id.toString())) {
        const item = ensureItem('story', s._id.toString(), s.authorId, (s.caption || 'Story').slice(0, 120));
        item.views += viewers.length;
        storyViews += viewers.length;
        for (const vw of viewers) {
          storyUniqueUsers.add(vw.userId);
        }
      }
    }

    let postLikes = 0;
    let reelLikes = 0;
    for (const pl of postLikesDocs) {
      postLikes++;
      ensureItem('post', pl.postId.toString()).likes++;
    }
    for (const rl of reelLikesDocs) {
      reelLikes++;
      ensureItem('reel', rl.reelId.toString()).likes++;
    }

    let postComments = 0;
    let reelComments = 0;
    for (const c of commentsDocs) {
      const isReel = c.targetType === 'reel' || (Boolean(c.reelId) && !c.postId);
      const cid = (isReel ? c.reelId : c.postId)?.toString();
      if (!cid) continue;
      if (isReel) {
        reelComments++;
        ensureItem('reel', cid).comments++;
      } else {
        postComments++;
        ensureItem('post', cid).comments++;
      }
    }

    let postShares = 0;
    let reelShares = 0;
    for (const sh of sharesDocs) {
      if (sh.contentType === 'post') {
        postShares++;
        ensureItem('post', sh.contentId).shares++;
      } else if (sh.contentType === 'reel') {
        reelShares++;
        ensureItem('reel', sh.contentId).shares++;
      }
    }

    let postSaves = 0;
    let reelSaves = 0;
    for (const sp of savedPostsDocs) {
      postSaves++;
      ensureItem('post', sp.postId.toString()).saves++;
    }
    for (const sr of savedReelsDocs) {
      reelSaves++;
      ensureItem('reel', sr.reelId.toString()).saves++;
    }

    const evCounts = { like: 0, comment: 0, reaction: 0, share: 0, save: 0, viewLong: 0 };
    for (const e of engagementEventsDocs) {
      if (e.event === 'like') evCounts.like++;
      else if (e.event === 'comment' || e.event === 'reply') evCounts.comment++;
      else if (e.event === 'reaction') evCounts.reaction++;
      else if (e.event === 'share' || e.event === 'dm_share') evCounts.share++;
      else if (e.event === 'save') evCounts.save++;
      else if (e.event === 'view_long') evCounts.viewLong++;
    }

    const byType = {
      like: Math.max(evCounts.like, postLikes + reelLikes),
      comment: Math.max(evCounts.comment, commentsDocs.length),
      reaction: Math.max(evCounts.reaction, reactionsDocs.length),
      share: Math.max(evCounts.share, sharesDocs.length),
      save: Math.max(evCounts.save, postSaves + reelSaves),
      viewLong: evCounts.viewLong,
    };
    const totalEngagements =
      byType.like + byType.comment + byType.reaction + byType.share + byType.save + byType.viewLong;

    const topContent = Array.from(itemsMap.values())
      .map((item) => {
        const engagementScore = Number(
          (
            item.likes +
            item.comments * 2 +
            item.shares * 3 +
            item.saves * 2 +
            item.impressions * 0.05 +
            item.views * 0.1
          ).toFixed(2)
        );
        return {
          contentType: item.contentType,
          contentId: item.contentId,
          authorId: item.authorId,
          preview: item.preview || `${item.contentType} #${item.contentId.slice(-6)}`,
          metrics: {
            impressions: item.impressions,
            reach: item.reachUsers.size,
            views: item.views,
            likes: item.likes,
            comments: item.comments,
            shares: item.shares,
            saves: item.saves,
            engagementScore,
          },
        };
      })
      .sort((a, b) => b.metrics.engagementScore - a.metrics.engagementScore)
      .slice(0, 10);

    const avgEngagementRate =
      postImpressions > 0
        ? Number(((postLikes + postComments + postShares + postSaves) / postImpressions).toFixed(4))
        : 0;

    return {
      period,
      posts: {
        created: postsDocs.length,
        impressions: postImpressions,
        reach: postReachUsers.size,
        likes: postLikes,
        comments: postComments,
        shares: postShares,
        avgEngagementRate,
      },
      reels: {
        created: reelsDocs.length,
        views: reelViews,
        uniqueViews: reelUniqueUsers.size,
        avgWatchSeconds: reelViews > 0 ? Number((reelWatchSum / reelViews).toFixed(2)) : 0,
        completionRate: reelViews > 0 ? Number((reelCompletions / reelViews).toFixed(4)) : 0,
        likes: reelLikes,
        comments: reelComments,
        shares: reelShares,
      },
      stories: {
        created: storiesDocs.length,
        views: storyViews,
        uniqueViewers: storyUniqueUsers.size,
        completionRate: storyViews > 0 ? Number((storyCompletions / storyViews).toFixed(4)) : 0,
        replies: 0,
      },
      topContent,
      engagement: {
        totalEngagements,
        byType,
      },
    };
  }

  async getChatAnalytics(period: AnalyticsPeriod = '30d') {
    const { start, end, dateKeys } = getPeriodRange(period, new Date());
    const sinceIso = encodeURIComponent(start.toISOString());
    const untilIso = encodeURIComponent(end.toISOString());

    const [chatStats, voiceStats] = await Promise.all([
      fetchInternalAnalyticsJson<InternalChatMessagesStats>(
        this.chatUrl(),
        `/internal/analytics/messages?since=${sinceIso}&until=${untilIso}`
      ),
      fetchInternalAnalyticsJson<InternalVoiceCallsStats>(
        this.voiceUrl(),
        `/internal/analytics/calls?since=${sinceIso}&until=${untilIso}`
      ),
    ]);

    const chatDailyMap = new Map((chatStats?.daily ?? []).map((d) => [d.date, d]));
    const daily = dateKeys.map((date) => {
      const entry = chatDailyMap.get(date);
      return {
        date,
        messages: entry?.messages ?? 0,
        activeConversations: entry?.activeConversations ?? 0,
      };
    });

    const totalMessages = chatStats?.totalMessages ?? 0;
    const totalConversations = chatStats?.totalConversations ?? 0;
    const avgMessagesPerConversation =
      totalConversations > 0 ? Number((totalMessages / totalConversations).toFixed(2)) : 0;

    return {
      period,
      totalMessages,
      totalConversations,
      avgMessagesPerConversation,
      daily,
      groups: {
        totalGroups: chatStats?.groups?.totalGroups ?? 0,
        activeGroups: chatStats?.groups?.activeGroups ?? 0,
      },
      calls: {
        total: voiceStats?.totalCalls ?? 0,
        avgDurationSeconds: voiceStats?.avgDurationSeconds ?? 0,
        totalMinutes: voiceStats?.totalMinutes ?? 0,
        byType: {
          audio: voiceStats?.byType?.audio ?? 0,
          video: voiceStats?.byType?.video ?? 0,
        },
        durationHistogram: voiceStats?.durationHistogram ?? buildEmptyDurationHistogram(),
      },
    };
  }

  async getModerationAnalytics(period: AnalyticsPeriod = '30d') {
    const database = this.db();
    const { start, end } = getPeriodRange(period, new Date());

    const [createdReports, resolvedReports, pendingCount, adminActions] = await Promise.all([
      getReportsCollection(database).find({ createdAt: { $gte: start, $lt: end } }).toArray(),
      getReportsCollection(database)
        .find({
          status: { $in: ['resolved', 'dismissed'] },
          resolvedAt: { $gte: start, $lt: end },
        })
        .toArray(),
      getReportsCollection(database).countDocuments({ status: 'pending' }),
      getAdminActionsCollection(database).find({ createdAt: { $gte: start, $lt: end } }).toArray(),
    ]);

    const byType: Record<ReportTargetType, number> = { user: 0, post: 0, comment: 0, message: 0 };
    const byReason: Record<ReportReason, number> = {
      spam: 0,
      harassment: 0,
      hate: 0,
      sexual: 0,
      violence: 0,
      self_harm: 0,
      impersonation: 0,
      other: 0,
    };

    for (const r of createdReports) {
      if (REPORT_TYPES.includes(r.targetType)) byType[r.targetType]++;
      if (REPORT_REASONS.includes(r.reason)) byReason[r.reason]++;
    }

    let resolvedCount = 0;
    let dismissedCount = 0;
    const resHistCounts = new Map<(typeof RESOLUTION_BUCKETS)[number], number>(
      RESOLUTION_BUCKETS.map((b) => [b, 0])
    );

    for (const r of resolvedReports) {
      if (r.status === 'resolved') resolvedCount++;
      else if (r.status === 'dismissed') dismissedCount++;
      if (r.resolvedAt && r.createdAt) {
        const resMs = (r.resolvedAt instanceof Date ? r.resolvedAt : new Date(r.resolvedAt)).getTime();
        const crMs = (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).getTime();
        const hours = Math.max(0, (resMs - crMs) / 3_600_000);
        const bucket = resolutionBucketForHours(hours);
        resHistCounts.set(bucket, (resHistCounts.get(bucket) ?? 0) + 1);
      }
    }

    const actions = {
      deleted_posts: 0,
      deleted_comments: 0,
      deleted_messages: 0,
      users_banned: 0,
      users_warned: 0,
    };
    const adminActionCounts = new Map<string, number>();

    for (const a of adminActions) {
      adminActionCounts.set(a.adminId, (adminActionCounts.get(a.adminId) ?? 0) + 1);
      if (a.action === 'delete_post') {
        if (a.details?.action === 'delete_message') actions.deleted_messages++;
        else actions.deleted_posts++;
      } else if (a.action === 'delete_comment') {
        actions.deleted_comments++;
      } else if (a.action === 'ban_user') {
        actions.users_banned++;
      } else if (a.action === 'warn_user') {
        actions.users_warned++;
      }
    }

    const adminIds = Array.from(adminActionCounts.keys());
    const adminProfiles =
      adminIds.length > 0
        ? await getProfilesCollection(database)
            .find({ userId: { $in: adminIds } }, { projection: { userId: 1, username: 1 } })
            .toArray()
        : [];
    const usernameMap = new Map(adminProfiles.map((p) => [p.userId, p.username]));

    const topAdmins = Array.from(adminActionCounts.entries())
      .map(([adminId, actionsTaken]) => ({
        adminId,
        username: usernameMap.get(adminId) ?? adminId,
        actionsTaken,
      }))
      .sort((a, b) => b.actionsTaken - a.actionsTaken)
      .slice(0, 10);

    return {
      period,
      reports: {
        created: createdReports.length,
        resolved: resolvedCount,
        dismissed: dismissedCount,
        pending: pendingCount,
        avgResolutionTimeHours: computeAvgResolutionHours(resolvedReports),
      },
      byType,
      byReason,
      actions,
      topAdmins,
      resolutionTimeHistogram: RESOLUTION_BUCKETS.map((bucket) => ({
        bucket,
        count: resHistCounts.get(bucket) ?? 0,
      })),
    };
  }

  async getFeaturesAnalytics(period: AnalyticsPeriod = '30d') {
    const database = this.db();
    const { start, end, dateKeys } = getPeriodRange(period, new Date());
    const sinceIso = encodeURIComponent(start.toISOString());
    const untilIso = encodeURIComponent(end.toISOString());

    const [
      totalUsers,
      storiesDocs,
      reelsDocs,
      commentsDocs,
      reactionsDocs,
      voiceStats,
      spacesStats,
    ] = await Promise.all([
      getProfilesCollection(database).countDocuments(),
      getStoriesCollection(database)
        .find({ createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getReelsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getCommentsCollection(database)
        .find({ deleted: false, createdAt: { $gte: start, $lt: end } }, { projection: { authorId: 1, createdAt: 1 } })
        .toArray(),
      getCommentReactionsCollection(database)
        .find({ createdAt: { $gte: start, $lt: end } }, { projection: { userId: 1, createdAt: 1 } })
        .toArray(),
      fetchInternalAnalyticsJson<InternalVoiceCallsStats>(
        this.voiceUrl(),
        `/internal/analytics/calls?since=${sinceIso}&until=${untilIso}`
      ),
      fetchInternalAnalyticsJson<InternalSpacesStats>(
        this.spacesUrl(),
        `/internal/analytics/spaces?since=${sinceIso}`
      ),
    ]);

    const denom = Math.max(1, totalUsers);
    const rate = (n: number) => Number(Math.min(1, n / denom).toFixed(4));

    const storyUsers = new Set<string>();
    const reelUsers = new Set<string>();
    const commentUsers = new Set<string>();
    const reactionUsers = new Set<string>();

    const dailyMap = new Map(
      dateKeys.map((date) => [
        date,
        {
          stories: new Set<string>(),
          reels: new Set<string>(),
          comments: new Set<string>(),
          reactions: new Set<string>(),
        },
      ])
    );

    for (const s of storiesDocs) {
      storyUsers.add(s.authorId);
      dailyMap.get(toUtcDateKey(s.createdAt))?.stories.add(s.authorId);
    }
    for (const r of reelsDocs) {
      reelUsers.add(r.authorId);
      dailyMap.get(toUtcDateKey(r.createdAt))?.reels.add(r.authorId);
    }
    for (const c of commentsDocs) {
      commentUsers.add(c.authorId);
      dailyMap.get(toUtcDateKey(c.createdAt))?.comments.add(c.authorId);
    }
    for (const cr of reactionsDocs) {
      reactionUsers.add(cr.userId);
      dailyMap.get(toUtcDateKey(cr.createdAt))?.reactions.add(cr.userId);
    }

    const spacesMembers = spacesStats?.members ?? 0;
    const callsUsers = voiceStats?.uniqueUsersCount ?? 0;

    return {
      period,
      totalUsers,
      stories: {
        users: storyUsers.size,
        adoptionRate: rate(storyUsers.size),
        totalCreated: storiesDocs.length,
      },
      reels: {
        users: reelUsers.size,
        adoptionRate: rate(reelUsers.size),
        totalCreated: reelsDocs.length,
      },
      spaces: {
        spaces: spacesStats?.spaces ?? 0,
        activeSpaces: spacesStats?.activeSpaces ?? 0,
        members: spacesMembers,
        adoptionRate: rate(spacesMembers),
      },
      calls: {
        users: callsUsers,
        adoptionRate: rate(callsUsers),
      },
      comments: {
        users: commentUsers.size,
        adoptionRate: rate(commentUsers.size),
      },
      reactions: {
        users: reactionUsers.size,
        adoptionRate: rate(reactionUsers.size),
      },
      adoptionSeries: dateKeys.map((date) => {
        const bucket = dailyMap.get(date)!;
        return {
          date,
          stories: bucket.stories.size,
          reels: bucket.reels.size,
          comments: bucket.comments.size,
          reactions: bucket.reactions.size,
        };
      }),
    };
  }

  async getGrowthAnalytics(period: AnalyticsPeriod = '90d') {
    const database = this.db();
    const now = new Date();
    const { days, start, end, dateKeys } = getPeriodRange(period, now);

    const [profiles, lastActivityMap, shareCount, sharedFollows, totalFollowSources] = await Promise.all([
      getProfilesCollection(database)
        .find({}, { projection: { userId: 1, createdAt: 1, isBanned: 1, bannedAt: 1, signupSource: 1 } as any })
        .toArray(),
      this.getUserActivityLastDates(database),
      getShareEventsCollection(database).countDocuments({ at: { $gte: start, $lt: end } }),
      getFollowSourcesCollection(database).countDocuments({
        source: 'suggestion',
        at: { $gte: start, $lt: end },
      }),
      getFollowSourcesCollection(database)
        .aggregate<{ _id: string; count: number }>([
          { $match: { at: { $gte: start, $lt: end } } },
          { $group: { _id: '$source', count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const newByDay = new Map<string, number>(dateKeys.map((dk) => [dk, 0]));
    const churnByDay = new Map<string, number>(dateKeys.map((dk) => [dk, 0]));
    const sourceCounts = new Map<string, number>();

    let beforeWindowUsers = 0;
    let newUsersInWindow = 0;

    type CohortAgg = {
      size: number;
      eligD1: number;
      retD1: number;
      eligD7: number;
      retD7: number;
      eligD30: number;
      retD30: number;
    };
    const cohorts = new Map<string, CohortAgg>();

    for (const p of profiles as Array<any>) {
      const createdAt = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt ?? now);
      const lastActive = lastActivityMap.get(p.userId) ?? createdAt;
      const ageMs = now.getTime() - createdAt.getTime();

      if (createdAt < start) {
        beforeWindowUsers++;
      } else if (createdAt >= start && createdAt < end) {
        newUsersInWindow++;
        const dk = toUtcDateKey(createdAt);
        newByDay.set(dk, (newByDay.get(dk) ?? 0) + 1);
        const src = typeof p.signupSource === 'string' && p.signupSource ? p.signupSource : 'direct';
        sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
      }

      if (p.isBanned && p.bannedAt) {
        const banDk = toUtcDateKey(p.bannedAt);
        if (churnByDay.has(banDk)) {
          churnByDay.set(banDk, (churnByDay.get(banDk) ?? 0) + 1);
        }
      }

      const week = getIsoWeekKey(createdAt);
      const c = cohorts.get(week) ?? {
        size: 0,
        eligD1: 0,
        retD1: 0,
        eligD7: 0,
        retD7: 0,
        eligD30: 0,
        retD30: 0,
      };
      c.size++;
      if (ageMs >= 86_400_000) {
        c.eligD1++;
        if (lastActive.getTime() >= createdAt.getTime() + 86_400_000) c.retD1++;
      }
      if (ageMs >= 7 * 86_400_000) {
        c.eligD7++;
        if (lastActive.getTime() >= createdAt.getTime() + 7 * 86_400_000) c.retD7++;
      }
      if (ageMs >= 30 * 86_400_000) {
        c.eligD30++;
        if (lastActive.getTime() >= createdAt.getTime() + 30 * 86_400_000) c.retD30++;
      }
      cohorts.set(week, c);
    }

    // Merge follow attribution sources as referral breakdown when explicit signupSource is all direct
    if (sourceCounts.size <= 1 && totalFollowSources.length > 0) {
      for (const row of totalFollowSources) {
        if (row._id) {
          sourceCounts.set(row._id, (sourceCounts.get(row._id) ?? 0) + row.count);
        }
      }
    }

    let runningTotal = beforeWindowUsers;
    const daily = dateKeys.map((date) => {
      const added = newByDay.get(date) ?? 0;
      const churn = churnByDay.get(date) ?? 0;
      runningTotal += added;
      return {
        date,
        new: added,
        total: runningTotal,
        churn,
      };
    });

    const retentionCohorts = Array.from(cohorts.entries())
      .map(([week, c]) => ({
        week,
        cohortSize: c.size,
        d1: c.eligD1 > 0 ? Number((c.retD1 / c.eligD1).toFixed(4)) : 0,
        d7: c.eligD7 > 0 ? Number((c.retD7 / c.eligD7).toFixed(4)) : 0,
        d30: c.eligD30 > 0 ? Number((c.retD30 / c.eligD30).toFixed(4)) : 0,
      }))
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-12);

    const avgDailyNew = newUsersInWindow / Math.max(1, days);
    const baseTotal = profiles.length;
    const viralDenom = Math.max(1, baseTotal);
    const viralCoefficient = Number(((shareCount + sharedFollows) / viralDenom).toFixed(2));

    return {
      period,
      daily,
      signupSources: Array.from(sourceCounts.entries())
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      retentionCohorts,
      viralCoefficient,
      projectedGrowth: {
        '30d': Math.round(baseTotal + avgDailyNew * 30),
        '60d': Math.round(baseTotal + avgDailyNew * 60),
        '90d': Math.round(baseTotal + avgDailyNew * 90),
      },
    };
  }

  async getLiveAnalytics() {
    const r = this.redis();
    const nowMs = Date.now();

    try {
      await Promise.all([
        r.zremrangebyscore('live:active_conversations', '-inf', nowMs - 300_000),
        r.zremrangebyscore('live:messages_last_minute', '-inf', nowMs - 60_000),
        r.zremrangebyscore('live:signups_last_hour', '-inf', nowMs - 3_600_000),
      ]);

      const [onlineRaw, activeConvs, activeCallsRaw, messagesLastMinute, signupsLastHour] =
        await Promise.all([
          r.get('live:online_users'),
          r.zcard('live:active_conversations'),
          r.get('live:active_calls'),
          r.zcard('live:messages_last_minute'),
          r.zcard('live:signups_last_hour'),
        ]);

      return {
        onlineUsers: Math.max(0, Number(onlineRaw ?? 0) || 0),
        activeConversations: Math.max(0, activeConvs),
        activeCalls: Math.max(0, Number(activeCallsRaw ?? 0) || 0),
        messagesLastMinute: Math.max(0, messagesLastMinute),
        signupsLastHour: Math.max(0, signupsLastHour),
        timestamp: new Date(nowMs).toISOString(),
      };
    } catch {
      return {
        onlineUsers: 0,
        activeConversations: 0,
        activeCalls: 0,
        messagesLastMinute: 0,
        signupsLastHour: 0,
        timestamp: new Date(nowMs).toISOString(),
      };
    }
  }
}

export const defaultAdminAnalyticsService = new AdminAnalyticsService();

export { durationBucketForSeconds };
