import { ObjectId, type Collection, type Db, type ClientSession } from 'mongodb';
import {
  getDb,
  getCommentsCollection,
  getCommentLikesCollection,
  getPostsCollection,
  getReelsCollection,
  type CommentDocument,
  type CommentLikeDocument,
  type PostDocument,
  type ReelDocument,
} from '../../../db/mongo.js';

export type CommentSortOrder = 'top' | 'new';

export class CommentRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private getCollection(): Collection<CommentDocument> {
    return getCommentsCollection(this.customDb ?? getDb());
  }

  private getLikesCol(): Collection<CommentLikeDocument> {
    return getCommentLikesCollection(this.customDb ?? getDb());
  }

  private getPostsCol(): Collection<PostDocument> {
    return getPostsCollection(this.customDb ?? getDb());
  }

  private getReelsCol(): Collection<ReelDocument> {
    return getReelsCollection(this.customDb ?? getDb());
  }

  async createComment(
    comment: Omit<CommentDocument, '_id'>,
    session?: ClientSession
  ): Promise<CommentDocument> {
    const doc: Omit<CommentDocument, '_id'> = {
      parentCommentId: null,
      replyToUserId: null,
      likeCount: 0,
      replyCount: 0,
      pinned: false,
      pinnedAt: null,
      editedAt: null,
      mentions: [],
      hashtags: [],
      ...comment,
    };
    const res = await this.getCollection().insertOne(doc as any, { session });
    return {
      _id: res.insertedId,
      ...doc,
    };
  }

  async getCommentById(commentId: ObjectId): Promise<CommentDocument | null> {
    return this.getCollection().findOne({ _id: commentId });
  }

  async softDeleteComment(
    commentId: ObjectId,
    session?: ClientSession,
    placeholderBody?: string
  ): Promise<boolean> {
    const update: Record<string, unknown> = {
      deleted: true,
      pinned: false,
      pinnedAt: null,
    };
    if (placeholderBody !== undefined) {
      update.body = placeholderBody;
    }
    const res = await this.getCollection().updateOne(
      { _id: commentId },
      { $set: update },
      { session }
    );
    return res.modifiedCount > 0;
  }

  async editCommentBody(
    commentId: ObjectId,
    body: string,
    editedAt: Date,
    mentions: string[],
    hashtags: string[]
  ): Promise<CommentDocument | null> {
    return this.getCollection().findOneAndUpdate(
      { _id: commentId, deleted: false },
      {
        $set: {
          body,
          editedAt,
          mentions,
          hashtags,
        },
      },
      { returnDocument: 'after' }
    );
  }

  async countPinnedComments(
    postId: ObjectId,
    session?: ClientSession
  ): Promise<number> {
    return this.getCollection().countDocuments(
      {
        postId,
        parentCommentId: null,
        pinned: true,
        deleted: false,
      },
      { session }
    );
  }

  async setPinned(
    commentId: ObjectId,
    pinned: boolean,
    pinnedAt: Date | null,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getCollection().updateOne(
      { _id: commentId, deleted: false },
      { $set: { pinned, pinnedAt } },
      { session }
    );
    return res.modifiedCount > 0;
  }

  async countActiveReplies(parentCommentId: ObjectId): Promise<number> {
    return this.getCollection().countDocuments({
      parentCommentId,
      deleted: false,
    });
  }

  async incrementReplyCount(
    parentCommentId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getCollection().updateOne(
      { _id: parentCommentId },
      { $inc: { replyCount: 1 } },
      { session }
    );
  }

  async decrementReplyCount(
    parentCommentId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getCollection().updateOne(
      { _id: parentCommentId, replyCount: { $gt: 0 } },
      { $inc: { replyCount: -1 } },
      { session }
    );
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

  async incrementReelCommentCount(
    reelId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getReelsCol().updateOne(
      { _id: reelId },
      { $inc: { commentCount: 1 } },
      { session }
    );
  }

  async decrementReelCommentCount(
    reelId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getReelsCol().updateOne(
      { _id: reelId, commentCount: { $gt: 0 } },
      { $inc: { commentCount: -1 } },
      { session }
    );
  }

  async findCommentLike(
    commentId: ObjectId,
    userId: string
  ): Promise<CommentLikeDocument | null> {
    return this.getLikesCol().findOne({ commentId, userId });
  }

  async insertCommentLike(
    commentId: ObjectId,
    userId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getLikesCol().updateOne(
      { commentId, userId },
      { $setOnInsert: { commentId, userId, createdAt: new Date() } },
      { upsert: true, session }
    );
    return (res.upsertedCount ?? 0) > 0;
  }

  async removeCommentLike(
    commentId: ObjectId,
    userId: string,
    session?: ClientSession
  ): Promise<boolean> {
    const res = await this.getLikesCol().deleteOne(
      { commentId, userId },
      { session }
    );
    return (res.deletedCount ?? 0) > 0;
  }

  async incrementCommentLikeCount(
    commentId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getCollection().updateOne(
      { _id: commentId },
      { $inc: { likeCount: 1 } },
      { session }
    );
  }

  async decrementCommentLikeCount(
    commentId: ObjectId,
    session?: ClientSession
  ): Promise<void> {
    await this.getCollection().updateOne(
      { _id: commentId, likeCount: { $gt: 0 } },
      { $inc: { likeCount: -1 } },
      { session }
    );
  }

  async hasLikedCommentsBatch(
    userId: string,
    commentIds: ObjectId[]
  ): Promise<Set<string>> {
    if (commentIds.length === 0) return new Set();
    const docs = await this.getLikesCol()
      .find(
        { userId, commentId: { $in: commentIds } },
        { projection: { commentId: 1 } }
      )
      .toArray();
    return new Set(docs.map((d) => d.commentId.toString()));
  }

  async getTopLevelComments(
    targetField: 'postId' | 'reelId',
    targetId: ObjectId,
    limit: number = 20,
    before?: Date,
    sort: CommentSortOrder = 'top',
    excludeAuthorIds: string[] = []
  ): Promise<CommentDocument[]> {
    const nonDeletedClause: Record<string, unknown> = { deleted: false };
    if (excludeAuthorIds.length > 0) {
      nonDeletedClause.authorId = { $nin: excludeAuthorIds };
    }
    const filter: Record<string, unknown> = {
      [targetField]: targetId,
      parentCommentId: null,
      $or: [
        nonDeletedClause,
        { deleted: true, replyCount: { $gt: 0 } },
      ],
    };
    if (before) {
      filter.createdAt = { $lt: before };
      filter.pinned = { $ne: true };
    }

    const sortSpec: Record<string, 1 | -1> =
      sort === 'new'
        ? { pinned: -1, pinnedAt: 1, createdAt: -1, _id: -1 }
        : { pinned: -1, pinnedAt: 1, likeCount: -1, createdAt: -1, _id: -1 };

    return this.getCollection()
      .find(filter)
      .sort(sortSpec)
      .limit(limit)
      .toArray();
  }

  async getCommentsByReel(
    reelId: ObjectId,
    limit: number = 20,
    before?: Date,
    sort: CommentSortOrder = 'top',
    excludeAuthorIds: string[] = []
  ): Promise<CommentDocument[]> {
    return this.getTopLevelComments('reelId', reelId, limit, before, sort, excludeAuthorIds);
  }

  async getCommentsByPost(
    postId: ObjectId,
    limit: number = 20,
    before?: Date,
    sort: CommentSortOrder = 'top',
    excludeAuthorIds: string[] = []
  ): Promise<CommentDocument[]> {
    return this.getTopLevelComments('postId', postId, limit, before, sort, excludeAuthorIds);
  }

  async getRepliesForParents(parentIds: ObjectId[]): Promise<CommentDocument[]> {
    if (parentIds.length === 0) return [];
    return this.getCollection()
      .find({
        parentCommentId: { $in: parentIds },
        deleted: false,
      })
      .sort({ likeCount: -1, createdAt: 1, _id: 1 })
      .toArray();
  }

  async getRepliesByParentId(
    parentCommentId: ObjectId,
    limit: number = 20,
    before?: Date,
    excludeAuthorIds: string[] = []
  ): Promise<CommentDocument[]> {
    const filter: Record<string, unknown> = {
      parentCommentId,
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

  async getDistinctCommentAuthors(
    targetField: 'postId' | 'reelId',
    targetId: ObjectId
  ): Promise<string[]> {
    const values = await this.getCollection().distinct('authorId', {
      [targetField]: targetId,
      deleted: false,
    });
    return values.filter((v): v is string => typeof v === 'string');
  }

  async getRecentCommentsForPost(
    postId: ObjectId,
    limit: number = 3
  ): Promise<CommentDocument[]> {
    const docs = await this.getCollection()
      .find({ postId, parentCommentId: null, deleted: false })
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
      .find({ postId: { $in: postIds }, parentCommentId: null, deleted: false })
      .sort({ createdAt: -1 })
      .toArray();

    for (const doc of docs) {
      if (!doc.postId) continue;
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
