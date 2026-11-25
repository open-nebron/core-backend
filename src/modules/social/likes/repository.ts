import { ObjectId, type Collection, type Db, type ClientSession } from 'mongodb';
import {
  getDb,
  getPostLikesCollection,
  getPostsCollection,
  type PostLikeDocument,
  type PostDocument,
} from '../../../db/mongo.js';

export class PostLikeRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private getCollection(): Collection<PostLikeDocument> {
    return getPostLikesCollection(this.customDb ?? getDb());
  }

  private getPostsCol(): Collection<PostDocument> {
    return getPostsCollection(this.customDb ?? getDb());
  }

  async findLike(postId: ObjectId, userId: string): Promise<PostLikeDocument | null> {
    return this.getCollection().findOne({ postId, userId });
  }

  async hasLikedBatch(userId: string, postIds: ObjectId[]): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const docs = await this.getCollection()
      .find(
        { userId, postId: { $in: postIds } },
        { projection: { postId: 1 } }
      )
      .toArray();
    return new Set(docs.map((d) => d.postId.toString()));
  }

  async insertLike(
    postId: ObjectId,
    userId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().updateOne(
      { postId, userId },
      { $setOnInsert: { postId, userId, createdAt: new Date() } },
      { upsert: true, session }
    );
    return (res.upsertedCount ?? 0) > 0;
  }

  async removeLike(
    postId: ObjectId,
    userId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().deleteOne(
      { postId, userId },
      { session }
    );
    return (res.deletedCount ?? 0) > 0;
  }

  async incrementPostLikeCount(postId: ObjectId, session?: ClientSession): Promise<void> {
    await this.getPostsCol().updateOne(
      { _id: postId },
      { $inc: { likeCount: 1 } },
      { session }
    );
  }

  async decrementPostLikeCount(postId: ObjectId, session?: ClientSession): Promise<void> {
    await this.getPostsCol().updateOne(
      { _id: postId, likeCount: { $gt: 0 } },
      { $inc: { likeCount: -1 } },
      { session }
    );
  }

  async getPostLikes(
    postId: ObjectId,
    limit: number,
    before?: Date
  ): Promise<PostLikeDocument[]> {
    const filter: Record<string, unknown> = { postId };
    if (before) {
      filter.createdAt = { $lt: before };
    }
    return this.getCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }
}

export const defaultPostLikeRepository = new PostLikeRepository();
