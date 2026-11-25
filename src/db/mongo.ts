import { MongoClient, Db, Collection, ClientSession } from 'mongodb';
import { env } from '../config/env.js';

export type UserTheme = 'light' | 'dark' | 'system';
export type MessageRequestPolicy = 'everyone' | 'known' | 'nobody';
export type PrivacyVisibility = 'everyone' | 'contacts' | 'nobody';

export interface UserPrivacy {
  showOnlineStatus: PrivacyVisibility;
  showLastSeen: PrivacyVisibility;
  sendReadReceipts: boolean;
}

export const DEFAULT_PRIVACY: UserPrivacy = {
  showOnlineStatus: 'everyone',
  showLastSeen: 'contacts',
  sendReadReceipts: true,
};

export interface ProfileDocument {
  _id?: any;
  userId: string;
  username: string;
  email?: string | null;
  name: string | null;
  dateOfBirth: Date | string | null;
  about: string | null;
  bio: string | null;
  language: string;
  theme: UserTheme;
  messageRequestPolicy?: MessageRequestPolicy;
  privacy?: UserPrivacy;
  online?: boolean;
  lastSeenAt?: Date | string | null;
  avatarKey: string | null;
  bannerKey: string | null;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  isAdmin?: boolean;
  isBanned?: boolean;
  bannedAt?: Date | null;
  bannedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostDocument {
  _id?: any;
  authorId: string;
  body: string;
  imageKey: string | null;
  imageUrl: string | null;
  likeCount: number;
  commentCount: number;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostLikeDocument {
  _id?: any;
  postId: any;
  userId: string;
  createdAt: Date;
}

export interface CommentDocument {
  _id?: any;
  postId: any;
  authorId: string;
  body: string;
  deleted: boolean;
  createdAt: Date;
}

export interface FollowDocument {
  _id?: any;
  followerId: string;
  followingId: string;
  createdAt: Date;
}

export type ReportTargetType = 'user' | 'post' | 'comment' | 'message';
export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate'
  | 'sexual'
  | 'violence'
  | 'self_harm'
  | 'impersonation'
  | 'other';
export type ReportStatus = 'pending' | 'resolved' | 'dismissed';

export interface ReportDocument {
  _id?: any;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  targetOwnerId: string;
  reason: ReportReason;
  details?: string;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

export type AdminActionType =
  | 'dismiss_report'
  | 'resolve_report'
  | 'ban_user'
  | 'delete_post'
  | 'delete_comment'
  | 'warn_user';
export type AdminActionTargetType = 'user' | 'post' | 'comment' | 'report';

export interface AdminActionDocument {
  _id?: any;
  adminId: string;
  action: AdminActionType;
  targetType: AdminActionTargetType;
  targetId: string;
  details?: Record<string, any>;
  createdAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(url: string = env.MONGO_URL): Promise<{ client: MongoClient; db: Db }> {
  if (client && db) {
    return { client, db };
  }

  client = new MongoClient(url, {
    maxPoolSize: 20,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });

  await client.connect();
  db = client.db();

  await initMongoIndexes(db);

  return { client, db };
}

export async function initMongoIndexes(database: Db): Promise<void> {
  const profiles = database.collection<ProfileDocument>('profiles');

  await profiles.createIndex({ userId: 1 }, { unique: true, name: 'idx_profiles_userId_unique' });
  await profiles.createIndex({ username: 1 }, { unique: true, name: 'idx_profiles_username_unique' });
  // TODO: Add text index on name for user search when search module is implemented

  const relationships = database.collection('relationships');
  await relationships.createIndex(
    { fromUserId: 1, toUserId: 1 },
    { unique: true, name: 'idx_relationships_from_to_unique' }
  );
  await relationships.createIndex(
    { fromUserId: 1, blocked: 1 },
    { name: 'idx_relationships_from_blocked' }
  );

  const posts = database.collection<PostDocument>('posts');
  await posts.createIndex({ authorId: 1, createdAt: -1 }, { name: 'idx_posts_authorId_createdAt' });
  await posts.createIndex({ createdAt: -1 }, { name: 'idx_posts_createdAt' });
  await posts.createIndex({ deleted: 1, createdAt: -1 }, { name: 'idx_posts_deleted_createdAt' });

  const postLikes = database.collection<PostLikeDocument>('post_likes');
  await postLikes.createIndex({ postId: 1, userId: 1 }, { unique: true, name: 'idx_post_likes_postId_userId_unique' });
  await postLikes.createIndex({ userId: 1 }, { name: 'idx_post_likes_userId' });

  const comments = database.collection<CommentDocument>('comments');
  await comments.createIndex({ postId: 1, createdAt: 1 }, { name: 'idx_comments_postId_createdAt' });
  await comments.createIndex({ authorId: 1 }, { name: 'idx_comments_authorId' });

  const follows = database.collection<FollowDocument>('follows');
  await follows.createIndex({ followerId: 1, followingId: 1 }, { unique: true, name: 'idx_follows_follower_following_unique' });
  await follows.createIndex({ followingId: 1 }, { name: 'idx_follows_followingId' });

  const reports = database.collection<ReportDocument>('reports');
  await reports.createIndex({ status: 1, createdAt: -1 }, { name: 'idx_reports_status_createdAt' });
  await reports.createIndex({ targetType: 1, targetId: 1 }, { name: 'idx_reports_target' });
  await reports.createIndex({ reporterId: 1, createdAt: -1 }, { name: 'idx_reports_reporterId_createdAt' });

  const adminActions = database.collection<AdminActionDocument>('admin_actions');
  await adminActions.createIndex({ adminId: 1, createdAt: -1 }, { name: 'idx_admin_actions_adminId_createdAt' });
  await adminActions.createIndex({ targetType: 1, targetId: 1 }, { name: 'idx_admin_actions_target' });

  // Migration: rename any legacy profilePicUrl field
  try {
    await profiles.updateMany(
      { profilePicUrl: { $exists: true } } as any,
      { $unset: { profilePicUrl: '' } } as any
    );
  } catch {
    // Ignore migration error if already migrated
  }
}

export function getDb(): Db {
  if (!db) {
    throw new Error('MongoDB not initialized. Call connectMongo() first.');
  }
  return db;
}

export function getProfilesCollection(dbInstance?: Db): Collection<ProfileDocument> {
  return (dbInstance ?? getDb()).collection<ProfileDocument>('profiles');
}

export function getMongoClient(): MongoClient {
  if (!client) {
    throw new Error('MongoClient not initialized. Call connectMongo() first.');
  }
  return client;
}

export function getPostsCollection(dbInstance?: Db): Collection<PostDocument> {
  return (dbInstance ?? getDb()).collection<PostDocument>('posts');
}

export function getPostLikesCollection(dbInstance?: Db): Collection<PostLikeDocument> {
  return (dbInstance ?? getDb()).collection<PostLikeDocument>('post_likes');
}

export function getCommentsCollection(dbInstance?: Db): Collection<CommentDocument> {
  return (dbInstance ?? getDb()).collection<CommentDocument>('comments');
}

export function getFollowsCollection(dbInstance?: Db): Collection<FollowDocument> {
  const targetDb = dbInstance ?? db;
  if (!targetDb) {
    return {
      find: () => ({ toArray: async () => [] }),
      findOne: async () => null,
      updateOne: async () => ({ upsertedCount: 0 }),
      deleteOne: async () => ({ deletedCount: 0 }),
    } as any;
  }
  return targetDb.collection<FollowDocument>('follows');
}

export function getReportsCollection(dbInstance?: Db): Collection<ReportDocument> {
  return (dbInstance ?? getDb()).collection<ReportDocument>('reports');
}

export function getAdminActionsCollection(dbInstance?: Db): Collection<AdminActionDocument> {
  return (dbInstance ?? getDb()).collection<AdminActionDocument>('admin_actions');
}

export async function runInTransaction<T>(
  customClient: MongoClient | undefined,
  fn: (session?: ClientSession) => Promise<T>
): Promise<T> {
  const c = customClient ?? getMongoClient();
  const topologyType = (c as any).topology?.description?.type;
  const isReplicaSetOrSharded =
    topologyType === 'ReplicaSetWithPrimary' ||
    topologyType === 'ReplicaSetNoPrimary' ||
    topologyType === 'Sharded';

  if (!isReplicaSetOrSharded) {
    return await fn(undefined);
  }

  const session = c.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } catch (err: any) {
    if (
      err?.message?.includes('replica set') ||
      err?.message?.includes('Transaction numbers are only allowed') ||
      err?.message?.includes('does not support retryable writes') ||
      err?.originalError?.message?.includes('Transaction numbers')
    ) {
      return await fn(undefined);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function isMongoHealthy(): Promise<boolean> {
  try {
    if (!db) return false;
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
