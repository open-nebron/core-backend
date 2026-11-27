import { ObjectId, type Db } from 'mongodb';
import {
  getCommentsCollection,
  getContentViewsCollection,
  getImpressionsCollection,
  getPostLikesCollection,
  getReelLikesCollection,
  getSavedPostsCollection,
  getSavedReelsCollection,
  getShareEventsCollection,
  type AnalyticsContentType,
  type StoryViewerEntry,
} from '../../db/mongo.js';

export type AnalyticsPeriod = '7d' | '30d' | '90d';

export interface ContentTargetRef {
  contentType: AnalyticsContentType;
  contentId: string;
  authorId: string;
  preview: string;
  createdAt: Date;
  storyViewers?: StoryViewerEntry[];
}

export interface DayContentMetrics {
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
  hourEngagement: number[]; // length 24 UTC histogram
}

export function createEmptyDayMetrics(): DayContentMetrics {
  return {
    impressions: 0,
    reach: 0,
    views: 0,
    uniqueViews: 0,
    watchSeconds: 0,
    completions: 0,
    tapsForward: 0,
    tapsBack: 0,
    exits: 0,
    replays: 0,
    likes: 0,
    comments: 0,
    replies: 0,
    shares: 0,
    saves: 0,
    hourEngagement: new Array(24).fill(0),
  };
}

/**
 * Formats a Date as a UTC calendar date string 'YYYY-MM-DD'.
 */
export function toUtcDateKey(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

/**
 * Computes half-open UTC [start, end) Date bounds for a date or 'YYYY-MM-DD' key.
 */
export function getUtcDayBounds(dateInput: Date | string): { dateKey: string; start: Date; end: Date } {
  const dateKey = typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)
    ? dateInput
    : toUtcDateKey(dateInput);
  const start = new Date(`${dateKey}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { dateKey, start, end };
}

/**
 * Computes UTC date bounds and ascending 'YYYY-MM-DD' keys covering the requested analytics period.
 */
export function getPeriodRange(
  period: AnalyticsPeriod,
  now: Date = new Date()
): { days: number; start: Date; end: Date; dateKeys: string[]; todayKey: string } {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const todayKey = toUtcDateKey(now);
  const todayStart = new Date(`${todayKey}T00:00:00.000Z`);
  const start = new Date(todayStart.getTime() - (days - 1) * 86_400_000);

  const dateKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(toUtcDateKey(new Date(start.getTime() + i * 86_400_000)));
  }

  return { days, start, end: now, dateKeys, todayKey };
}

export function itemCompositeKey(contentType: AnalyticsContentType, contentId: string): string {
  return `${contentType}:${contentId}`;
}

export function dayCompositeKey(
  contentType: AnalyticsContentType,
  contentId: string,
  dateKey: string
): string {
  return `${contentType}:${contentId}:${dateKey}`;
}

/**
 * Aggregates raw impression, view, watch-through, like, comment, share, and save events
 * across `[start, end)` per content item and per UTC day bucket.
 */
export async function aggregateRawMetricsWindow(
  database: Db,
  items: ContentTargetRef[],
  start: Date,
  end: Date
): Promise<{
  totalsByItem: Map<string, DayContentMetrics>;
  byItemDay: Map<string, DayContentMetrics>;
}> {
  const totalsByItem = new Map<string, DayContentMetrics>();
  const byItemDay = new Map<string, DayContentMetrics>();

  if (items.length === 0) {
    return { totalsByItem, byItemDay };
  }

  const allIds = Array.from(new Set(items.map((i) => i.contentId)));
  const itemMeta = new Map<string, ContentTargetRef>();
  const postOids: ObjectId[] = [];
  const reelOids: ObjectId[] = [];
  const storyViewMap = new Map<string, ContentTargetRef>();

  for (const item of items) {
    totalsByItem.set(itemCompositeKey(item.contentType, item.contentId), createEmptyDayMetrics());
    itemMeta.set(itemCompositeKey(item.contentType, item.contentId), item);
    if (!ObjectId.isValid(item.contentId)) continue;
    if (item.contentType === 'post') postOids.push(new ObjectId(item.contentId));
    else if (item.contentType === 'reel') reelOids.push(new ObjectId(item.contentId));
    else if (item.contentType === 'story') storyViewMap.set(item.contentId, item);
  }

  const touchDay = (contentType: AnalyticsContentType, contentId: string, dateKey: string): DayContentMetrics => {
    const dk = dayCompositeKey(contentType, contentId, dateKey);
    let m = byItemDay.get(dk);
    if (!m) {
      m = createEmptyDayMetrics();
      byItemDay.set(dk, m);
    }
    return m;
  };

  const commentTargetClauses: Record<string, unknown>[] = [];
  if (postOids.length > 0) commentTargetClauses.push({ postId: { $in: postOids } });
  if (reelOids.length > 0) commentTargetClauses.push({ reelId: { $in: reelOids } });

  const [
    impressionDocs,
    viewDocs,
    postLikeDocs,
    reelLikeDocs,
    commentDocs,
    savedPostDocs,
    savedReelDocs,
    shareDocs,
  ] = await Promise.all([
    getImpressionsCollection(database)
      .find({ contentId: { $in: allIds }, seenAt: { $gte: start, $lt: end } })
      .toArray(),
    getContentViewsCollection(database)
      .find({ contentId: { $in: allIds }, startedAt: { $gte: start, $lt: end } })
      .toArray(),
    postOids.length > 0
      ? getPostLikesCollection(database)
          .find({ postId: { $in: postOids }, createdAt: { $gte: start, $lt: end } })
          .toArray()
      : Promise.resolve([]),
    reelOids.length > 0
      ? getReelLikesCollection(database)
          .find({ reelId: { $in: reelOids }, createdAt: { $gte: start, $lt: end } })
          .toArray()
      : Promise.resolve([]),
    commentTargetClauses.length > 0
      ? getCommentsCollection(database)
          .find({ $or: commentTargetClauses, deleted: false, createdAt: { $gte: start, $lt: end } })
          .toArray()
      : Promise.resolve([]),
    postOids.length > 0
      ? getSavedPostsCollection(database)
          .find({ postId: { $in: postOids }, savedAt: { $gte: start, $lt: end } })
          .toArray()
      : Promise.resolve([]),
    reelOids.length > 0
      ? getSavedReelsCollection(database)
          .find({ reelId: { $in: reelOids }, savedAt: { $gte: start, $lt: end } })
          .toArray()
      : Promise.resolve([]),
    getShareEventsCollection(database)
      .find({ contentId: { $in: allIds }, at: { $gte: start, $lt: end } })
      .toArray(),
  ]);

  // Track unique sets separately for reach and uniqueViews
  const reachSetsTotal = new Map<string, Set<string>>();
  const reachSetsDay = new Map<string, Set<string>>();
  const viewSetsTotal = new Map<string, Set<string>>();
  const viewSetsDay = new Map<string, Set<string>>();
  const explicitReplaysTotal = new Map<string, number>();
  const explicitReplaysDay = new Map<string, number>();

  const addSet = (map: Map<string, Set<string>>, key: string, userId: string) => {
    let s = map.get(key);
    if (!s) {
      s = new Set<string>();
      map.set(key, s);
    }
    s.add(userId);
  };

  for (const imp of impressionDocs) {
    const ik = itemCompositeKey(imp.contentType, imp.contentId);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = imp.seenAt instanceof Date ? imp.seenAt : new Date(imp.seenAt);
    const dateKey = toUtcDateKey(d);
    const hour = d.getUTCHours();
    const day = touchDay(imp.contentType, imp.contentId, dateKey);

    total.impressions++;
    day.impressions++;
    total.hourEngagement[hour]++;
    day.hourEngagement[hour]++;

    if (imp.contentType === 'post') {
      total.views++;
      day.views++;
    }
    addSet(reachSetsTotal, ik, imp.userId);
    addSet(reachSetsDay, dayCompositeKey(imp.contentType, imp.contentId, dateKey), imp.userId);
  }

  for (const v of viewDocs) {
    const ik = itemCompositeKey(v.contentType, v.contentId);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = v.startedAt instanceof Date ? v.startedAt : new Date(v.startedAt);
    const dateKey = toUtcDateKey(d);
    const hour = d.getUTCHours();
    const dk = dayCompositeKey(v.contentType, v.contentId, dateKey);
    const day = touchDay(v.contentType, v.contentId, dateKey);

    total.views++;
    day.views++;
    total.hourEngagement[hour]++;
    day.hourEngagement[hour]++;

    const ws = Math.max(0, Number(v.watchedSeconds) || 0);
    total.watchSeconds += ws;
    day.watchSeconds += ws;

    if (v.completed) {
      total.completions++;
      day.completions++;
    }
    if (v.exited) {
      total.exits++;
      day.exits++;
    }
    const tf = Math.max(0, Number(v.tapsForward) || 0);
    const tb = Math.max(0, Number(v.tapsBack) || 0);
    total.tapsForward += tf;
    day.tapsForward += tf;
    total.tapsBack += tb;
    day.tapsBack += tb;

    if (v.replayed) {
      explicitReplaysTotal.set(ik, (explicitReplaysTotal.get(ik) ?? 0) + 1);
      explicitReplaysDay.set(dk, (explicitReplaysDay.get(dk) ?? 0) + 1);
    }

    addSet(viewSetsTotal, ik, v.userId);
    addSet(viewSetsDay, dk, v.userId);
  }

  // Merge legacy story.viewers entries when view sessions weren't explicitly recorded via beacon
  for (const [storyId, storyRef] of storyViewMap.entries()) {
    const viewers = storyRef.storyViewers ?? [];
    if (viewers.length === 0) continue;
    const ik = itemCompositeKey('story', storyId);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    let legacyViewsInWindow = 0;
    const legacyPerDay = new Map<string, number>();

    for (const entry of viewers) {
      const vd = entry.viewedAt instanceof Date ? entry.viewedAt : new Date(entry.viewedAt);
      if (vd < start || vd >= end) continue;
      legacyViewsInWindow++;
      const dKey = toUtcDateKey(vd);
      legacyPerDay.set(dKey, (legacyPerDay.get(dKey) ?? 0) + 1);
      addSet(viewSetsTotal, ik, entry.userId);
      addSet(viewSetsDay, dayCompositeKey('story', storyId, dKey), entry.userId);
    }

    total.views = Math.max(total.views, legacyViewsInWindow);
    for (const [dKey, count] of legacyPerDay.entries()) {
      const day = touchDay('story', storyId, dKey);
      day.views = Math.max(day.views, count);
    }
  }

  for (const like of postLikeDocs) {
    const cid = like.postId.toString();
    const ik = itemCompositeKey('post', cid);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = like.createdAt instanceof Date ? like.createdAt : new Date(like.createdAt);
    const day = touchDay('post', cid, toUtcDateKey(d));
    const hour = d.getUTCHours();
    total.likes++;
    day.likes++;
    total.hourEngagement[hour]++;
    day.hourEngagement[hour]++;
  }

  for (const like of reelLikeDocs) {
    const cid = like.reelId.toString();
    const ik = itemCompositeKey('reel', cid);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = like.createdAt instanceof Date ? like.createdAt : new Date(like.createdAt);
    const day = touchDay('reel', cid, toUtcDateKey(d));
    const hour = d.getUTCHours();
    total.likes++;
    day.likes++;
    total.hourEngagement[hour]++;
    day.hourEngagement[hour]++;
  }

  for (const c of commentDocs) {
    const isReel = c.targetType === 'reel' || (Boolean(c.reelId) && !c.postId);
    const cType: AnalyticsContentType = isReel ? 'reel' : 'post';
    const cid = (isReel ? c.reelId : c.postId)?.toString();
    if (!cid) continue;
    const ik = itemCompositeKey(cType, cid);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt);
    const day = touchDay(cType, cid, toUtcDateKey(d));
    const hour = d.getUTCHours();
    total.comments++;
    day.comments++;
    total.hourEngagement[hour]++;
    day.hourEngagement[hour]++;
  }

  for (const sp of savedPostDocs) {
    const cid = sp.postId.toString();
    const ik = itemCompositeKey('post', cid);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = sp.savedAt instanceof Date ? sp.savedAt : new Date(sp.savedAt);
    const day = touchDay('post', cid, toUtcDateKey(d));
    total.saves++;
    day.saves++;
  }

  for (const sr of savedReelDocs) {
    const cid = sr.reelId.toString();
    const ik = itemCompositeKey('reel', cid);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = sr.savedAt instanceof Date ? sr.savedAt : new Date(sr.savedAt);
    const day = touchDay('reel', cid, toUtcDateKey(d));
    total.saves++;
    day.saves++;
  }

  for (const sh of shareDocs) {
    if (sh.contentType !== 'post' && sh.contentType !== 'reel') continue;
    const ik = itemCompositeKey(sh.contentType, sh.contentId);
    const total = totalsByItem.get(ik);
    if (!total) continue;
    const d = sh.at instanceof Date ? sh.at : new Date(sh.at);
    const day = touchDay(sh.contentType, sh.contentId, toUtcDateKey(d));
    const hour = d.getUTCHours();
    total.shares++;
    day.shares++;
    total.hourEngagement[hour]++;
    day.hourEngagement[hour]++;
  }

  // Finalize unique sets and replay calculations
  for (const [ik, total] of totalsByItem.entries()) {
    const item = itemMeta.get(ik);
    if (!item) continue;
    total.reach = reachSetsTotal.get(ik)?.size ?? 0;
    if (item.contentType === 'post') {
      total.uniqueViews = total.reach;
    } else {
      total.uniqueViews = viewSetsTotal.get(ik)?.size ?? 0;
      total.replays = Math.max(
        explicitReplaysTotal.get(ik) ?? 0,
        Math.max(0, total.views - total.uniqueViews)
      );
    }
  }

  for (const [dk, day] of byItemDay.entries()) {
    const isPost = dk.startsWith('post:');
    day.reach = reachSetsDay.get(dk)?.size ?? 0;
    if (isPost) {
      day.uniqueViews = day.reach;
    } else {
      day.uniqueViews = viewSetsDay.get(dk)?.size ?? 0;
      day.replays = Math.max(
        explicitReplaysDay.get(dk) ?? 0,
        Math.max(0, day.views - day.uniqueViews)
      );
    }
  }

  return { totalsByItem, byItemDay };
}
