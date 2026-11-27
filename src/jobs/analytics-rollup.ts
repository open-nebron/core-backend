import { ObjectId, type Db } from 'mongodb';
import {
  getAnalyticsDailyCollection,
  getCommentsCollection,
  getContentViewsCollection,
  getCreatorDailyStatsCollection,
  getDb,
  getFollowsCollection,
  getFollowSourcesCollection,
  getImpressionsCollection,
  getPostLikesCollection,
  getPostsCollection,
  getProfilesCollection,
  getProfileVisitsCollection,
  getReelLikesCollection,
  getReelsCollection,
  getSavedPostsCollection,
  getSavedReelsCollection,
  getShareEventsCollection,
  getStoriesCollection,
  type AnalyticsContentType,
} from '../db/mongo.js';
import {
  aggregateRawMetricsWindow,
  getUtcDayBounds,
  itemCompositeKey,
  type ContentTargetRef,
} from '../modules/analytics/analytics.helpers.js';

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // Hourly
let rollupTimer: NodeJS.Timeout | null = null;

export interface AnalyticsRollupResult {
  date: string;
  contentUpdated: number;
  creatorsUpdated: number;
  errors: string[];
}

/**
 * Aggregates raw impressions, views, interactions, profile visits, and followers for a single
 * UTC calendar day (default: yesterday) and idempotently upserts `analytics_daily` & `creator_daily_stats`.
 */
export async function runAnalyticsRollup(
  targetDateInput?: Date | string,
  customDb?: Db
): Promise<AnalyticsRollupResult> {
  const database = customDb ?? getDb();
  const targetRef = targetDateInput ?? new Date(Date.now() - 86_400_000);
  const { dateKey, start: dayStart, end: dayEnd } = getUtcDayBounds(targetRef);
  const window7dStart = new Date(dayEnd.getTime() - 7 * 86_400_000);

  const errors: string[] = [];

  // Collect all active content from the last 7 days + any content touched on target day
  const [recentPosts, recentReels, recentStories, dayImps, dayViews, dayPostLikes, dayReelLikes, dayComments, daySavedPosts, daySavedReels, dayShares] =
    await Promise.all([
      getPostsCollection(database)
        .find({ deleted: false, createdAt: { $gte: window7dStart, $lt: dayEnd } })
        .toArray(),
      getReelsCollection(database)
        .find({ deleted: false, createdAt: { $gte: window7dStart, $lt: dayEnd } })
        .toArray(),
      getStoriesCollection(database)
        .find({ createdAt: { $gte: window7dStart, $lt: dayEnd } })
        .toArray(),
      getImpressionsCollection(database).find({ seenAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getContentViewsCollection(database).find({ startedAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getPostLikesCollection(database).find({ createdAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getReelLikesCollection(database).find({ createdAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getCommentsCollection(database).find({ deleted: false, createdAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getSavedPostsCollection(database).find({ savedAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getSavedReelsCollection(database).find({ savedAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
      getShareEventsCollection(database).find({ at: { $gte: dayStart, $lt: dayEnd } }).toArray(),
    ]);

  const contentMap = new Map<string, ContentTargetRef>();
  const missingPostIds = new Set<string>();
  const missingReelIds = new Set<string>();
  const missingStoryIds = new Set<string>();

  for (const p of recentPosts) {
    const cid = p._id.toString();
    contentMap.set(itemCompositeKey('post', cid), {
      contentType: 'post',
      contentId: cid,
      authorId: p.authorId,
      preview: (p.body || '').slice(0, 120),
      createdAt: p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt),
    });
  }
  for (const r of recentReels) {
    const cid = r._id.toString();
    contentMap.set(itemCompositeKey('reel', cid), {
      contentType: 'reel',
      contentId: cid,
      authorId: r.authorId,
      preview: (r.caption || 'Reel').slice(0, 120),
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    });
  }
  for (const s of recentStories) {
    const cid = s._id.toString();
    contentMap.set(itemCompositeKey('story', cid), {
      contentType: 'story',
      contentId: cid,
      authorId: s.authorId,
      preview: (s.caption || 'Story').slice(0, 120),
      createdAt: s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt),
      storyViewers: s.viewers ?? [],
    });
  }

  const queueMissing = (type: AnalyticsContentType, cid: string) => {
    if (!cid || contentMap.has(itemCompositeKey(type, cid))) return;
    if (type === 'post') missingPostIds.add(cid);
    else if (type === 'reel') missingReelIds.add(cid);
    else if (type === 'story') missingStoryIds.add(cid);
  };

  for (const imp of dayImps) queueMissing(imp.contentType, imp.contentId);
  for (const v of dayViews) queueMissing(v.contentType as AnalyticsContentType, v.contentId);
  for (const pl of dayPostLikes) queueMissing('post', pl.postId.toString());
  for (const rl of dayReelLikes) queueMissing('reel', rl.reelId.toString());
  for (const c of dayComments) {
    if (c.reelId) queueMissing('reel', c.reelId.toString());
    else if (c.postId) queueMissing('post', c.postId.toString());
  }
  for (const sp of daySavedPosts) queueMissing('post', sp.postId.toString());
  for (const sr of daySavedReels) queueMissing('reel', sr.reelId.toString());
  for (const sh of dayShares) {
    if (sh.contentType === 'post' || sh.contentType === 'reel') {
      queueMissing(sh.contentType, sh.contentId);
    }
  }

  const toOids = (set: Set<string>) =>
    Array.from(set)
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

  const [extraPosts, extraReels, extraStories] = await Promise.all([
    missingPostIds.size > 0
      ? getPostsCollection(database).find({ _id: { $in: toOids(missingPostIds) }, deleted: false }).toArray()
      : Promise.resolve([]),
    missingReelIds.size > 0
      ? getReelsCollection(database).find({ _id: { $in: toOids(missingReelIds) }, deleted: false }).toArray()
      : Promise.resolve([]),
    missingStoryIds.size > 0
      ? getStoriesCollection(database).find({ _id: { $in: toOids(missingStoryIds) } }).toArray()
      : Promise.resolve([]),
  ]);

  for (const p of extraPosts) {
    const cid = p._id.toString();
    contentMap.set(itemCompositeKey('post', cid), {
      contentType: 'post',
      contentId: cid,
      authorId: p.authorId,
      preview: (p.body || '').slice(0, 120),
      createdAt: p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt),
    });
  }
  for (const r of extraReels) {
    const cid = r._id.toString();
    contentMap.set(itemCompositeKey('reel', cid), {
      contentType: 'reel',
      contentId: cid,
      authorId: r.authorId,
      preview: (r.caption || 'Reel').slice(0, 120),
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    });
  }
  for (const s of extraStories) {
    const cid = s._id.toString();
    contentMap.set(itemCompositeKey('story', cid), {
      contentType: 'story',
      contentId: cid,
      authorId: s.authorId,
      preview: (s.caption || 'Story').slice(0, 120),
      createdAt: s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt),
      storyViewers: s.viewers ?? [],
    });
  }

  const allItems = Array.from(contentMap.values());
  const { totalsByItem } = await aggregateRawMetricsWindow(database, allItems, dayStart, dayEnd);

  // Gather creator profile visits & new followers on targetDate
  const [dayFollows, dayFollowSources, dayProfileVisits] = await Promise.all([
    getFollowsCollection(database).find({ createdAt: { $gte: dayStart, $lt: dayEnd } }).toArray(),
    getFollowSourcesCollection(database).find({ at: { $gte: dayStart, $lt: dayEnd } }).toArray(),
    getProfileVisitsCollection(database).find({ at: { $gte: dayStart, $lt: dayEnd } }).toArray(),
  ]);

  const creatorVisitsCount = new Map<string, number>();
  for (const pv of dayProfileVisits) {
    creatorVisitsCount.set(pv.visitedUserId, (creatorVisitsCount.get(pv.visitedUserId) ?? 0) + 1);
  }

  const creatorFollowsCount = new Map<string, number>();
  for (const f of dayFollows) {
    creatorFollowsCount.set(f.followingId, (creatorFollowsCount.get(f.followingId) ?? 0) + 1);
  }

  const reelFollowsCount = new Map<string, number>();
  for (const fs of dayFollowSources) {
    if (fs.source === 'reel') {
      reelFollowsCount.set(fs.followingId, (reelFollowsCount.get(fs.followingId) ?? 0) + 1);
    }
  }

  const analyticsDailyCol = getAnalyticsDailyCollection(database);
  const creatorIds = new Set<string>();
  const creatorItemBuckets = new Map<
    string,
    {
      likes: number;
      views: number;
      impressions: number;
      reach: number;
      comments: number;
      shares: number;
      saves: number;
      postsCreated: number;
      reelsCreated: number;
      storiesCreated: number;
    }
  >();

  const ensureCreatorBucket = (uid: string) => {
    creatorIds.add(uid);
    let b = creatorItemBuckets.get(uid);
    if (!b) {
      b = {
        likes: 0,
        views: 0,
        impressions: 0,
        reach: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        postsCreated: 0,
        reelsCreated: 0,
        storiesCreated: 0,
      };
      creatorItemBuckets.set(uid, b);
    }
    return b;
  };

  for (const uid of creatorVisitsCount.keys()) ensureCreatorBucket(uid);
  for (const uid of creatorFollowsCount.keys()) ensureCreatorBucket(uid);

  let contentUpdated = 0;
  const now = new Date();

  for (const item of allItems) {
    const ik = itemCompositeKey(item.contentType, item.contentId);
    const m = totalsByItem.get(ik);
    if (!m) continue;

    const bucket = ensureCreatorBucket(item.authorId);
    const createdToday = item.createdAt >= dayStart && item.createdAt < dayEnd;
    if (createdToday) {
      if (item.contentType === 'post') bucket.postsCreated++;
      else if (item.contentType === 'reel') bucket.reelsCreated++;
      else if (item.contentType === 'story') bucket.storiesCreated++;
    }

    bucket.likes += m.likes;
    bucket.views += m.views;
    bucket.impressions += m.impressions;
    bucket.reach += m.reach;
    bucket.comments += m.comments;
    bucket.shares += m.shares;
    bucket.saves += m.saves;

    const hasActivity =
      createdToday ||
      m.impressions > 0 ||
      m.views > 0 ||
      m.likes > 0 ||
      m.comments > 0 ||
      m.shares > 0 ||
      m.saves > 0;

    if (!hasActivity) continue;

    try {
      await analyticsDailyCol.updateOne(
        { contentType: item.contentType, contentId: item.contentId, date: dateKey },
        {
          $set: {
            contentType: item.contentType,
            contentId: item.contentId,
            authorId: item.authorId,
            preview: item.preview,
            contentCreatedAt: item.createdAt,
            date: dateKey,
            impressions: m.impressions,
            reach: m.reach,
            views: m.views,
            uniqueViews: m.uniqueViews,
            watchSeconds: m.watchSeconds,
            completions: m.completions,
            tapsForward: m.tapsForward,
            tapsBack: m.tapsBack,
            exits: m.exits,
            replays: m.replays,
            likes: m.likes,
            comments: m.comments,
            replies: m.replies,
            shares: m.shares,
            saves: m.saves,
            profileVisits: creatorVisitsCount.get(item.authorId) ?? 0,
            newFollowers:
              item.contentType === 'reel'
                ? (reelFollowsCount.get(item.authorId) ?? 0)
                : (creatorFollowsCount.get(item.authorId) ?? 0),
            updatedAt: now,
          },
        },
        { upsert: true }
      );
      contentUpdated++;
    } catch (err: any) {
      errors.push(`analytics_daily upsert failed for ${ik}: ${err?.message || err}`);
    }
  }

  // Upsert creator_daily_stats
  const creatorIdList = Array.from(creatorIds);
  let creatorsUpdated = 0;

  if (creatorIdList.length > 0) {
    const profiles = await getProfilesCollection(database)
      .find({ userId: { $in: creatorIdList } })
      .toArray();
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    const creatorStatsCol = getCreatorDailyStatsCollection(database);

    for (const uid of creatorIdList) {
      const bucket = creatorItemBuckets.get(uid)!;
      const profile = profileMap.get(uid);
      const totalFollowers = profile?.followerCount ?? 0;

      try {
        await creatorStatsCol.updateOne(
          { userId: uid, date: dateKey },
          {
            $set: {
              userId: uid,
              date: dateKey,
              totalFollowers,
              followersGained: creatorFollowsCount.get(uid) ?? 0,
              totalLikesReceived: bucket.likes,
              totalViews: bucket.views,
              totalImpressions: bucket.impressions,
              totalReach: bucket.reach,
              totalCommentsReceived: bucket.comments,
              totalSharesReceived: bucket.shares,
              totalSavesReceived: bucket.saves,
              profileVisits: creatorVisitsCount.get(uid) ?? 0,
              postsCreated: bucket.postsCreated,
              reelsCreated: bucket.reelsCreated,
              storiesCreated: bucket.storiesCreated,
              updatedAt: now,
            },
          },
          { upsert: true }
        );
        creatorsUpdated++;
      } catch (err: any) {
        errors.push(`creator_daily_stats upsert failed for ${uid}: ${err?.message || err}`);
      }
    }
  }

  return {
    date: dateKey,
    contentUpdated,
    creatorsUpdated,
    errors,
  };
}

export function startAnalyticsRollupScheduler(): void {
  if (rollupTimer) return;
  rollupTimer = setInterval(async () => {
    try {
      const res = await runAnalyticsRollup();
      if (res.contentUpdated > 0 || res.creatorsUpdated > 0 || res.errors.length > 0) {
        console.log(
          `[AnalyticsRollup] ${res.date}: ${res.contentUpdated} content rows, ${res.creatorsUpdated} creator rows (errors: ${res.errors.length})`
        );
      }
    } catch (err: any) {
      console.error('[AnalyticsRollup] Scheduled rollup failed:', err?.message || err);
    }
  }, ROLLUP_INTERVAL_MS);

  if (typeof rollupTimer.unref === 'function') {
    rollupTimer.unref();
  }
}

export function stopAnalyticsRollupScheduler(): void {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
}
