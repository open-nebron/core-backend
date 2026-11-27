import type { Db } from 'mongodb';
import {
  getDb,
  getFollowsCollection,
  getPostLikesCollection,
  getPostsCollection,
  getProfilesCollection,
  getReelLikesCollection,
  getReelsCollection,
  type PostDocument,
  type ProfileDocument,
  type ReelDocument,
} from '../../db/mongo.js';
import { computePublicUrl } from '../../lib/r2.js';
import { getBlockedUserIds } from '../social/block-filter.js';
import { defaultPostService, PostService, type PostResponse } from '../social/posts/service.js';
import { defaultReelsService, ReelsService, type ReelResponse } from '../reels/reels.service.js';

export type ExploreTrendingType = 'posts' | 'reels';
export type ExploreTrendingPeriod = '24h' | '7d';
export type SuggestionReason = 'friends_of_friends' | 'similar_interests' | 'popular';

export interface ExploreSuggestionItem {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  followerCount: number;
  reason: SuggestionReason;
  contextLabel: string;
}

/**
 * Computes engagement velocity = (likes + comments*2 + shares*3 + saves*2) / max(0.5, hoursSincePosted).
 */
export function computeEngagementVelocity(
  metrics: {
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    createdAt: Date | string;
  },
  nowMs: number = Date.now()
): { engagement: number; velocity: number } {
  const createdMs =
    metrics.createdAt instanceof Date
      ? metrics.createdAt.getTime()
      : new Date(metrics.createdAt).getTime();
  const hoursSincePosted = Math.max(0.5, (nowMs - createdMs) / 3_600_000);
  const engagement =
    metrics.likes + metrics.comments * 2 + metrics.shares * 3 + metrics.saves * 2;
  const velocity = engagement / hoursSincePosted;
  return { engagement, velocity };
}

export class ExploreService {
  private customDb?: Db;
  private postService: PostService;
  private reelsService: ReelsService;

  constructor(customDb?: Db) {
    this.customDb = customDb;
    this.postService = customDb
      ? new PostService(undefined, undefined, undefined, undefined, undefined, customDb)
      : defaultPostService;
    this.reelsService = customDb
      ? new ReelsService(undefined, undefined, customDb)
      : defaultReelsService;
  }

  private db(): Db {
    return this.customDb ?? getDb();
  }

  async getTrending(
    viewerId: string,
    type: ExploreTrendingType = 'posts',
    period: ExploreTrendingPeriod = '7d',
    limit: number = 20
  ): Promise<{
    type: ExploreTrendingType;
    period: ExploreTrendingPeriod;
    items: Array<PostResponse | ReelResponse>;
  }> {
    const database = this.db();
    const nowMs = Date.now();
    const since = new Date(
      nowMs - (period === '24h' ? 24 * 3_600_000 : 7 * 24 * 3_600_000)
    );

    const [blockedIds, bannedProfiles] = await Promise.all([
      getBlockedUserIds(viewerId, undefined, database),
      getProfilesCollection(database)
        .find({ isBanned: true }, { projection: { userId: 1 } })
        .toArray(),
    ]);

    const excludeAuthorIds = new Set<string>([viewerId, ...blockedIds]);
    for (const bp of bannedProfiles) {
      excludeAuthorIds.add(bp.userId);
    }
    const excludeArray = Array.from(excludeAuthorIds);

    if (type === 'posts') {
      let candidates: PostDocument[] = await getPostsCollection(database)
        .find({
          deleted: false,
          authorId: { $nin: excludeArray },
          createdAt: { $gte: since },
        })
        .sort({ createdAt: -1 })
        .limit(Math.max(200, limit * 8))
        .toArray();

      // If strict window is completely empty for an empty feed user, backfill with recent non-deleted posts
      if (candidates.length === 0 && period === '7d') {
        candidates = await getPostsCollection(database)
          .find({
            deleted: false,
            authorId: { $nin: excludeArray },
          })
          .sort({ likeCount: -1, createdAt: -1 })
          .limit(limit * 4)
          .toArray();
      }

      const scored = candidates
        .map((p) => {
          const { engagement, velocity } = computeEngagementVelocity(
            {
              likes: p.likeCount ?? 0,
              comments: p.commentCount ?? 0,
              shares: p.shareCount ?? 0,
              saves: p.saveCount ?? 0,
              createdAt: p.createdAt,
            },
            nowMs
          );
          return { doc: p, engagement, velocity };
        })
        .sort((a, b) => {
          // Always place positive engagement ahead of 0-engagement items
          if ((b.engagement > 0) !== (a.engagement > 0)) {
            return b.engagement > 0 ? 1 : -1;
          }
          if (b.velocity !== a.velocity) return b.velocity - a.velocity;
          if (b.engagement !== a.engagement) return b.engagement - a.engagement;
          return new Date(b.doc.createdAt).getTime() - new Date(a.doc.createdAt).getTime();
        })
        .slice(0, limit)
        .map((s) => s.doc);

      const items = await this.postService.formatPostsList(viewerId, scored, {
        excludeBanned: true,
      });
      return { type, period, items };
    }

    let reelCandidates: ReelDocument[] = await getReelsCollection(database)
      .find({
        deleted: false,
        authorId: { $nin: excludeArray },
        createdAt: { $gte: since },
      })
      .sort({ createdAt: -1 })
      .limit(Math.max(200, limit * 8))
      .toArray();

    if (reelCandidates.length === 0 && period === '7d') {
      reelCandidates = await getReelsCollection(database)
        .find({
          deleted: false,
          authorId: { $nin: excludeArray },
        })
        .sort({ likeCount: -1, viewCount: -1, createdAt: -1 })
        .limit(limit * 4)
        .toArray();
    }

    const scoredReels = reelCandidates
      .map((r) => {
        const { engagement, velocity } = computeEngagementVelocity(
          {
            likes: r.likeCount ?? 0,
            comments: r.commentCount ?? 0,
            shares: r.shareCount ?? 0,
            saves: r.saveCount ?? 0,
            createdAt: r.createdAt,
          },
          nowMs
        );
        return { doc: r, engagement, velocity };
      })
      .sort((a, b) => {
        if ((b.engagement > 0) !== (a.engagement > 0)) {
          return b.engagement > 0 ? 1 : -1;
        }
        if (b.velocity !== a.velocity) return b.velocity - a.velocity;
        if (b.engagement !== a.engagement) return b.engagement - a.engagement;
        return (b.doc.viewCount ?? 0) - (a.doc.viewCount ?? 0);
      })
      .slice(0, limit)
      .map((s) => s.doc);

    const items = await this.reelsService.enrichReels(scoredReels, viewerId);
    return { type, period, items };
  }

  async getSuggestions(viewerId: string, limit: number = 10): Promise<ExploreSuggestionItem[]> {
    const database = this.db();
    const followsCol = getFollowsCollection(database);
    const profilesCol = getProfilesCollection(database);

    const [followingDocs, blockedIds, viewerPostLikes, viewerReelLikes] = await Promise.all([
      followsCol.find({ followerId: viewerId }, { projection: { followingId: 1 } }).toArray(),
      getBlockedUserIds(viewerId, undefined, database),
      getPostLikesCollection(database)
        .find({ userId: viewerId })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
      getReelLikesCollection(database)
        .find({ userId: viewerId })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
    ]);

    const followingIds = followingDocs.map((f) => f.followingId);
    const excludeSet = new Set<string>([viewerId, ...followingIds, ...blockedIds]);

    const fofCounts = new Map<string, number>();
    const fofByWhom = new Map<string, string[]>();

    // (a) Friends of friends
    if (followingIds.length > 0) {
      const fofEdges = await followsCol
        .find({ followerId: { $in: followingIds } })
        .limit(500)
        .toArray();
      for (const edge of fofEdges) {
        if (excludeSet.has(edge.followingId)) continue;
        fofCounts.set(edge.followingId, (fofCounts.get(edge.followingId) ?? 0) + 1);
        const list = fofByWhom.get(edge.followingId) ?? [];
        if (list.length < 2 && !list.includes(edge.followerId)) {
          list.push(edge.followerId);
          fofByWhom.set(edge.followingId, list);
        }
      }
    }

    // (b) Similar interests via co-liked posts/reels
    const interestScores = new Map<string, number>();
    const likedPostIds = viewerPostLikes.map((l) => l.postId);
    const likedReelIds = viewerReelLikes.map((l) => l.reelId);

    if (likedPostIds.length > 0 || likedReelIds.length > 0) {
      const [coPostLikers, coReelLikers] = await Promise.all([
        likedPostIds.length > 0
          ? getPostLikesCollection(database)
              .find({ postId: { $in: likedPostIds }, userId: { $ne: viewerId } })
              .limit(100)
              .toArray()
          : Promise.resolve([]),
        likedReelIds.length > 0
          ? getReelLikesCollection(database)
              .find({ reelId: { $in: likedReelIds }, userId: { $ne: viewerId } })
              .limit(100)
              .toArray()
          : Promise.resolve([]),
      ]);

      const peerIds = Array.from(
        new Set([
          ...coPostLikers.map((l) => l.userId),
          ...coReelLikers.map((l) => l.userId),
        ])
      ).filter((id) => !blockedIds.has(id));

      for (const peerId of peerIds) {
        if (!excludeSet.has(peerId)) {
          interestScores.set(peerId, (interestScores.get(peerId) ?? 0) + 1);
        }
      }

      if (peerIds.length > 0) {
        const peerFollows = await followsCol
          .find({ followerId: { $in: peerIds } })
          .limit(300)
          .toArray();
        for (const pf of peerFollows) {
          if (!excludeSet.has(pf.followingId)) {
            interestScores.set(pf.followingId, (interestScores.get(pf.followingId) ?? 0) + 1);
          }
        }
      }
    }

    // (c) Popular creators
    const candidateIds = Array.from(new Set([...fofCounts.keys(), ...interestScores.keys()]));
    const [signalProfiles, popularProfiles] = await Promise.all([
      candidateIds.length > 0
        ? profilesCol.find({ userId: { $in: candidateIds }, isBanned: { $ne: true } }).toArray()
        : Promise.resolve([]),
      profilesCol
        .find({
          userId: { $nin: Array.from(excludeSet) },
          isBanned: { $ne: true },
        })
        .sort({ followerCount: -1, createdAt: -1 })
        .limit(limit * 2)
        .toArray(),
    ]);

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of signalProfiles) profileMap.set(p.userId, p);
    for (const p of popularProfiles) {
      if (!profileMap.has(p.userId)) profileMap.set(p.userId, p);
    }

    // Fetch mutual follower usernames for "Followed by X and Y" labels
    const mutualAuthorIds = Array.from(
      new Set(Array.from(fofByWhom.values()).flat())
    );
    const mutualProfiles =
      mutualAuthorIds.length > 0
        ? await profilesCol
            .find({ userId: { $in: mutualAuthorIds } }, { projection: { userId: 1, username: 1 } })
            .toArray()
        : [];
    const usernameById = new Map(mutualProfiles.map((p) => [p.userId, p.username]));

    const ranked = Array.from(profileMap.values())
      .filter((p) => !excludeSet.has(p.userId))
      .map((p) => {
        const fof = fofCounts.get(p.userId) ?? 0;
        const sim = interestScores.get(p.userId) ?? 0;
        const pop = p.followerCount ?? 0;
        const score = fof * 100 + sim * 25 + Math.min(20, pop);

        let reason: SuggestionReason = 'popular';
        let contextLabel = 'Popular on Nebron';

        if (fof > 0) {
          reason = 'friends_of_friends';
          const names = (fofByWhom.get(p.userId) ?? [])
            .map((uid) => usernameById.get(uid))
            .filter((u): u is string => Boolean(u));
          if (names.length >= 2) {
            contextLabel = `Followed by @${names[0]} and @${names[1]}`;
          } else if (names.length === 1) {
            contextLabel = `Followed by @${names[0]}`;
          } else {
            contextLabel = 'Followed by people you follow';
          }
        } else if (sim > 0) {
          reason = 'similar_interests';
          contextLabel = 'Similar interests';
        }

        return {
          profile: p,
          score,
          reason,
          contextLabel,
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.profile.followerCount ?? 0) - (a.profile.followerCount ?? 0)
      )
      .slice(0, limit);

    return ranked.map(({ profile, reason, contextLabel }) => ({
      userId: profile.userId,
      username: profile.username,
      name: profile.name ?? null,
      avatarUrl: computePublicUrl(profile.avatarKey, profile.updatedAt),
      followerCount: profile.followerCount ?? 0,
      reason,
      contextLabel,
    }));
  }
}

export const defaultExploreService = new ExploreService();
