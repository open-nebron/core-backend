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
    fields: { body?: string; removeImage?: boolean }
  ): Promise<PostDocument | null> {
    const $set: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (fields.body !== undefined) {
      $set.body = fields.body;
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
