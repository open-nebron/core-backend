import { ObjectId, type ClientSession, type Collection, type Db } from 'mongodb';
import {
  getDb,
  getPostsCollection,
  getReelsCollection,
  getCommentsCollection,
  getSavedPostsCollection,
  getSavedReelsCollection,
  getSavedCommentsCollection,
  type PostDocument,
  type ReelDocument,
  type CommentDocument,
  type SavedPostDocument,
  type SavedReelDocument,
  type SavedCommentDocument,
} from '../../../db/mongo.js';

export type SaveContentType = 'post' | 'reel' | 'comment';

export class SaveRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private db(): Db {
    return this.customDb ?? getDb();
  }

  private getSavedCollection(type: 'post'): Collection<SavedPostDocument>;
  private getSavedCollection(type: 'reel'): Collection<SavedReelDocument>;
  private getSavedCollection(type: 'comment'): Collection<SavedCommentDocument>;
  private getSavedCollection(type: SaveContentType): Collection<any> {
    if (type === 'post') return getSavedPostsCollection(this.db());
    if (type === 'reel') return getSavedReelsCollection(this.db());
    return getSavedCommentsCollection(this.db());
  }

  private getTargetCollection(type: SaveContentType): Collection<PostDocument | ReelDocument | CommentDocument> {
    if (type === 'post') return getPostsCollection(this.db()) as any;
    if (type === 'reel') return getReelsCollection(this.db()) as any;
    return getCommentsCollection(this.db()) as any;
  }

  private idField(type: SaveContentType): 'postId' | 'reelId' | 'commentId' {
    if (type === 'post') return 'postId';
    if (type === 'reel') return 'reelId';
    return 'commentId';
  }

  async insertSave(
    type: SaveContentType,
    userId: string,
    targetId: ObjectId,
    savedAt: Date,
    session?: ClientSession
  ): Promise<boolean> {
    const field = this.idField(type);
    const col = this.getSavedCollection(type as any);
    const res = await col.updateOne(
      { userId, [field]: targetId },
      { $setOnInsert: { userId, [field]: targetId, savedAt } },
      { upsert: true, session }
    );
    return (res.upsertedCount ?? 0) > 0;
  }

  async removeSave(
    type: SaveContentType,
    userId: string,
    targetId: ObjectId,
    session?: ClientSession
  ): Promise<boolean> {
    const field = this.idField(type);
    const col = this.getSavedCollection(type as any);
    const res = await col.deleteOne({ userId, [field]: targetId }, { session });
    return (res.deletedCount ?? 0) > 0;
  }

  async adjustSaveCount(
    type: SaveContentType,
    targetId: ObjectId,
    delta: 1 | -1,
    session?: ClientSession
  ): Promise<number> {
    const col = this.getTargetCollection(type);
    const filter = delta < 0 ? { _id: targetId, saveCount: { $gt: 0 } } : { _id: targetId };
    const updated = await col.findOneAndUpdate(
      filter as any,
      { $inc: { saveCount: delta } } as any,
      { returnDocument: 'after', session }
    );
    return (updated as any)?.saveCount ?? 0;
  }

  async incrementShareCount(
    type: SaveContentType,
    targetId: ObjectId
  ): Promise<number> {
    const col = this.getTargetCollection(type);
    const updated = await col.findOneAndUpdate(
      { _id: targetId } as any,
      { $inc: { shareCount: 1 } } as any,
      { returnDocument: 'after' }
    );
    return (updated as any)?.shareCount ?? 0;
  }

  async hasSaved(
    type: SaveContentType,
    userId: string,
    targetId: ObjectId
  ): Promise<boolean> {
    const field = this.idField(type);
    const col = this.getSavedCollection(type as any);
    const doc = await col.findOne({ userId, [field]: targetId }, { projection: { _id: 1 } });
    return Boolean(doc);
  }

  async hasSavedBatch(
    type: SaveContentType,
    userId: string,
    targetIds: ObjectId[]
  ): Promise<Set<string>> {
    if (!userId || targetIds.length === 0) return new Set();
    const field = this.idField(type);
    const col = this.getSavedCollection(type as any);
    const docs = await col
      .find({ userId, [field]: { $in: targetIds } }, { projection: { [field]: 1 } })
      .toArray();
    return new Set(docs.map((d: any) => d[field].toString()));
  }

  async getSavedEntries<T extends SavedPostDocument | SavedReelDocument | SavedCommentDocument>(
    type: SaveContentType,
    userId: string,
    limit: number,
    before?: Date
  ): Promise<T[]> {
    const col = this.getSavedCollection(type as any);
    const filter: Record<string, unknown> = { userId };
    if (before) {
      filter.savedAt = { $lt: before };
    }
    return col
      .find(filter)
      .sort({ savedAt: -1, _id: -1 })
      .limit(limit)
      .toArray() as Promise<T[]>;
  }
}

export const defaultSaveRepository = new SaveRepository();
