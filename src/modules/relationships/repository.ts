import type { Collection, Db, ObjectId } from 'mongodb';
import { getDb } from '../../db/mongo.js';

export interface RelationshipDocument {
  _id?: ObjectId;
  fromUserId: string;
  toUserId: string;
  blocked: boolean;
  muteCalls: boolean;
  muteMessages: boolean;
  muteUntil: Date | null;
  updatedAt: Date;
}

export class RelationshipRepository {
  private customDb?: Db;

  constructor(customDb?: Db) {
    this.customDb = customDb;
  }

  private getCollection(): Collection<RelationshipDocument> {
    const db = this.customDb ?? getDb();
    return db.collection<RelationshipDocument>('relationships');
  }

  async initIndexes(): Promise<void> {
    const col = this.getCollection();
    await col.createIndex(
      { fromUserId: 1, toUserId: 1 },
      { unique: true, name: 'idx_relationships_from_to_unique' }
    );
    await col.createIndex(
      { fromUserId: 1, blocked: 1 },
      { name: 'idx_relationships_from_blocked' }
    );
  }

  async findByUserPair(fromUserId: string, toUserId: string): Promise<RelationshipDocument | null> {
    return this.getCollection().findOne({ fromUserId, toUserId });
  }

  async findMultiple(
    fromUserId: string | null,
    toUserIds: string[]
  ): Promise<RelationshipDocument[]> {
    if (toUserIds.length === 0) return [];

    if (fromUserId) {
      return this.getCollection()
        .find({
          fromUserId,
          toUserId: { $in: toUserIds },
        })
        .toArray();
    }

    return this.getCollection()
      .find({
        toUserId: { $in: toUserIds },
      })
      .toArray();
  }

  async upsertBlock(fromUserId: string, toUserId: string, blocked: boolean): Promise<void> {
    await this.getCollection().updateOne(
      { fromUserId, toUserId },
      {
        $set: {
          blocked,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          muteCalls: false,
          muteMessages: false,
          muteUntil: null,
        },
      },
      { upsert: true }
    );
  }

  async upsertMute(
    fromUserId: string,
    toUserId: string,
    mute: { calls: boolean; messages: boolean; until: Date | null }
  ): Promise<void> {
    await this.getCollection().updateOne(
      { fromUserId, toUserId },
      {
        $set: {
          muteCalls: mute.calls,
          muteMessages: mute.messages,
          muteUntil: mute.until,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          blocked: false,
        },
      },
      { upsert: true }
    );
  }

  async clearMute(fromUserId: string, toUserId: string): Promise<void> {
    await this.getCollection().updateOne(
      { fromUserId, toUserId },
      {
        $set: {
          muteCalls: false,
          muteMessages: false,
          muteUntil: null,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          blocked: false,
        },
      },
      { upsert: true }
    );
  }
}

export const defaultRelationshipRepository = new RelationshipRepository();
