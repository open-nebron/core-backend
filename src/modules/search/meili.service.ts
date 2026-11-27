import { Meilisearch } from 'meilisearch';
import { ObjectId, type Db } from 'mongodb';
import { env } from '../../config/env.js';
import {
  getDb,
  getPostsCollection,
  getProfilesCollection,
  getReelsCollection,
} from '../../db/mongo.js';

export interface IndexedPostDocument {
  id: string;
  authorId: string;
  body: string;
  hashtags: string[];
  createdAtMs: number;
  likeCount: number;
}

export interface IndexedReelDocument {
  id: string;
  authorId: string;
  caption: string;
  hashtags: string[];
  createdAtMs: number;
  likeCount: number;
  viewCount: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractSocialHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.matchAll(/#([a-zA-Z0-9_]{1,50})\b/g);
  const seen = new Set<string>();
  for (const m of matches) {
    seen.add(m[1].toLowerCase());
  }
  return Array.from(seen);
}

export interface SocialSearchServiceOptions {
  host?: string;
  apiKey?: string;
  client?: Meilisearch;
  db?: Db;
}

/**
 * Manages Meilisearch indexing and searching for social posts and reels with Mongo fallback.
 */
export class SocialSearchService {
  private readonly host: string;
  private readonly apiKey: string;
  private clientOverride?: Meilisearch;
  private dbOverride?: Db;
  private cachedClient: Meilisearch | null = null;
  private indexesReady = false;

  constructor(options: SocialSearchServiceOptions = {}) {
    this.host = options.host ?? env.MEILI_HOST;
    this.apiKey = options.apiKey ?? env.MEILI_MASTER_KEY;
    this.clientOverride = options.client;
    this.dbOverride = options.db;
  }

  private getClient(): Meilisearch {
    if (this.clientOverride) return this.clientOverride;
    if (!this.cachedClient) {
      this.cachedClient = new Meilisearch({ host: this.host, apiKey: this.apiKey });
    }
    return this.cachedClient;
  }

  private db(): Db {
    return this.dbOverride ?? getDb();
  }

  async initIndexes(): Promise<void> {
    if (this.indexesReady) return;
    const client = this.getClient();
    try {
      try {
        await client.createIndex('posts', { primaryKey: 'id' });
      } catch {
        // Ignore if index already exists
      }
      await client.index('posts').updateSettings({
        searchableAttributes: ['body', 'hashtags'],
        filterableAttributes: ['authorId', 'hashtags', 'createdAtMs'],
        sortableAttributes: ['createdAtMs', 'likeCount'],
      });

      try {
        await client.createIndex('reels', { primaryKey: 'id' });
      } catch {
        // Ignore if index already exists
      }
      await client.index('reels').updateSettings({
        searchableAttributes: ['caption', 'hashtags'],
        filterableAttributes: ['authorId', 'hashtags', 'createdAtMs'],
        sortableAttributes: ['createdAtMs', 'viewCount', 'likeCount'],
      });

      this.indexesReady = true;
    } catch (err: any) {
      console.warn('[SocialSearch] Meilisearch init skipped:', err?.message || err);
    }
  }

  async indexPost(doc: {
    id: string;
    authorId: string;
    body: string;
    hashtags?: string[];
    createdAt: Date | string | number;
    likeCount?: number;
  }): Promise<void> {
    try {
      const client = this.getClient();
      const createdAtMs =
        typeof doc.createdAt === 'number'
          ? doc.createdAt
          : doc.createdAt instanceof Date
            ? doc.createdAt.getTime()
            : new Date(doc.createdAt).getTime();

      const item: IndexedPostDocument = {
        id: doc.id,
        authorId: doc.authorId,
        body: doc.body,
        hashtags: doc.hashtags ?? extractSocialHashtags(doc.body),
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
        likeCount: doc.likeCount ?? 0,
      };
      const task = await client.index('posts').addDocuments([item]);
      if (process.env.NODE_ENV === 'test' && task?.taskUid !== undefined) {
        await client.tasks.waitForTask(task.taskUid, { timeout: 5000 }).catch(() => {});
      }
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[SocialSearch] indexPost failed:', err?.message || err);
      }
    }
  }

  async updatePost(postId: string, body: string, hashtags?: string[]): Promise<void> {
    try {
      const client = this.getClient();
      const partial = {
        id: postId,
        body,
        hashtags: hashtags ?? extractSocialHashtags(body),
      };
      const task = await client.index('posts').updateDocuments([partial]);
      if (process.env.NODE_ENV === 'test' && task?.taskUid !== undefined) {
        await client.tasks.waitForTask(task.taskUid, { timeout: 5000 }).catch(() => {});
      }
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[SocialSearch] updatePost failed:', err?.message || err);
      }
    }
  }

  async deletePost(postId: string): Promise<void> {
    try {
      const client = this.getClient();
      const task = await client.index('posts').deleteDocument(postId);
      if (process.env.NODE_ENV === 'test' && task?.taskUid !== undefined) {
        await client.tasks.waitForTask(task.taskUid, { timeout: 5000 }).catch(() => {});
      }
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[SocialSearch] deletePost failed:', err?.message || err);
      }
    }
  }

  async indexReel(doc: {
    id: string;
    authorId: string;
    caption: string | null;
    hashtags?: string[];
    createdAt: Date | string | number;
    likeCount?: number;
    viewCount?: number;
  }): Promise<void> {
    try {
      const client = this.getClient();
      const createdAtMs =
        typeof doc.createdAt === 'number'
          ? doc.createdAt
          : doc.createdAt instanceof Date
            ? doc.createdAt.getTime()
            : new Date(doc.createdAt).getTime();

      const item: IndexedReelDocument = {
        id: doc.id,
        authorId: doc.authorId,
        caption: doc.caption ?? '',
        hashtags: doc.hashtags ?? extractSocialHashtags(doc.caption),
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
        likeCount: doc.likeCount ?? 0,
        viewCount: doc.viewCount ?? 0,
      };
      const task = await client.index('reels').addDocuments([item]);
      if (process.env.NODE_ENV === 'test' && task?.taskUid !== undefined) {
        await client.tasks.waitForTask(task.taskUid, { timeout: 5000 }).catch(() => {});
      }
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[SocialSearch] indexReel failed:', err?.message || err);
      }
    }
  }

  async deleteReel(reelId: string): Promise<void> {
    try {
      const client = this.getClient();
      const task = await client.index('reels').deleteDocument(reelId);
      if (process.env.NODE_ENV === 'test' && task?.taskUid !== undefined) {
        await client.tasks.waitForTask(task.taskUid, { timeout: 5000 }).catch(() => {});
      }
    } catch (err: any) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[SocialSearch] deleteReel failed:', err?.message || err);
      }
    }
  }

  async backfillMissing(limit: number = 500): Promise<void> {
    try {
      await this.initIndexes();
      const database = this.db();
      const client = this.getClient();

      const [posts, reels] = await Promise.all([
        getPostsCollection(database)
          .find({ deleted: false })
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray(),
        getReelsCollection(database)
          .find({ deleted: false })
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray(),
      ]);

      if (posts.length > 0) {
        const docs: IndexedPostDocument[] = posts.map((p) => ({
          id: p._id.toString(),
          authorId: p.authorId,
          body: p.body,
          hashtags: p.hashtags ?? extractSocialHashtags(p.body),
          createdAtMs: (p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt)).getTime(),
          likeCount: p.likeCount ?? 0,
        }));
        await client.index('posts').addDocuments(docs);
      }

      if (reels.length > 0) {
        const docs: IndexedReelDocument[] = reels.map((r) => ({
          id: r._id.toString(),
          authorId: r.authorId,
          caption: r.caption ?? '',
          hashtags: extractSocialHashtags(r.caption),
          createdAtMs: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).getTime(),
          likeCount: r.likeCount ?? 0,
          viewCount: r.viewCount ?? 0,
        }));
        await client.index('reels').addDocuments(docs);
      }
    } catch (err: any) {
      console.warn('[SocialSearch] backfill skipped:', err?.message || err);
    }
  }

  async searchPostIds(
    rawQuery: string,
    excludeAuthorIds: Set<string>,
    limit: number = 20
  ): Promise<string[]> {
    const q = rawQuery.trim();
    if (!q) return [];
    const database = this.db();

    try {
      const client = this.getClient();
      const res = await client.index('posts').search<IndexedPostDocument>(q, {
        limit: limit * 4,
      });
      const candidateIds: string[] = [];
      for (const hit of res.hits ?? []) {
        if (hit.authorId && excludeAuthorIds.has(hit.authorId)) continue;
        if (hit.id) candidateIds.push(hit.id);
      }
      if (candidateIds.length > 0 || !q.startsWith('#')) {
        // Filter out any banned authors or deleted docs via Mongo
        const oids = candidateIds
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));
        if (oids.length === 0) return [];
        const docs = await getPostsCollection(database)
          .find({ _id: { $in: oids }, deleted: false })
          .project({ _id: 1, authorId: 1 })
          .toArray();
        const validSet = new Set(
          docs.filter((d) => !excludeAuthorIds.has(d.authorId)).map((d) => d._id.toString())
        );
        return candidateIds.filter((id) => validSet.has(id)).slice(0, limit);
      }
    } catch {
      // Fallback gracefully to MongoDB regex when Meilisearch is unavailable (e.g. unit tests)
    }

    const strippedTag = q.startsWith('#') ? q.slice(1).toLowerCase() : null;
    const regex = new RegExp(escapeRegex(strippedTag ?? q), 'i');
    const excluded = Array.from(excludeAuthorIds);
    const filter: Record<string, unknown> = {
      deleted: false,
      ...(excluded.length > 0 ? { authorId: { $nin: excluded } } : {}),
      ...(strippedTag
        ? { $or: [{ hashtags: strippedTag }, { body: { $regex: regex } }] }
        : { $or: [{ body: { $regex: regex } }, { hashtags: q.toLowerCase() }] }),
    };

    const bannedProfiles = await getProfilesCollection(database)
      .find({ isBanned: true }, { projection: { userId: 1 } })
      .toArray();
    const bannedSet = new Set(bannedProfiles.map((p) => p.userId));

    const docs = await getPostsCollection(database)
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .toArray();

    return docs
      .filter((d) => !bannedSet.has(d.authorId))
      .slice(0, limit)
      .map((d) => d._id.toString());
  }

  async searchReelIds(
    rawQuery: string,
    excludeAuthorIds: Set<string>,
    limit: number = 20
  ): Promise<string[]> {
    const q = rawQuery.trim();
    if (!q) return [];
    const database = this.db();

    try {
      const client = this.getClient();
      const res = await client.index('reels').search<IndexedReelDocument>(q, {
        limit: limit * 4,
      });
      const candidateIds: string[] = [];
      for (const hit of res.hits ?? []) {
        if (hit.authorId && excludeAuthorIds.has(hit.authorId)) continue;
        if (hit.id) candidateIds.push(hit.id);
      }
      if (candidateIds.length > 0 || !q.startsWith('#')) {
        const oids = candidateIds
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));
        if (oids.length === 0) return [];
        const docs = await getReelsCollection(database)
          .find({ _id: { $in: oids }, deleted: false })
          .project({ _id: 1, authorId: 1 })
          .toArray();
        const validSet = new Set(
          docs.filter((d) => !excludeAuthorIds.has(d.authorId)).map((d) => d._id.toString())
        );
        return candidateIds.filter((id) => validSet.has(id)).slice(0, limit);
      }
    } catch {
      // Fallback to Mongo regex
    }

    const stripped = q.startsWith('#') ? q.slice(1) : q;
    const regex = new RegExp(escapeRegex(stripped), 'i');
    const excluded = Array.from(excludeAuthorIds);
    const docs = await getReelsCollection(database)
      .find({
        deleted: false,
        caption: { $regex: regex },
        ...(excluded.length > 0 ? { authorId: { $nin: excluded } } : {}),
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map((d) => d._id.toString());
  }
}

export const defaultSocialSearchService = new SocialSearchService();
