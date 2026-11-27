import { ObjectId, type Collection, type Db, type ClientSession } from 'mongodb';
import {
  getDb,
  getPostsCollection,
  getProfilesCollection,
  type PostDocument,
  type ProfileDocument,
} from '../../../db/mongo.js';

export class PostRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private getCollection(): Collection<PostDocument> {
    return getPostsCollection(this.customDb ?? getDb());
  }

  private getProfilesCol(): Collection<ProfileDocument> {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  async createPost(
    post: Omit<PostDocument, '_id'>,
    session?: ClientSession
  ): Promise<PostDocument> {
    const res = await this.getCollection().insertOne(post as any, { session });
    return {
      _id: res.insertedId,
      ...post,
    };
  }

  async incrementProfilePostCount(
    authorId: string,
    session?: ClientSession
  ): Promise<void> {
    await this.getProfilesCol().updateOne(
      { userId: authorId },
      { $inc: { postCount: 1 } },
      { session }
    );
  }

  async decrementProfilePostCount(
    authorId: string,
    session?: ClientSession
  ): Promise<void> {
    await this.getProfilesCol().updateOne(
      { userId: authorId, postCount: { $gt: 0 } },
      { $inc: { postCount: -1 } },
      { session }
    );
  }

  async getPostById(postId: ObjectId): Promise<PostDocument | null> {
    return this.getCollection().findOne({ _id: postId });
  }

  async softDeletePost(
    postId: ObjectId,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().updateOne(
      { _id: postId },
      { $set: { deleted: true, updatedAt: new Date() } },
      { session }
    );
    return res.modifiedCount > 0;
  }

  async getUserPosts(
    authorId: string,
    limit: number,
    before?: Date
  ): Promise<PostDocument[]> {
    const filter: Record<string, unknown> = {
      authorId,
      deleted: false,
    };
    if (before) {
      filter.createdAt = { $lt: before };
    }

    return this.getCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getFeedPosts(
    authorIds: string[],
    limit: number,
    before?: Date
  ): Promise<PostDocument[]> {
    if (authorIds.length === 0) return [];
    const filter: Record<string, unknown> = {
      authorId: { $in: authorIds },
      deleted: false,
    };
    if (before) {
      filter.createdAt = { $lt: before };
    }

    return this.getCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async updatePost(
    postId: ObjectId,
    fields: { body?: string; removeImage?: boolean; mentions?: string[]; hashtags?: string[] }
  ): Promise<PostDocument | null> {
    const $set: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (fields.body !== undefined) {
      $set.body = fields.body;
    }
    if (fields.mentions !== undefined) {
      $set.mentions = fields.mentions;
    }
    if (fields.hashtags !== undefined) {
      $set.hashtags = fields.hashtags;
    }
    if (fields.removeImage) {
      $set.imageKey = null;
      $set.imageUrl = null;
    }

    const res = await this.getCollection().findOneAndUpdate(
      { _id: postId, deleted: false },
      { $set },
      { returnDocument: 'after' }
    );
    return res;
  }

  async getPostsByHashtag(
    tag: string,
    limit: number,
    before?: Date,
    excludeAuthorIds: string[] = []
  ): Promise<PostDocument[]> {
    const filter: Record<string, unknown> = {
      hashtags: tag,
      deleted: false,
    };
    if (excludeAuthorIds.length > 0) {
      filter.authorId = { $nin: excludeAuthorIds };
    }
    if (before) {
      filter.createdAt = { $lt: before };
    }

    return this.getCollection()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();
  }

  async countPostsByHashtag(
    tag: string,
    excludeAuthorIds: string[] = []
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      hashtags: tag,
      deleted: false,
    };
    if (excludeAuthorIds.length > 0) {
      filter.authorId = { $nin: excludeAuthorIds };
    }
    return this.getCollection().countDocuments(filter);
  }

  async getTrendingHashtags(
    since: Date,
    limit: number,
    excludeAuthorIds: string[] = []
  ): Promise<Array<{ tag: string; postCount: number }>> {
    const matchStage: Record<string, unknown> = {
      deleted: false,
      createdAt: { $gte: since },
      'hashtags.0': { $exists: true },
    };
    if (excludeAuthorIds.length > 0) {
      matchStage.authorId = { $nin: excludeAuthorIds };
    }

    return this.getCollection()
      .aggregate<{ tag: string; postCount: number }>([
        { $match: matchStage },
        { $unwind: '$hashtags' },
        {
          $group: {
            _id: '$hashtags',
            postCount: { $sum: 1 },
            latestAt: { $max: '$createdAt' },
          },
        },
        { $sort: { postCount: -1, latestAt: -1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, tag: '$_id', postCount: 1 } },
      ])
      .toArray();
  }

  async getPopularPosts(
    since: Date,
    limit: number
  ): Promise<PostDocument[]> {
    return this.getCollection()
      .find({
        deleted: false,
        createdAt: { $gte: since },
      })
      .sort({ likeCount: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getPostsByIds(postIds: ObjectId[]): Promise<PostDocument[]> {
    if (postIds.length === 0) return [];
    return this.getCollection()
      .find({
        _id: { $in: postIds },
        deleted: false,
      })
      .toArray();
  }
}

export const defaultPostRepository = new PostRepository();
