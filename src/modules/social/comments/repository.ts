import { ObjectId, type Collection, type Db, type ClientSession } from 'mongodb';
import {
  getDb,
  getCommentsCollection,
  getPostsCollection,
  type CommentDocument,
  type PostDocument,
} from '../../../db/mongo.js';

export class CommentRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private getCollection(): Collection<CommentDocument> {
    return getCommentsCollection(this.customDb ?? getDb());
  }

  private getPostsCol(): Collection<PostDocument> {
    return getPostsCollection(this.customDb ?? getDb());
  }

  async createComment(
    comment: Omit<CommentDocument, '_id'>,
    session?: ClientSession
  ): Promise<CommentDocument> {
    const res = await this.getCollection().insertOne(comment as any, { session });
    return {
      _id: res.insertedId,
      ...comment,
    };
  }

  async getCommentById(commentId: ObjectId): Promise<CommentDocument | null> {
    return this.getCollection().findOne({ _id: commentId });
  }

  async softDeleteComment(
    commentId: ObjectId,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().updateOne(
      { _id: commentId },
      { $set: { deleted: true } },
      { session }
    );
    return res.modifiedCount > 0;
  }

  async incrementCommentCount(
    postId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getPostsCol().updateOne(
      { _id: postId },
      { $inc: { commentCount: 1 } },
      { session }
    );
  }

  async decrementCommentCount(
    postId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getPostsCol().updateOne(
      { _id: postId, commentCount: { $gt: 0 } },
      { $inc: { commentCount: -1 } },
      { session }
    );
  }

  async getCommentsByPost(
    postId: ObjectId,
    limit: number = 30,
    before?: Date
  ): Promise<CommentDocument[]> {
    const filter: Record<string, unknown> = {
      postId,
      deleted: false,
    };
    if (before) {
      filter.createdAt = { $lt: before };
    }

    return this.getCollection()
      .find(filter)
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async getRecentCommentsForPost(
    postId: ObjectId,
    limit: number = 3
  ): Promise<CommentDocument[]> {
    const docs = await this.getCollection()
      .find({ postId, deleted: false })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse();
  }

  async getRecentCommentsForPosts(
    postIds: ObjectId[],
    limitPerPost: number = 3
  ): Promise<Map<string, CommentDocument[]>> {
    const result = new Map<string, CommentDocument[]>();
    if (postIds.length === 0) return result;

    const docs = await this.getCollection()
      .find({ postId: { $in: postIds }, deleted: false })
      .sort({ createdAt: -1 })
      .toArray();

    for (const doc of docs) {
      const pid = doc.postId.toString();
      const existing = result.get(pid) || [];
      if (existing.length < limitPerPost) {
        existing.push(doc);
        result.set(pid, existing);
      }
    }

    // Reverse each list to be chronological ASC
    for (const [pid, list] of result.entries()) {
      result.set(pid, list.reverse());
    }

    return result;
  }
}

export const defaultCommentRepository = new CommentRepository();
