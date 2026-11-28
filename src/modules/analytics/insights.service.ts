import { ObjectId, type Db } from 'mongodb';
import {
  getAnalyticsDailyCollection,
  getContentViewsCollection,
  getCreatorDailyStatsCollection,
  getDb,
  getEngagementEventsCollection,
  getFollowSourcesCollection,
  getFollowsCollection,
  getImpressionsCollection,
  getPostsCollection,
  getProfilesCollection,
  getReelsCollection,
  getStoriesCollection,
  getUnfollowEventsCollection,
  type AnalyticsContentType,
  type AnalyticsSource,
  type FollowSourceType,
} from '../../db/mongo.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { getBlockedUserIds } from '../social/block-filter.js';
import {
  aggregateRawMetricsWindow,
  getPeriodRange,
  itemCompositeKey,
  toUtcDateKey,
  type AnalyticsPeriod,
  type ContentTargetRef,
} from './analytics.helpers.js';

const CANONICAL_TRAFFIC_SOURCES: AnalyticsSource[] = [
  'feed',
  'profile',
  'explore',
  'hashtag',
  'shared',
  'recommendations',
];

const CANONICAL_FOLLOW_SOURCES: FollowSourceType[] = [
  'profile',
  'feed',
  'reel',
  'search',
  'suggestion',
  'other',
];

const DAY_KEYS_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type CompareAgainst = '7d_ago' | '30d_ago' | 'previous_post';

interface OwnedContentSummary {
  ref: ContentTargetRef;
  hashtags: string[];
  duration: number;
  docLikes: number;
  docComments: number;
  docShares: number;
  docSaves: number;
  docViews: number;
}

export interface ContentCurveResponse {
  contentType: AnalyticsContentType;
  contentId: string;
  totalViews?: number;
  curve?: Array<{ percent: number; viewers: number }>;
  avgWatchedPercent?: number;
  avgWatchSeconds?: number;
  completions?: number;
  completionRate?: number;
  tapsForward?: number;
  tapsBack?: number;
  exits?: number;
  timeline?: Array<{ hoursAfter: number; engagements: number }>;
}

export interface TrafficSourceStat {
  source: AnalyticsSource;
  impressions: number;
  engagements: number;
  engagementRate: number;
}

export interface ContentTrafficResponse {
  sources: TrafficSourceStat[];
  totalImpressions: number;
  topSource: AnalyticsSource | null;
}

export interface ComparisonMetricSnapshot {
  contentId: string;
  preview: string;
  createdAt: string;
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagements: number;
  engagementRate: number;
}

export interface CohortComparisonResponse {
  against: CompareAgainst;
  current: ComparisonMetricSnapshot;
  comparison: ComparisonMetricSnapshot | null;
  deltas: {
    impressions: number;
    engagements: number;
    engagementRate: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    views: number;
  } | null;
  verdict: 'better' | 'similar' | 'worse';
}

export interface HashtagPerformanceItem {
  tag: string;
  posts: number;
  impressions: number;
  reach: number;
  avgEngagementRate: number;
  avgLikes: number;
  avgComments: number;
  verdict: 'high' | 'medium' | 'low';
}

export interface ContentSpeedResponse {
  postedAt: string;
  firstEngagementAt: string | null;
  timeToFirstEngagement: number | null;
  firstEngagementType: string | null;
  speedRating: 'viral' | 'fast' | 'average' | 'slow' | 'no_engagement';
  halfEngagementsAt: string | null;
  halfLifeHours: number | null;
}

export interface ContentDecayBucket {
  ageHours: '0-6' | '6-12' | '12-24' | '24-48' | '48-168';
  engagements: number;
  rateVsPeak: number;
}

export interface ContentDecayResponse {
  buckets: ContentDecayBucket[];
  peakBucket: ContentDecayBucket['ageHours'];
  halfLifeHours: number;
}

export interface BestTimeResponse {
  hours: Array<{
    hour: number;
    engagementRate: number;
    sampleSize: number;
    verdict: 'high' | 'medium' | 'low';
  }>;
  top3Hours: number[];
  recommendation: string;
}

export interface AudienceActivityResponse {
  byHour: Array<{ hour: number; activeFollowers: number }>;
  byDayOfWeek: Array<{ day: (typeof DAY_KEYS_MON_FIRST)[number]; activeFollowers: number }>;
  peakWindow: { startHour: number; endHour: number; totalActive: number };
}

export interface AudienceGrowthResponse {
  daily: Array<{ date: string; totalFollowers: number; gained: number; lost: number }>;
  weekly: Array<{ weekStart: string; totalFollowers: number; gained: number; lost: number }>;
  monthly: Array<{ monthStart: string; totalFollowers: number; gained: number; lost: number }>;
  churnRate: number;
  retentionRate: number;
}

export interface AudienceSourcesResponse {
  sources: Array<{ source: FollowSourceType; newFollowers: number }>;
  topSource: FollowSourceType | null;
  trend: Array<{ date: string; source: FollowSourceType; count: number }>;
}

export interface CrossContentCompareResponse {
  items: Array<{
    contentId: string;
    preview: string;
    metrics: Omit<ComparisonMetricSnapshot, 'contentId' | 'preview' | 'createdAt'>;
  }>;
  winner: {
    contentId: string;
    why: 'highest_engagement_rate' | 'most_reach' | 'most_saves';
  } | null;
}

function pctDelta(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function getIsoWeekStart(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMon = (day + 6) % 7;
  const mon = new Date(d.getTime() - diffToMon * 86_400_000);
  return toUtcDateKey(mon);
}

/**
 * Provides Stage V4.5-2 creator insights endpoints:
 * retention curves, traffic attribution, cohort comparison, hashtags,
 * speed/decay analysis, best-time recommendations, and audience insights.
 */
export class AnalyticsInsightsService {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private db(dbOverride?: Db): Db {
    return dbOverride ?? this.customDb ?? getDb();
  }

  private parseObjectId(id: string, code: string, label: string): ObjectId {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      throw new NotFoundError(`${label} not found`, code);
    }
    return new ObjectId(id);
  }

  private async resolveOwnedContent(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<OwnedContentSummary> {
    const oid = this.parseObjectId(contentId, `${contentType}_not_found`, contentType);
    const database = this.db();

    if (contentType === 'post') {
      const post = await getPostsCollection(database).findOne({ _id: oid, deleted: false });
      if (!post) throw new NotFoundError('Post not found', 'post_not_found');
      if (post.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return {
        ref: {
          contentType: 'post',
          contentId,
          authorId: post.authorId,
          preview: (post.body || '').slice(0, 120),
          createdAt: post.createdAt instanceof Date ? post.createdAt : new Date(post.createdAt),
        },
        hashtags: post.hashtags ?? [],
        duration: 0,
        docLikes: post.likeCount ?? 0,
        docComments: post.commentCount ?? 0,
        docShares: post.shareCount ?? 0,
        docSaves: post.saveCount ?? 0,
        docViews: 0,
      };
    }

    if (contentType === 'reel') {
      const reel = await getReelsCollection(database).findOne({ _id: oid, deleted: false });
      if (!reel) throw new NotFoundError('Reel not found', 'reel_not_found');
      if (reel.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return {
        ref: {
          contentType: 'reel',
          contentId,
          authorId: reel.authorId,
          preview: (reel.caption || 'Reel').slice(0, 120),
          createdAt: reel.createdAt instanceof Date ? reel.createdAt : new Date(reel.createdAt),
        },
        hashtags: [],
        duration: Math.max(0, Number(reel.duration) || 0),
        docLikes: reel.likeCount ?? 0,
        docComments: reel.commentCount ?? 0,
        docShares: reel.shareCount ?? 0,
        docSaves: reel.saveCount ?? 0,
        docViews: reel.viewCount ?? 0,
      };
    }

    const story = await getStoriesCollection(database).findOne({ _id: oid });
    if (story) {
      if (story.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return {
        ref: {
          contentType: 'story',
          contentId,
          authorId: story.authorId,
          preview: (story.caption || 'Story').slice(0, 120),
          createdAt: story.createdAt instanceof Date ? story.createdAt : new Date(story.createdAt),
          storyViewers: story.viewers ?? [],
        },
        hashtags: [],
        duration: Math.max(0, Number(story.duration) || 0),
        docLikes: 0,
        docComments: 0,
        docShares: 0,
        docSaves: 0,
        docViews: story.viewerCount ?? story.viewers?.length ?? 0,
      };
    }

    const dailyAny = await getAnalyticsDailyCollection(database).findOne({
      contentType: 'story',
      contentId,
    });
    if (dailyAny) {
      if (dailyAny.authorId !== creatorId) {
        throw new ForbiddenError('Cannot access analytics for another user content', 'forbidden');
      }
      return {
        ref: {
          contentType: 'story',
          contentId,
          authorId: dailyAny.authorId,
          preview: dailyAny.preview || 'Story',
          createdAt:
            dailyAny.contentCreatedAt instanceof Date
              ? dailyAny.contentCreatedAt
              : new Date(dailyAny.contentCreatedAt ?? `${dailyAny.date}T00:00:00.000Z`),
        },
        hashtags: [],
        duration: 0,
        docLikes: 0,
        docComments: 0,
        docShares: 0,
        docSaves: 0,
        docViews: 0,
      };
    }

    throw new NotFoundError('Story not found', 'story_not_found');
  }

  private async computeLifetimeSnapshot(
    item: OwnedContentSummary
  ): Promise<ComparisonMetricSnapshot> {
    const database = this.db();
    const start = new Date(0);
    const end = new Date(Date.now() + 60_000);
    const key = itemCompositeKey(item.ref.contentType, item.ref.contentId);

    const [{ totalsByItem }, dailyDocs] = await Promise.all([
      aggregateRawMetricsWindow(database, [item.ref], start, end),
      getAnalyticsDailyCollection(database)
        .find({ contentType: item.ref.contentType, contentId: item.ref.contentId })
        .toArray(),
    ]);

    const raw = totalsByItem.get(key);
    let impressions = raw?.impressions ?? 0;
    let reach = raw?.reach ?? 0;
    let views = Math.max(raw?.views ?? 0, item.docViews);
    let likes = Math.max(raw?.likes ?? 0, item.docLikes);
    let comments = Math.max(raw?.comments ?? 0, item.docComments);
    let shares = Math.max(raw?.shares ?? 0, item.docShares);
    let saves = Math.max(raw?.saves ?? 0, item.docSaves);

    if (dailyDocs.length > 0) {
      let rolledImpr = 0;
      let rolledReach = 0;
      let rolledViews = 0;
      let rolledLikes = 0;
      let rolledComments = 0;
      let rolledShares = 0;
      let rolledSaves = 0;
      for (const d of dailyDocs) {
        rolledImpr += d.impressions ?? 0;
        rolledReach += d.reach ?? 0;
        rolledViews += d.views ?? 0;
        rolledLikes += d.likes ?? 0;
        rolledComments += d.comments ?? 0;
        rolledShares += d.shares ?? 0;
        rolledSaves += d.saves ?? 0;
      }
      impressions = Math.max(impressions, rolledImpr);
      reach = Math.max(reach, rolledReach);
      views = Math.max(views, rolledViews);
      likes = Math.max(likes, rolledLikes);
      comments = Math.max(comments, rolledComments);
      shares = Math.max(shares, rolledShares);
      saves = Math.max(saves, rolledSaves);
    }

    const engagements = likes + comments + shares + saves;
    const denominator = impressions > 0 ? impressions : views;
    const engagementRate =
      denominator > 0 ? Number((engagements / denominator).toFixed(4)) : 0;

    return {
      contentId: item.ref.contentId,
      preview: item.ref.preview,
      createdAt: item.ref.createdAt.toISOString(),
      impressions,
      reach,
      views,
      likes,
      comments,
      shares,
      saves,
      engagements,
      engagementRate,
    };
  }

  /**
   * 1. Retention / completion curves (reels/stories) or 7-day hourly engagement timeline (posts).
   */
  async getContentCurve(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<ContentCurveResponse> {
    const owned = await this.resolveOwnedContent(creatorId, contentType, contentId);
    const database = this.db();

    if (contentType === 'post') {
      const startMs = owned.ref.createdAt.getTime();
      const endDate = new Date(startMs + 169 * 3_600_000);
      const events = await getEngagementEventsCollection(database)
        .find({
          contentType: 'post',
          contentId,
          at: { $gte: new Date(startMs - 60_000), $lt: endDate },
        })
        .toArray();

      const counts = new Array(169).fill(0);
      for (const ev of events) {
        const ms = (ev.at instanceof Date ? ev.at : new Date(ev.at)).getTime();
        const rawHours = Math.floor((ms - startMs) / 3_600_000);
        const h = rawHours === -1 ? 0 : rawHours;
        if (h >= 0 && h <= 168) {
          counts[h]++;
        }
      }

      return {
        contentType: 'post',
        contentId,
        timeline: counts.map((engagements, hoursAfter) => ({ hoursAfter, engagements })),
      };
    }

    const viewDocs = await getContentViewsCollection(database)
      .find({ contentType, contentId })
      .toArray();

    const totalViews = viewDocs.length;
    const percents: number[] = [];
    let sumWatchedSeconds = 0;
    let completions = 0;
    let tapsForward = 0;
    let tapsBack = 0;
    let exits = 0;

    for (const v of viewDocs) {
      const watched = Math.max(0, Number(v.watchedSeconds) || 0);
      const totalSec =
        v.totalSeconds && v.totalSeconds > 0
          ? Number(v.totalSeconds)
          : owned.duration > 0
            ? owned.duration
            : 0;
      sumWatchedSeconds += watched;
      tapsForward += Math.max(0, Number(v.tapsForward) || 0);
      tapsBack += Math.max(0, Number(v.tapsBack) || 0);
      if (v.exited) exits++;

      let pct = totalSec > 0 ? Math.min(100, Math.max(0, (watched / totalSec) * 100)) : 0;
      if (v.completed) {
        pct = 100;
      }
      if (pct >= 100 || v.completed) {
        completions++;
      }
      percents.push(pct);
    }

    const thresholds = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const curve = thresholds.map((percent) => {
      const viewers = percents.filter((pct) => pct >= percent).length;
      return { percent, viewers };
    });

    const sumPct = percents.reduce((acc, p) => acc + p, 0);
    const avgWatchedPercent = totalViews > 0 ? Number((sumPct / totalViews).toFixed(1)) : 0;
    const avgWatchSeconds = totalViews > 0 ? Number((sumWatchedSeconds / totalViews).toFixed(2)) : 0;
    const completionRate = totalViews > 0 ? Number((completions / totalViews).toFixed(4)) : 0;

    return {
      contentType,
      contentId,
      totalViews,
      curve,
      avgWatchedPercent,
      avgWatchSeconds,
      completions,
      completionRate,
      ...(contentType === 'story' ? { tapsForward, tapsBack, exits } : {}),
    };
  }

  /**
   * 2. Traffic source attribution: aggregates impressions and engagements by discovery source.
   */
  async getContentTraffic(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<ContentTrafficResponse> {
    await this.resolveOwnedContent(creatorId, contentType, contentId);
    const database = this.db();

    const [impressionDocs, viewDocs, engagementDocs] = await Promise.all([
      getImpressionsCollection(database)
        .find({ contentType, contentId })
        .sort({ seenAt: -1 })
        .toArray(),
      contentType !== 'post'
        ? getContentViewsCollection(database).find({ contentType, contentId }).toArray()
        : Promise.resolve([]),
      getEngagementEventsCollection(database).find({ contentType, contentId }).toArray(),
    ]);

    const impressionCounts = new Map<AnalyticsSource, number>();
    const engagementCounts = new Map<AnalyticsSource, number>();
    for (const s of CANONICAL_TRAFFIC_SOURCES) {
      impressionCounts.set(s, 0);
      engagementCounts.set(s, 0);
    }

    const userSourceMap = new Map<string, AnalyticsSource>();
    for (const imp of impressionDocs) {
      const src = (CANONICAL_TRAFFIC_SOURCES.includes(imp.source)
        ? imp.source
        : 'feed') as AnalyticsSource;
      impressionCounts.set(src, (impressionCounts.get(src) ?? 0) + 1);
      if (!userSourceMap.has(imp.userId)) {
        userSourceMap.set(imp.userId, src);
      }
    }

    for (const v of viewDocs) {
      if (!userSourceMap.has(v.userId) && v.source) {
        const normalized = v.source.trim().toLowerCase() as AnalyticsSource;
        if (CANONICAL_TRAFFIC_SOURCES.includes(normalized)) {
          userSourceMap.set(v.userId, normalized);
        }
      }
    }

    for (const ev of engagementDocs) {
      const src = userSourceMap.get(ev.userId);
      if (src) {
        engagementCounts.set(src, (engagementCounts.get(src) ?? 0) + 1);
      }
    }

    const totalImpressions = impressionDocs.length;
    const sources: TrafficSourceStat[] = CANONICAL_TRAFFIC_SOURCES.map((source) => {
      const impr = impressionCounts.get(source) ?? 0;
      const eng = engagementCounts.get(source) ?? 0;
      return {
        source,
        impressions: impr,
        engagements: eng,
        engagementRate: impr > 0 ? Number((eng / impr).toFixed(4)) : 0,
      };
    }).sort((a, b) => b.impressions - a.impressions || b.engagements - a.engagements);

    const topEntry = sources[0];
    const topSource = topEntry && topEntry.impressions > 0 ? topEntry.source : null;

    return {
      sources,
      totalImpressions,
      topSource,
    };
  }

  /**
   * 3. Cohort comparison against previous post or content closest to 7d / 30d prior.
   */
  async getCohortComparison(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string,
    against: CompareAgainst = 'previous_post'
  ): Promise<CohortComparisonResponse> {
    const owned = await this.resolveOwnedContent(creatorId, contentType, contentId);
    const database = this.db();
    const currentOid = new ObjectId(contentId);
    const currentCreatedAt = owned.ref.createdAt;

    // Fetch creator's prior content of the same type
    const priorFilter = {
      authorId: creatorId,
      ...(contentType !== 'story' ? { deleted: false } : {}),
      $or: [
        { createdAt: { $lt: currentCreatedAt } },
        { createdAt: currentCreatedAt, _id: { $lt: currentOid } },
      ],
    };

    let candidateDoc: any = null;
    if (against === 'previous_post') {
      if (contentType === 'post') {
        candidateDoc = await getPostsCollection(database)
          .find(priorFilter as any)
          .sort({ createdAt: -1, _id: -1 })
          .limit(1)
          .next();
      } else if (contentType === 'reel') {
        candidateDoc = await getReelsCollection(database)
          .find(priorFilter as any)
          .sort({ createdAt: -1, _id: -1 })
          .limit(1)
          .next();
      } else {
        candidateDoc = await getStoriesCollection(database)
          .find(priorFilter as any)
          .sort({ createdAt: -1, _id: -1 })
          .limit(1)
          .next();
      }
    } else {
      const targetDays = against === '30d_ago' ? 30 : 7;
      const targetMs = currentCreatedAt.getTime() - targetDays * 86_400_000;
      let allPriors: any[] = [];
      if (contentType === 'post') {
        allPriors = await getPostsCollection(database)
          .find(priorFilter as any)
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();
      } else if (contentType === 'reel') {
        allPriors = await getReelsCollection(database)
          .find(priorFilter as any)
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();
      } else {
        allPriors = await getStoriesCollection(database)
          .find(priorFilter as any)
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();
      }
      if (allPriors.length > 0) {
        candidateDoc = allPriors.reduce((best, doc) => {
          const docMs = (doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt)).getTime();
          const bestMs = (best.createdAt instanceof Date ? best.createdAt : new Date(best.createdAt)).getTime();
          return Math.abs(docMs - targetMs) < Math.abs(bestMs - targetMs) ? doc : best;
        });
      }
    }

    const currentSnapshot = await this.computeLifetimeSnapshot(owned);
    if (!candidateDoc) {
      return {
        against,
        current: currentSnapshot,
        comparison: null,
        deltas: null,
        verdict: 'similar',
      };
    }

    const comparisonOwned = await this.resolveOwnedContent(
      creatorId,
      contentType,
      candidateDoc._id.toString()
    );
    const comparisonSnapshot = await this.computeLifetimeSnapshot(comparisonOwned);

    const deltas = {
      impressions: pctDelta(currentSnapshot.impressions, comparisonSnapshot.impressions),
      engagements: pctDelta(currentSnapshot.engagements, comparisonSnapshot.engagements),
      engagementRate: pctDelta(currentSnapshot.engagementRate, comparisonSnapshot.engagementRate),
      likes: pctDelta(currentSnapshot.likes, comparisonSnapshot.likes),
      comments: pctDelta(currentSnapshot.comments, comparisonSnapshot.comments),
      shares: pctDelta(currentSnapshot.shares, comparisonSnapshot.shares),
      saves: pctDelta(currentSnapshot.saves, comparisonSnapshot.saves),
      views: pctDelta(currentSnapshot.views, comparisonSnapshot.views),
    };

    const primaryDelta =
      currentSnapshot.engagementRate > 0 || comparisonSnapshot.engagementRate > 0
        ? deltas.engagementRate
        : currentSnapshot.engagements > 0 || comparisonSnapshot.engagements > 0
          ? deltas.engagements
          : deltas.impressions;

    const verdict: CohortComparisonResponse['verdict'] =
      primaryDelta > 10 ? 'better' : primaryDelta < -10 ? 'worse' : 'similar';

    return {
      against,
      current: currentSnapshot,
      comparison: comparisonSnapshot,
      deltas,
      verdict,
    };
  }

  /**
   * 4. Hashtag performance aggregation relative to creator's baseline across their posts.
   */
  async getHashtagAnalytics(
    creatorId: string,
    period: AnalyticsPeriod = '30d',
    limit: number = 20
  ): Promise<{ hashtags: HashtagPerformanceItem[] }> {
    const range = getPeriodRange(period);
    const database = this.db();

    const posts = await getPostsCollection(database)
      .find({
        authorId: creatorId,
        deleted: false,
        createdAt: { $gte: range.start, $lt: range.end },
      })
      .sort({ createdAt: -1 })
      .toArray();

    if (posts.length === 0) {
      return { hashtags: [] };
    }

    const refs: ContentTargetRef[] = posts.map((p) => ({
      contentType: 'post',
      contentId: p._id.toString(),
      authorId: p.authorId,
      preview: (p.body || '').slice(0, 120),
      createdAt: p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt),
    }));

    const { totalsByItem } = await aggregateRawMetricsWindow(
      database,
      refs,
      range.start,
      new Date(Date.now() + 60_000)
    );

    const postIds = refs.map((r) => r.contentId);
    const dailyDocs = await getAnalyticsDailyCollection(database)
      .find({ contentType: 'post', contentId: { $in: postIds } })
      .toArray();
    const rolledByPost = new Map<string, { impressions: number; reach: number }>();
    for (const d of dailyDocs) {
      const prev = rolledByPost.get(d.contentId) ?? { impressions: 0, reach: 0 };
      prev.impressions += d.impressions ?? 0;
      prev.reach += d.reach ?? 0;
      rolledByPost.set(d.contentId, prev);
    }

    let baselineImpressions = 0;
    let baselineEngagements = 0;

    const tagAgg = new Map<
      string,
      {
        posts: number;
        impressions: number;
        reach: number;
        likes: number;
        comments: number;
        engagements: number;
      }
    >();

    for (const p of posts) {
      const pid = p._id.toString();
      const raw = totalsByItem.get(itemCompositeKey('post', pid));
      const rolled = rolledByPost.get(pid);
      const impressions = Math.max(raw?.impressions ?? 0, rolled?.impressions ?? 0);
      const reach = Math.max(raw?.reach ?? 0, rolled?.reach ?? 0);
      const likes = Math.max(raw?.likes ?? 0, p.likeCount ?? 0);
      const comments = Math.max(raw?.comments ?? 0, p.commentCount ?? 0);
      const shares = Math.max(raw?.shares ?? 0, p.shareCount ?? 0);
      const saves = Math.max(raw?.saves ?? 0, p.saveCount ?? 0);
      const engagements = likes + comments + shares + saves;

      baselineImpressions += impressions;
      baselineEngagements += engagements;

      const tags = Array.from(
        new Set(
          (p.hashtags ?? [])
            .map((t) => t.trim().replace(/^#/, '').toLowerCase())
            .filter(Boolean)
        )
      );
      for (const tag of tags) {
        const entry = tagAgg.get(tag) ?? {
          posts: 0,
          impressions: 0,
          reach: 0,
          likes: 0,
          comments: 0,
          engagements: 0,
        };
        entry.posts += 1;
        entry.impressions += impressions;
        entry.reach += reach;
        entry.likes += likes;
        entry.comments += comments;
        entry.engagements += engagements;
        tagAgg.set(tag, entry);
      }
    }

    const baselineRate = baselineImpressions > 0 ? baselineEngagements / baselineImpressions : 0;

    const hashtags: HashtagPerformanceItem[] = Array.from(tagAgg.entries())
      .map(([tag, entry]) => {
        const avgEngagementRate =
          entry.impressions > 0 ? Number((entry.engagements / entry.impressions).toFixed(4)) : 0;
        let verdict: HashtagPerformanceItem['verdict'] = 'medium';
        if (baselineRate === 0) {
          verdict = avgEngagementRate > 0 ? 'high' : 'medium';
        } else if (avgEngagementRate >= baselineRate * 1.15) {
          verdict = 'high';
        } else if (avgEngagementRate <= baselineRate * 0.85) {
          verdict = 'low';
        }

        return {
          tag,
          posts: entry.posts,
          impressions: entry.impressions,
          reach: entry.reach,
          avgEngagementRate,
          avgLikes: Number((entry.likes / entry.posts).toFixed(2)),
          avgComments: Number((entry.comments / entry.posts).toFixed(2)),
          verdict,
        };
      })
      .sort(
        (a, b) =>
          b.impressions - a.impressions ||
          b.avgEngagementRate - a.avgEngagementRate ||
          a.tag.localeCompare(b.tag)
      )
      .slice(0, limit);

    return { hashtags };
  }

  /**
   * 5. Time-to-first-engagement & 50% engagement velocity speed rating.
   */
  async getContentSpeed(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<ContentSpeedResponse> {
    const owned = await this.resolveOwnedContent(creatorId, contentType, contentId);
    const postedAt = owned.ref.createdAt;
    const events = await getEngagementEventsCollection(this.db())
      .find({ contentType, contentId })
      .sort({ at: 1 })
      .toArray();

    if (events.length === 0) {
      return {
        postedAt: postedAt.toISOString(),
        firstEngagementAt: null,
        timeToFirstEngagement: null,
        firstEngagementType: null,
        speedRating: 'no_engagement',
        halfEngagementsAt: null,
        halfLifeHours: null,
      };
    }

    const first = events[0];
    const firstAt = first.at instanceof Date ? first.at : new Date(first.at);
    const secondsToFirst = Math.max(
      0,
      Math.round((firstAt.getTime() - postedAt.getTime()) / 1000)
    );

    let speedRating: ContentSpeedResponse['speedRating'];
    if (secondsToFirst < 300) speedRating = 'viral';
    else if (secondsToFirst < 1800) speedRating = 'fast';
    else if (secondsToFirst < 21600) speedRating = 'average';
    else speedRating = 'slow';

    const halfIndex = Math.max(0, Math.ceil(events.length / 2) - 1);
    const halfEvent = events[halfIndex];
    const halfAt = halfEvent.at instanceof Date ? halfEvent.at : new Date(halfEvent.at);
    const halfLifeHours = Number(
      (Math.max(0, halfAt.getTime() - postedAt.getTime()) / 3_600_000).toFixed(2)
    );

    return {
      postedAt: postedAt.toISOString(),
      firstEngagementAt: firstAt.toISOString(),
      timeToFirstEngagement: secondsToFirst,
      firstEngagementType: first.event,
      speedRating,
      halfEngagementsAt: halfAt.toISOString(),
      halfLifeHours,
    };
  }

  /**
   * 6. Content decay curve across age buckets (0-6h through 48-168h) & half-life from peak.
   */
  async getContentDecay(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentId: string
  ): Promise<ContentDecayResponse> {
    const owned = await this.resolveOwnedContent(creatorId, contentType, contentId);
    const postedMs = owned.ref.createdAt.getTime();
    const events = await getEngagementEventsCollection(this.db())
      .find({ contentType, contentId })
      .sort({ at: 1 })
      .toArray();

    const defs: Array<{
      label: ContentDecayBucket['ageHours'];
      min: number;
      max: number;
      mid: number;
      count: number;
    }> = [
      { label: '0-6', min: 0, max: 6, mid: 3, count: 0 },
      { label: '6-12', min: 6, max: 12, mid: 9, count: 0 },
      { label: '12-24', min: 12, max: 24, mid: 18, count: 0 },
      { label: '24-48', min: 24, max: 48, mid: 36, count: 0 },
      { label: '48-168', min: 48, max: 168, mid: 108, count: 0 },
    ];

    for (const ev of events) {
      const evMs = (ev.at instanceof Date ? ev.at : new Date(ev.at)).getTime();
      const ageH = Math.max(0, (evMs - postedMs) / 3_600_000);
      for (let i = 0; i < defs.length; i++) {
        const b = defs[i];
        const inUpper = i === defs.length - 1 ? ageH <= b.max : ageH < b.max;
        if (ageH >= b.min && inUpper) {
          b.count++;
          break;
        }
      }
    }

    let peakIdx = 0;
    for (let i = 1; i < defs.length; i++) {
      if (defs[i].count > defs[peakIdx].count) {
        peakIdx = i;
      }
    }
    const peakCount = defs[peakIdx].count;

    const buckets: ContentDecayBucket[] = defs.map((d) => ({
      ageHours: d.label,
      engagements: d.count,
      rateVsPeak: peakCount > 0 ? Number((d.count / peakCount).toFixed(4)) : 0,
    }));

    let halfLifeHours = 0;
    if (peakCount > 0) {
      const peakMid = defs[peakIdx].mid;
      const decayIdx = buckets.findIndex((b, idx) => idx > peakIdx && b.rateVsPeak <= 0.5);
      if (decayIdx !== -1) {
        const prevRatio = buckets[decayIdx - 1].rateVsPeak;
        const currRatio = buckets[decayIdx].rateVsPeak;
        const prevMid = defs[decayIdx - 1].mid;
        const currMid = defs[decayIdx].mid;
        let crossMid = currMid;
        if (prevRatio > currRatio) {
          const frac = (prevRatio - 0.5) / (prevRatio - currRatio);
          crossMid = prevMid + Math.max(0, Math.min(1, frac)) * (currMid - prevMid);
        }
        halfLifeHours = Number(Math.max(0, crossMid - peakMid).toFixed(2));
      } else {
        halfLifeHours = Number((defs[defs.length - 1].max - defs[peakIdx].min).toFixed(2));
      }
    }

    return {
      buckets,
      peakBucket: defs[peakIdx].label,
      halfLifeHours,
    };
  }

  /**
   * 7. Content-type-aware best time to post recommendations across 24 UTC hours.
   */
  async getBestTime(
    creatorId: string,
    contentType?: AnalyticsContentType,
    period: AnalyticsPeriod = '30d'
  ): Promise<BestTimeResponse> {
    const range = getPeriodRange(period);
    const database = this.db();

    const [posts, reels, stories] = await Promise.all([
      !contentType || contentType === 'post'
        ? getPostsCollection(database)
            .find({ authorId: creatorId, deleted: false, createdAt: { $gte: range.start, $lt: range.end } })
            .toArray()
        : Promise.resolve([]),
      !contentType || contentType === 'reel'
        ? getReelsCollection(database)
            .find({ authorId: creatorId, deleted: false, createdAt: { $gte: range.start, $lt: range.end } })
            .toArray()
        : Promise.resolve([]),
      !contentType || contentType === 'story'
        ? getStoriesCollection(database)
            .find({ authorId: creatorId, createdAt: { $gte: range.start, $lt: range.end } })
            .toArray()
        : Promise.resolve([]),
    ]);

    const targets: ContentTargetRef[] = [];
    const docStats = new Map<string, { eng: number; views: number; createdAt: Date }>();

    for (const p of posts) {
      const cid = p._id.toString();
      const createdAt = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
      targets.push({ contentType: 'post', contentId: cid, authorId: creatorId, preview: '', createdAt });
      docStats.set(itemCompositeKey('post', cid), {
        eng: (p.likeCount ?? 0) + (p.commentCount ?? 0) + (p.shareCount ?? 0) + (p.saveCount ?? 0),
        views: 0,
        createdAt,
      });
    }
    for (const r of reels) {
      const cid = r._id.toString();
      const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
      targets.push({ contentType: 'reel', contentId: cid, authorId: creatorId, preview: '', createdAt });
      docStats.set(itemCompositeKey('reel', cid), {
        eng: (r.likeCount ?? 0) + (r.commentCount ?? 0) + (r.shareCount ?? 0) + (r.saveCount ?? 0),
        views: r.viewCount ?? 0,
        createdAt,
      });
    }
    for (const s of stories) {
      const cid = s._id.toString();
      const createdAt = s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt);
      targets.push({
        contentType: 'story',
        contentId: cid,
        authorId: creatorId,
        preview: '',
        createdAt,
        storyViewers: s.viewers ?? [],
      });
      docStats.set(itemCompositeKey('story', cid), {
        eng: 0,
        views: s.viewerCount ?? s.viewers?.length ?? 0,
        createdAt,
      });
    }

    const { totalsByItem } = await aggregateRawMetricsWindow(
      database,
      targets,
      range.start,
      new Date(Date.now() + 60_000)
    );

    const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      sampleSize: 0,
      impressions: 0,
      views: 0,
      engagements: 0,
    }));
    const dayTotals = new Array(7).fill(0);

    for (const t of targets) {
      const k = itemCompositeKey(t.contentType, t.contentId);
      const m = totalsByItem.get(k);
      const ds = docStats.get(k)!;
      const eng =
        Math.max(m?.likes ?? 0, 0) +
        Math.max(m?.comments ?? 0, 0) +
        Math.max(m?.shares ?? 0, 0) +
        Math.max(m?.saves ?? 0, 0) +
        (t.contentType === 'story' ? m?.replies ?? 0 : 0);
      const finalEng = Math.max(eng, ds.eng);
      const impr = m?.impressions ?? 0;
      const views = Math.max(m?.views ?? 0, ds.views);

      const h = t.createdAt.getUTCHours();
      const d = t.createdAt.getUTCDay();
      hourBuckets[h].sampleSize += 1;
      hourBuckets[h].impressions += impr;
      hourBuckets[h].views += views;
      hourBuckets[h].engagements += finalEng;
      dayTotals[d] += finalEng;
    }

    const rates = hourBuckets.map((b) => {
      const denom = b.impressions > 0 ? b.impressions : b.views;
      const engagementRate = denom > 0 ? Number((b.engagements / denom).toFixed(4)) : 0;
      return {
        hour: b.hour,
        engagementRate,
        sampleSize: b.sampleSize,
        engagements: b.engagements,
      };
    });

    const nonZeroRates = rates.filter((r) => r.sampleSize > 0).map((r) => r.engagementRate);
    const avgRate =
      nonZeroRates.length > 0
        ? nonZeroRates.reduce((acc, r) => acc + r, 0) / nonZeroRates.length
        : 0;

    const hours: BestTimeResponse['hours'] = rates.map((r) => {
      let verdict: 'high' | 'medium' | 'low' = 'low';
      if (r.sampleSize > 0) {
        if (avgRate === 0) {
          verdict = r.engagements > 0 ? 'high' : 'medium';
        } else if (r.engagementRate >= avgRate * 1.15) {
          verdict = 'high';
        } else if (r.engagementRate >= avgRate * 0.85) {
          verdict = 'medium';
        }
      }
      return {
        hour: r.hour,
        engagementRate: r.engagementRate,
        sampleSize: r.sampleSize,
        verdict,
      };
    });

    const top3Hours = [...rates]
      .sort(
        (a, b) =>
          b.engagementRate - a.engagementRate ||
          b.engagements - a.engagements ||
          b.sampleSize - a.sampleSize ||
          a.hour - b.hour
      )
      .slice(0, 3)
      .map((r) => r.hour);

    const bestDays = dayTotals
      .map((score, idx) => ({ score, name: DAY_LABELS[idx] }))
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((d) => d.name);

    const typeLabel =
      contentType === 'post' ? 'posts' : contentType === 'reel' ? 'reels' : contentType === 'story' ? 'stories' : 'content';
    const recommendation =
      targets.length === 0 || (rates.every((r) => r.engagements === 0 && r.engagementRate === 0))
        ? `Publish more ${typeLabel} across varied hours to build timing recommendations.`
        : `Your ${typeLabel} perform best${bestDays.length > 0 ? ` on ${bestDays.join('/')}` : ''} around ${String(top3Hours[0]).padStart(2, '0')}:00 UTC.`;

    return { hours, top3Hours, recommendation };
  }

  /**
   * 8a. Follower activity patterns derived from followers' engagement_events (and views) over 30d.
   */
  async getAudienceActivity(
    creatorId: string,
    period: AnalyticsPeriod = '30d'
  ): Promise<AudienceActivityResponse> {
    const range = getPeriodRange(period);
    const database = this.db();

    const [followers, blockedIds] = await Promise.all([
      getFollowsCollection(database)
        .find({ followingId: creatorId }, { projection: { followerId: 1 } })
        .toArray(),
      getBlockedUserIds(creatorId, undefined, database),
    ]);

    const followerIds = followers
      .map((f) => f.followerId)
      .filter((id) => !blockedIds.has(id));

    const hourSets: Set<string>[] = Array.from({ length: 24 }, () => new Set<string>());
    const dowSets: Set<string>[] = Array.from({ length: 7 }, () => new Set<string>());

    if (followerIds.length > 0) {
      const [events, views] = await Promise.all([
        getEngagementEventsCollection(database)
          .find(
            { userId: { $in: followerIds }, at: { $gte: range.start, $lt: range.end } },
            { projection: { userId: 1, at: 1 } }
          )
          .toArray(),
        getContentViewsCollection(database)
          .find(
            { userId: { $in: followerIds }, startedAt: { $gte: range.start, $lt: range.end } },
            { projection: { userId: 1, startedAt: 1 } }
          )
          .toArray(),
      ]);

      const recordDate = (userId: string, dateVal: Date | string) => {
        const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
        const h = d.getUTCHours();
        const monIdx = (d.getUTCDay() + 6) % 7; // 0=mon..6=sun
        hourSets[h].add(userId);
        dowSets[monIdx].add(userId);
      };

      for (const ev of events) recordDate(ev.userId, ev.at);
      for (const v of views) recordDate(v.userId, v.startedAt);
    }

    const byHour = hourSets.map((set, hour) => ({ hour, activeFollowers: set.size }));
    const byDayOfWeek = DAY_KEYS_MON_FIRST.map((day, idx) => ({
      day,
      activeFollowers: dowSets[idx].size,
    }));

    // Find best 2-hour contiguous window
    let bestStart = 0;
    let bestUnionSize = -1;
    for (let h = 0; h < 24; h++) {
      const nextH = (h + 1) % 24;
      const union = new Set<string>([...hourSets[h], ...hourSets[nextH]]);
      if (union.size > bestUnionSize) {
        bestUnionSize = union.size;
        bestStart = h;
      }
    }

    return {
      byHour,
      byDayOfWeek,
      peakWindow: {
        startHour: bestStart,
        endHour: (bestStart + 2) % 24,
        totalActive: Math.max(0, bestUnionSize),
      },
    };
  }

  /**
   * 8b. Audience growth (daily/weekly/monthly) + churnRate + 30-day retentionRate.
   */
  async getAudienceGrowth(
    creatorId: string,
    period: AnalyticsPeriod = '30d'
  ): Promise<AudienceGrowthResponse> {
    const range = getPeriodRange(period);
    const database = this.db();

    const [profile, activeFollows, followSources, unfollows, creatorDailyDocs] = await Promise.all([
      getProfilesCollection(database).findOne({ userId: creatorId }),
      getFollowsCollection(database).find({ followingId: creatorId }).toArray(),
      getFollowSourcesCollection(database).find({ followingId: creatorId }).toArray(),
      getUnfollowEventsCollection(database).find({ followingId: creatorId }).toArray(),
      getCreatorDailyStatsCollection(database)
        .find({ userId: creatorId, date: { $in: range.dateKeys } })
        .toArray(),
    ]);

    const currentTotal = Math.max(profile?.followerCount ?? 0, activeFollows.length);
    const activeFollowerSet = new Set(activeFollows.map((f) => f.followerId));

    // Track per-day gains (deduped per followerId:date) and per-day unfollow losses
    const gainedByDayUsers = new Map<string, Set<string>>();
    const allGainedCohort = new Map<string, Date>();

    for (const f of activeFollows) {
      const d = f.createdAt instanceof Date ? f.createdAt : new Date(f.createdAt);
      const dk = toUtcDateKey(d);
      if (!gainedByDayUsers.has(dk)) gainedByDayUsers.set(dk, new Set());
      gainedByDayUsers.get(dk)!.add(f.followerId);
      allGainedCohort.set(f.followerId, d);
    }

    for (const fs of followSources) {
      const d = fs.at instanceof Date ? fs.at : new Date(fs.at);
      const dk = toUtcDateKey(d);
      if (!gainedByDayUsers.has(dk)) gainedByDayUsers.set(dk, new Set());
      gainedByDayUsers.get(dk)!.add(fs.followerId);
      if (!allGainedCohort.has(fs.followerId)) {
        allGainedCohort.set(fs.followerId, d);
      }
    }

    const lostByDay = new Map<string, number>();
    const unfollowedAfterMap = new Map<string, Date[]>();
    for (const uf of unfollows) {
      const d = uf.at instanceof Date ? uf.at : new Date(uf.at);
      const dk = toUtcDateKey(d);
      lostByDay.set(dk, (lostByDay.get(dk) ?? 0) + 1);
      const arr = unfollowedAfterMap.get(uf.followerId) ?? [];
      arr.push(d);
      unfollowedAfterMap.set(uf.followerId, arr);
    }

    const rolledMap = new Map(creatorDailyDocs.map((c) => [c.date, c.followersGained ?? 0]));

    const rawDaily = range.dateKeys.map((date) => {
      const rawGained = gainedByDayUsers.get(date)?.size ?? 0;
      const rolled = rolledMap.get(date) ?? 0;
      const gained = date !== range.todayKey ? Math.max(rawGained, rolled) : rawGained;
      const lost = lostByDay.get(date) ?? 0;
      return { date, gained, lost };
    });

    // Reconstruct running total backwards from today's total
    const dailyTotals = new Array<number>(rawDaily.length).fill(0);
    let running = currentTotal;
    for (let i = rawDaily.length - 1; i >= 0; i--) {
      dailyTotals[i] = Math.max(0, running);
      running = Math.max(0, running - rawDaily[i].gained + rawDaily[i].lost);
    }

    const daily = rawDaily.map((d, idx) => ({
      date: d.date,
      totalFollowers: dailyTotals[idx],
      gained: d.gained,
      lost: d.lost,
    }));

    const weeklyMap = new Map<
      string,
      { weekStart: string; totalFollowers: number; gained: number; lost: number }
    >();
    const monthlyMap = new Map<
      string,
      { monthStart: string; totalFollowers: number; gained: number; lost: number }
    >();

    for (const pt of daily) {
      const weekStart = getIsoWeekStart(pt.date);
      const wk = weeklyMap.get(weekStart) ?? { weekStart, totalFollowers: 0, gained: 0, lost: 0 };
      wk.gained += pt.gained;
      wk.lost += pt.lost;
      wk.totalFollowers = pt.totalFollowers;
      weeklyMap.set(weekStart, wk);

      const monthStart = `${pt.date.slice(0, 7)}-01`;
      const mo = monthlyMap.get(monthStart) ?? { monthStart, totalFollowers: 0, gained: 0, lost: 0 };
      mo.gained += pt.gained;
      mo.lost += pt.lost;
      mo.totalFollowers = pt.totalFollowers;
      monthlyMap.set(monthStart, mo);
    }

    const weekly = Array.from(weeklyMap.values());
    const monthly = Array.from(monthlyMap.values());

    const totalLostInPeriod = daily.reduce((s, d) => s + d.lost, 0);
    const weeksInPeriod = Math.max(1, range.days / 7);
    const avgWeeklyLost = totalLostInPeriod / weeksInPeriod;
    const avgFollowers =
      daily.length > 0
        ? Math.max(1, daily.reduce((s, d) => s + d.totalFollowers, 0) / daily.length)
        : currentTotal;
    const churnRate =
      currentTotal > 0 || totalLostInPeriod > 0
        ? Number((avgWeeklyLost / Math.max(1, avgFollowers)).toFixed(4))
        : 0;

    // 30-day cohort retention rate: followers acquired >= 30 days ago who stayed
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    let cohortTotal = 0;
    let cohortRetained = 0;
    for (const [fid, gainedAt] of allGainedCohort.entries()) {
      if (gainedAt <= thirtyDaysAgo) {
        cohortTotal++;
        const unfollowDates = unfollowedAfterMap.get(fid) ?? [];
        const leftWithin30d = unfollowDates.some(
          (ud) => ud.getTime() >= gainedAt.getTime() && ud.getTime() <= gainedAt.getTime() + 30 * 86_400_000
        );
        if (!leftWithin30d && (activeFollowerSet.has(fid) || unfollowDates.length === 0)) {
          cohortRetained++;
        }
      }
    }

    let retentionRate = 0;
    if (cohortTotal > 0) {
      retentionRate = Number((cohortRetained / cohortTotal).toFixed(4));
    } else {
      const totalGained = allGainedCohort.size;
      if (totalGained > 0) {
        retentionRate = Number((Math.max(0, totalGained - unfollows.length) / totalGained).toFixed(4));
      }
    }

    return {
      daily,
      weekly,
      monthly,
      churnRate,
      retentionRate,
    };
  }

  /**
   * 9. Follower growth attribution breakdown and daily stacked trend via follow_sources.
   */
  async getAudienceSources(
    creatorId: string,
    period: AnalyticsPeriod = '30d'
  ): Promise<AudienceSourcesResponse> {
    const range = getPeriodRange(period);
    const database = this.db();

    const docs = await getFollowSourcesCollection(database)
      .find({ followingId: creatorId, at: { $gte: range.start, $lt: range.end } })
      .toArray();

    const totals = new Map<FollowSourceType, number>();
    for (const s of CANONICAL_FOLLOW_SOURCES) totals.set(s, 0);

    const trendMap = new Map<string, { date: string; source: FollowSourceType; count: number }>();

    for (const doc of docs) {
      const src = CANONICAL_FOLLOW_SOURCES.includes(doc.source) ? doc.source : 'other';
      totals.set(src, (totals.get(src) ?? 0) + 1);
      const dk = toUtcDateKey(doc.at instanceof Date ? doc.at : new Date(doc.at));
      const tk = `${dk}:${src}`;
      const existing = trendMap.get(tk);
      if (existing) {
        existing.count += 1;
      } else {
        trendMap.set(tk, { date: dk, source: src, count: 1 });
      }
    }

    const sources = CANONICAL_FOLLOW_SOURCES.map((source) => ({
      source,
      newFollowers: totals.get(source) ?? 0,
    })).sort((a, b) => b.newFollowers - a.newFollowers);

    const topSource = sources[0] && sources[0].newFollowers > 0 ? sources[0].source : null;
    const trend = Array.from(trendMap.values()).sort(
      (a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source)
    );

    return {
      sources,
      topSource,
      trend,
    };
  }

  /**
   * 10. Side-by-side comparison of up to 5 creator-owned items of the same contentType.
   */
  async getCrossContentCompare(
    creatorId: string,
    contentType: AnalyticsContentType,
    contentIds: string[]
  ): Promise<CrossContentCompareResponse> {
    if (contentIds.length === 0 || contentIds.length > 5) {
      throw new BadRequestError('Must supply 1 to 5 contentIds', 'validation_error');
    }

    const ownedItems = await Promise.all(
      contentIds.map((id) => this.resolveOwnedContent(creatorId, contentType, id))
    );
    const snapshots = await Promise.all(
      ownedItems.map((owned) => this.computeLifetimeSnapshot(owned))
    );

    const items = snapshots.map(({ contentId, preview, createdAt: _c, ...metrics }) => ({
      contentId,
      preview,
      metrics,
    }));

    if (items.length === 0) {
      return { items: [], winner: null };
    }

    // Winner selection: highest_engagement_rate, tiebreak most_reach, tiebreak most_saves
    const sortedByEngRate = [...items].sort((a, b) => b.metrics.engagementRate - a.metrics.engagementRate);
    if (
      items.length === 1 ||
      sortedByEngRate[0].metrics.engagementRate > sortedByEngRate[1].metrics.engagementRate
    ) {
      return {
        items,
        winner: { contentId: sortedByEngRate[0].contentId, why: 'highest_engagement_rate' },
      };
    }

    const topEngRate = sortedByEngRate[0].metrics.engagementRate;
    const tiedRate = items.filter((i) => i.metrics.engagementRate === topEngRate);
    const sortedByReach = [...tiedRate].sort((a, b) => b.metrics.reach - a.metrics.reach);
    if (sortedByReach.length === 1 || sortedByReach[0].metrics.reach > sortedByReach[1].metrics.reach) {
      return {
        items,
        winner: { contentId: sortedByReach[0].contentId, why: 'most_reach' },
      };
    }

    const topReach = sortedByReach[0].metrics.reach;
    const tiedReach = tiedRate.filter((i) => i.metrics.reach === topReach);
    const sortedBySaves = [...tiedReach].sort((a, b) => b.metrics.saves - a.metrics.saves);
    return {
      items,
      winner: { contentId: sortedBySaves[0].contentId, why: 'most_saves' },
    };
  }
}

export const defaultAnalyticsInsightsService = new AnalyticsInsightsService();
