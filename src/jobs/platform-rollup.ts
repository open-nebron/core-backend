import type { Db } from 'mongodb';
import { env } from '../config/env.js';
import {
  getAdminActionsCollection,
  getCommentLikesCollection,
  getCommentsCollection,
  getContentViewsCollection,
  getDb,
  getEngagementEventsCollection,
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
  type PlatformDailyStatsDocument,
} from '../db/mongo.js';
import { getUtcDayBounds } from '../modules/analytics/analytics.helpers.js';

const PLATFORM_ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // Hourly
let platformRollupTimer: NodeJS.Timeout | null = null;

export interface PlatformRollupOptions {
  db?: Db;
  chatUrl?: string;
  voiceUrl?: string;
}

export interface PlatformRollupResult {
  date: string;
  upserted: boolean;
  stats: PlatformDailyStatsDocument;
  errors: string[];
}

export interface InternalChatMessagesStats {
  totalMessages: number;
  totalConversations: number;
  activeConversations: number;
  daily?: Array<{ date: string; messages: number; activeConversations: number }>;
  groups?: { totalGroups: number; activeGroups: number };
}

export interface InternalVoiceCallsStats {
  totalCalls: number;
  completedCalls?: number;
  avgDurationSeconds: number;
  totalMinutes: number;
  byType: { audio: number; video: number };
  uniqueUsersCount: number;
  daily?: Array<{ date: string; callsMade: number; callMinutes: number }>;
  durationHistogram?: Array<{ bucket: string; count: number }>;
}

/**
 * Queries distinct active user IDs in `[start, end)` across sessions, content creation,
 * comments, impressions, views, and engagement events (platform-wide, no block filters).
 */
export async function getActiveUserSetInWindow(
  database: Db,
  start: Date,
  end: Date
): Promise<Set<string>> {
  const [
    seenProfiles,
    newProfiles,
    postAuthors,
    reelAuthors,
    storyAuthors,
    commentAuthors,
    impressionUsers,
    viewUsers,
    engagedUsers,
  ] = await Promise.all([
    getProfilesCollection(database).distinct('userId', { lastSeenAt: { $gte: start, $lt: end } }),
    getProfilesCollection(database).distinct('userId', { createdAt: { $gte: start, $lt: end } }),
    getPostsCollection(database).distinct('authorId', { deleted: false, createdAt: { $gte: start, $lt: end } }),
    getReelsCollection(database).distinct('authorId', { deleted: false, createdAt: { $gte: start, $lt: end } }),
    getStoriesCollection(database).distinct('authorId', { createdAt: { $gte: start, $lt: end } }),
    getCommentsCollection(database).distinct('authorId', { deleted: false, createdAt: { $gte: start, $lt: end } }),
    getImpressionsCollection(database).distinct('userId', { seenAt: { $gte: start, $lt: end } }),
    getContentViewsCollection(database).distinct('userId', { startedAt: { $gte: start, $lt: end } }),
    getEngagementEventsCollection(database).distinct('userId', { at: { $gte: start, $lt: end } }),
  ]);

  const set = new Set<string>();
  for (const list of [
    seenProfiles,
    newProfiles,
    postAuthors,
    reelAuthors,
    storyAuthors,
    commentAuthors,
    impressionUsers,
    viewUsers,
    engagedUsers,
  ]) {
    for (const id of list) {
      if (typeof id === 'string' && id.length > 0) set.add(id);
    }
  }
  return set;
}

/**
 * Fetches internal JSON metrics from sibling services with an internal token header
 * and short timeout, returning null when the downstream service is unreachable.
 */
export async function fetchInternalAnalyticsJson<T>(
  baseUrl: string,
  path: string,
  errors?: string[]
): Promise<T | null> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-internal-token': env.INTERNAL_TOKEN,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      errors?.push(`HTTP ${res.status} from ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    errors?.push(`Request failed for ${url}: ${err?.message || String(err)}`);
    return null;
  }
}

/**
 * Computes average report resolution duration in hours across resolved/dismissed reports.
 */
export function computeAvgResolutionHours(
  resolvedReports: Array<{ createdAt?: Date | string | null; resolvedAt?: Date | string | null }>
): number {
  let sumHours = 0;
  let count = 0;
  for (const r of resolvedReports) {
    if (!r.resolvedAt || !r.createdAt) continue;
    const resolvedMs = (r.resolvedAt instanceof Date ? r.resolvedAt : new Date(r.resolvedAt)).getTime();
    const createdMs = (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).getTime();
    if (Number.isNaN(resolvedMs) || Number.isNaN(createdMs)) continue;
    sumHours += Math.max(0, (resolvedMs - createdMs) / 3_600_000);
    count++;
  }
  return count > 0 ? Number((sumHours / count).toFixed(2)) : 0;
}

/**
 * Aggregates platform-wide metrics across core MongoDB, chat-service, and voice-service
 * for a single UTC calendar day (default: yesterday) and idempotently upserts `platform_daily_stats`.
 */
export async function runPlatformRollup(
  targetDateInput?: Date | string,
  options: PlatformRollupOptions = {}
): Promise<PlatformRollupResult> {
  const database = options.db ?? getDb();
  const chatUrl = options.chatUrl ?? env.CHAT_SERVICE_URL;
  const voiceUrl = options.voiceUrl ?? env.VOICE_SERVICE_URL;

  const targetRef = targetDateInput ?? new Date(Date.now() - 86_400_000);
  const { dateKey, start: dayStart, end: dayEnd } = getUtcDayBounds(targetRef);
  const wauStart = new Date(dayEnd.getTime() - 7 * 86_400_000);
  const mauStart = new Date(dayEnd.getTime() - 30 * 86_400_000);
  const errors: string[] = [];

  const [
    totalUsers,
    newUsers,
    bannedUsers,
    verifiedUsers,
    dauSet,
    wauSet,
    mauSet,
    postsCreated,
    reelsCreated,
    storiesCreated,
    postLikesCount,
    reelLikesCount,
    commentLikesCount,
    commentsCount,
    sharesCount,
    savedPostsCount,
    savedReelsCount,
    savedCommentsCount,
    reportsCreated,
    resolvedReportsDocs,
    usersBanned,
  ] = await Promise.all([
    getProfilesCollection(database).countDocuments({ createdAt: { $lt: dayEnd } }),
    getProfilesCollection(database).countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getProfilesCollection(database).countDocuments({
      isBanned: true,
      createdAt: { $lt: dayEnd },
    }),
    getProfilesCollection(database).countDocuments({
      isVerified: true,
      createdAt: { $lt: dayEnd },
    } as any),
    getActiveUserSetInWindow(database, dayStart, dayEnd),
    getActiveUserSetInWindow(database, wauStart, dayEnd),
    getActiveUserSetInWindow(database, mauStart, dayEnd),
    getPostsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getReelsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getStoriesCollection(database).countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getPostLikesCollection(database).countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getReelLikesCollection(database).countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getCommentLikesCollection(database).countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getCommentsCollection(database).countDocuments({ deleted: false, createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getShareEventsCollection(database).countDocuments({ at: { $gte: dayStart, $lt: dayEnd } }),
    getSavedPostsCollection(database).countDocuments({ savedAt: { $gte: dayStart, $lt: dayEnd } }),
    getSavedReelsCollection(database).countDocuments({ savedAt: { $gte: dayStart, $lt: dayEnd } }),
    getSavedCommentsCollection(database).countDocuments({ savedAt: { $gte: dayStart, $lt: dayEnd } }),
    getReportsCollection(database).countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }),
    getReportsCollection(database)
      .find({
        status: { $in: ['resolved', 'dismissed'] },
        resolvedAt: { $gte: dayStart, $lt: dayEnd },
      })
      .project({ createdAt: 1, resolvedAt: 1 })
      .toArray(),
    getAdminActionsCollection(database).countDocuments({
      action: 'ban_user',
      createdAt: { $gte: dayStart, $lt: dayEnd },
    }),
  ]);

  const sinceIso = encodeURIComponent(dayStart.toISOString());
  const untilIso = encodeURIComponent(dayEnd.toISOString());

  const [chatStats, voiceStats] = await Promise.all([
    fetchInternalAnalyticsJson<InternalChatMessagesStats>(
      chatUrl,
      `/internal/analytics/messages?since=${sinceIso}&until=${untilIso}`,
      errors
    ),
    fetchInternalAnalyticsJson<InternalVoiceCallsStats>(
      voiceUrl,
      `/internal/analytics/calls?since=${sinceIso}&until=${untilIso}`,
      errors
    ),
  ]);

  const now = new Date();
  const doc: PlatformDailyStatsDocument = {
    date: dateKey,
    users: {
      total: totalUsers,
      new: newUsers,
      dau: dauSet.size,
      wau: wauSet.size,
      mau: mauSet.size,
      banned: bannedUsers,
      verified: verifiedUsers,
    },
    content: {
      postsCreated,
      reelsCreated,
      storiesCreated,
      totalLikes: postLikesCount + reelLikesCount + commentLikesCount,
      totalComments: commentsCount,
      totalShares: sharesCount,
      totalSaves: savedPostsCount + savedReelsCount + savedCommentsCount,
    },
    chat: {
      messagesSent: chatStats?.totalMessages ?? 0,
      conversationsActive: chatStats?.activeConversations ?? 0,
      callsMade: voiceStats?.totalCalls ?? 0,
      callMinutes: voiceStats?.totalMinutes ?? 0,
    },
    moderation: {
      reportsCreated,
      reportsResolved: resolvedReportsDocs.length,
      usersBanned,
      avgResolutionTimeHours: computeAvgResolutionHours(resolvedReportsDocs),
    },
    updatedAt: now,
  };

  await getPlatformDailyStatsCollection(database).updateOne(
    { date: dateKey },
    { $set: doc },
    { upsert: true }
  );

  return {
    date: dateKey,
    upserted: true,
    stats: doc,
    errors,
  };
}

export function startPlatformRollupScheduler(): void {
  if (platformRollupTimer) return;
  platformRollupTimer = setInterval(async () => {
    try {
      const res = await runPlatformRollup();
      if (res.errors.length > 0) {
        console.warn(`[PlatformRollup] ${res.date} completed with warnings:`, res.errors.join('; '));
      } else {
        console.log(`[PlatformRollup] ${res.date}: users=${res.stats.users.total}, posts=${res.stats.content.postsCreated}`);
      }
    } catch (err: any) {
      console.error('[PlatformRollup] Scheduled rollup failed:', err?.message || err);
    }
  }, PLATFORM_ROLLUP_INTERVAL_MS);

  if (typeof platformRollupTimer.unref === 'function') {
    platformRollupTimer.unref();
  }
}

export function stopPlatformRollupScheduler(): void {
  if (platformRollupTimer) {
    clearInterval(platformRollupTimer);
    platformRollupTimer = null;
  }
}
