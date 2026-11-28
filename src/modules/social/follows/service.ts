import type { Db, MongoClient } from 'mongodb';
import { FollowRepository, defaultFollowRepository } from './repository.js';
import {
  SocialEventPublisher,
  defaultSocialEventPublisher,
} from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import {
  getProfilesCollection,
  getFollowSourcesCollection,
  getUnfollowEventsCollection,
  getDb,
  getMongoClient,
  runInTransaction,
  type ProfileDocument,
  type FollowSourceType,
} from '../../../db/mongo.js';
import {
  SelfFollowNotAllowedError,
  BlockedError,
  NotFoundError,
} from '../../../utils/errors.js';
import { computePublicUrl } from '../../../lib/r2.js';

export interface UserFollowItem {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  isFollowingViewer: boolean;
  isFollowedByViewer?: boolean;
}

export interface UserSuggestionItem {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  followerCount: number;
}

export class FollowService {
  private repo: FollowRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: FollowRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient
  ) {
    this.repo = repo ?? defaultFollowRepository;
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customClient = customClient;
  }

  private getProfilesCol() {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  async followUser(
    followerId: string,
    followingId: string,
    source: FollowSourceType = 'other'
  ): Promise<void> {
    if (followerId === followingId) {
      throw new SelfFollowNotAllowedError();
    }

    const targetProfile = await this.getProfilesCol().findOne({ userId: followingId });
    if (!targetProfile) {
      throw new NotFoundError('User not found', 'user_not_found');
    }

    const isBlocked = await isBlockedPair(followerId, followingId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    let inserted = false;
    await runInTransaction(this.customClient, async (session) => {
      const existing = await this.repo.findFollow(followerId, followingId);
      if (existing) {
        return;
      }
      inserted = await this.repo.createFollow(followerId, followingId, session);
      if (inserted) {
        await this.repo.incrementCounters(followerId, followingId, session);
      }
    });

    if (inserted) {
      try {
        await getFollowSourcesCollection(this.customDb ?? getDb()).insertOne({
          followerId,
          followingId,
          source,
          at: new Date(),
        });
      } catch {
        // Best-effort non-blocking follow source tracking
      }

      await this.publisher.publishUserFollowed({
        followerId,
        followingId,
        at: new Date().toISOString(),
      });
    }
  }

  async unfollowUser(followerId: string, followingId: string): Promise<void> {
    let deleted = false;
    await runInTransaction(this.customClient, async (session) => {
      const existing = await this.repo.findFollow(followerId, followingId);
      if (!existing) {
        return;
      }
      deleted = await this.repo.deleteFollow(followerId, followingId, session);
      if (deleted) {
        await this.repo.decrementCounters(followerId, followingId, session);
      }
    });

    if (deleted) {
      try {
        await getUnfollowEventsCollection(this.customDb ?? getDb()).insertOne({
          followerId,
          followingId,
          at: new Date(),
        });
      } catch {
        // Best-effort non-blocking unfollow tracking
      }

      await this.publisher.publishUserUnfollowed({
        followerId,
        followingId,
        at: new Date().toISOString(),
      });
    }
  }

  async getFollowers(
    viewerId: string,
    targetUserId: string,
    limit: number = 30,
    before?: string
  ): Promise<UserFollowItem[]> {
    const beforeDate = before ? new Date(before) : undefined;
    const followDocs = await this.repo.getFollowers(targetUserId, limit, beforeDate);
    if (followDocs.length === 0) return [];

    const followerIds = followDocs.map((d) => d.followerId);
    const blockedUserIds = await getBlockedUserIds(viewerId, followerIds, this.customDb);
    const visibleFollowerIds = followerIds.filter((id) => !blockedUserIds.has(id));

    if (visibleFollowerIds.length === 0) return [];

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: visibleFollowerIds } })
      .toArray();

    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    const isFollowingViewerSet = await this.repo.isFollowingBatch(viewerId, visibleFollowerIds);

    return visibleFollowerIds.map((userId) => {
      const p = profileMap.get(userId);
      const isFollowed = isFollowingViewerSet.has(userId);
      return {
        userId,
        username: p?.username || 'unknown',
        name: p?.name ?? null,
        avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
        isFollowingViewer: isFollowed,
        isFollowedByViewer: isFollowed,
      };
    });
  }

  async getFollowing(
    viewerId: string,
    targetUserId: string,
    limit: number = 30,
    before?: string
  ): Promise<UserFollowItem[]> {
    const beforeDate = before ? new Date(before) : undefined;
    const followDocs = await this.repo.getFollowing(targetUserId, limit, beforeDate);
    if (followDocs.length === 0) return [];

    const followingIds = followDocs.map((d) => d.followingId);
    const blockedUserIds = await getBlockedUserIds(viewerId, followingIds, this.customDb);
    const visibleFollowingIds = followingIds.filter((id) => !blockedUserIds.has(id));

    if (visibleFollowingIds.length === 0) return [];

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: visibleFollowingIds } })
      .toArray();

    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    const isFollowingViewerSet = await this.repo.isFollowingBatch(viewerId, visibleFollowingIds);

    return visibleFollowingIds.map((userId) => {
      const p = profileMap.get(userId);
      const isFollowed = isFollowingViewerSet.has(userId);
      return {
        userId,
        username: p?.username || 'unknown',
        name: p?.name ?? null,
        avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
        isFollowingViewer: isFollowed,
        isFollowedByViewer: isFollowed,
      };
    });
  }

  async getSuggestions(
    viewerId: string,
    limit: number = 10
  ): Promise<UserSuggestionItem[]> {
    const followingIds = await this.repo.getFollowingIds(viewerId);
    const blockedUserIds = await getBlockedUserIds(viewerId, undefined, this.customDb);

    const excludeSet = new Set<string>([viewerId, ...followingIds, ...blockedUserIds]);
    const candidates = await this.repo.getSuggestions(Array.from(excludeSet), limit);

    return candidates.map((p) => ({
      userId: p.userId,
      username: p.username,
      name: p.name ?? null,
      avatarUrl: computePublicUrl(p.avatarKey, p.updatedAt),
      followerCount: p.followerCount ?? 0,
    }));
  }
}

export const defaultFollowService = new FollowService();
