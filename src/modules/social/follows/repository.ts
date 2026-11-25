import type { Collection, Db, ClientSession } from 'mongodb';
import {
  getDb,
  getFollowsCollection,
  getProfilesCollection,
  type FollowDocument,
  type ProfileDocument,
} from '../../../db/mongo.js';

export class FollowRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private getCollection(): Collection<FollowDocument> {
    return getFollowsCollection(this.customDb ?? getDb());
  }

  private getProfilesCol(): Collection<ProfileDocument> {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  async findFollow(followerId: string, followingId: string): Promise<FollowDocument | null> {
    return this.getCollection().findOne({ followerId, followingId });
  }

  async createFollow(
    followerId: string,
    followingId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().updateOne(
      { followerId, followingId },
      { $setOnInsert: { followerId, followingId, createdAt: new Date() } },
      { upsert: true, session }
    );
    return (res.upsertedCount ?? 0) > 0;
  }

  async deleteFollow(
    followerId: string,
    followingId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().deleteOne(
      { followerId, followingId },
      { session }
    );
    return (res.deletedCount ?? 0) > 0;
  }

  async incrementCounters(
    followerId: string,
    followingId: string,
    session?: ClientSession
  ): Promise<void> {
    const col = this.getProfilesCol();
    await col.updateOne(
      { userId: followerId },
      { $inc: { followingCount: 1 } },
      { session }
    );
    await col.updateOne(
      { userId: followingId },
      { $inc: { followerCount: 1 } },
      { session }
    );
  }

  async decrementCounters(
    followerId: string,
    followingId: string,
    session?: ClientSession
  ): Promise<void> {
    const col = this.getProfilesCol();
    await col.updateOne(
      { userId: followerId, followingCount: { $gt: 0 } },
      { $inc: { followingCount: -1 } },
      { session }
    );
    await col.updateOne(
      { userId: followingId, followerCount: { $gt: 0 } },
      { $inc: { followerCount: -1 } },
      { session }
    );
  }

  async getFollowers(
    followingId: string,
    limit: number,
    before?: Date
  ): Promise<FollowDocument[]> {
    const filter: Record<string, unknown> = { followingId };
    if (before) {
      filter.createdAt = { $lt: before };
    }
    return this.getCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getFollowing(
    followerId: string,
    limit: number,
    before?: Date
  ): Promise<FollowDocument[]> {
    const filter: Record<string, unknown> = { followerId };
    if (before) {
      filter.createdAt = { $lt: before };
    }
    return this.getCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getAllFollowingIds(followerId: string): Promise<string[]> {
    const docs = await this.getCollection()
      .find({ followerId }, { projection: { followingId: 1 } })
      .toArray();
    return docs.map((d) => d.followingId);
  }

  async getFollowingIds(followerId: string): Promise<string[]> {
    const docs = await this.getCollection()
      .find({ followerId }, { projection: { followingId: 1 } })
      .toArray();
    return docs.map((d) => d.followingId);
  }

  async isFollowingBatch(
    followerId: string,
    targetUserIds: string[]
  ): Promise<Set<string>> {
    if (targetUserIds.length === 0) return new Set();
    const docs = await this.getCollection()
      .find(
        { followerId, followingId: { $in: targetUserIds } },
        { projection: { followingId: 1 } }
      )
      .toArray();
    return new Set(docs.map((d) => d.followingId));
  }

  async getSuggestions(
    excludeUserIds: string[],
    limit: number
  ): Promise<ProfileDocument[]> {
    return this.getProfilesCol()
      .find({ userId: { $nin: excludeUserIds } })
      .sort({ followerCount: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
  }
}

export const defaultFollowRepository = new FollowRepository();
