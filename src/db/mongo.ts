import { MongoClient, Db, Collection, ClientSession, type ObjectId } from 'mongodb';
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
  mentions?: string[];
  hashtags?: string[];
  likeCount: number;
  commentCount: number;
  saveCount?: number;
  shareCount?: number;
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
  targetType?: 'post' | 'reel';
  postId?: any;
  reelId?: any;
  authorId: string;
  body: string;
  parentCommentId?: ObjectId | null;
  replyToUserId?: string | null;
  likeCount?: number;
  replyCount?: number;
  saveCount?: number;
  shareCount?: number;
  pinned?: boolean;
  pinnedAt?: Date | null;
  editedAt?: Date | null;
  mentions?: string[];
  hashtags?: string[];
  deleted: boolean;
  createdAt: Date;
}

export interface SavedPostDocument {
  _id?: any;
  userId: string;
  postId: any;
  savedAt: Date;
}

export interface SavedReelDocument {
  _id?: any;
  userId: string;
  reelId: any;
  savedAt: Date;
}

export interface SavedCommentDocument {
  _id?: any;
  userId: string;
  commentId: any;
  savedAt: Date;
}

export interface HashtagDocument {
  _id: string;
  tag: string;
  firstPostId: string;
  createdAt: Date;
}

export interface CommentLikeDocument {
  _id?: any;
  commentId: any;
  userId: string;
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

export interface StoryViewerEntry {
  userId: string;
  viewedAt: Date;
}

export interface StoryDocument {
  _id?: any;
  authorId: string;
  mediaType: 'image' | 'video';
  mediaKey: string;
  mediaUrl: string;
  thumbnailKey: string | null;
  duration: number;
  caption: string | null;
  viewers: StoryViewerEntry[];
  viewerCount?: number;
  authorViewed?: boolean;
  expiresAt: Date;
  createdAt: Date;
}

export interface ReelDocument {
  _id?: any;
  authorId: string;
  caption: string | null;
  videoKey: string;
  videoUrl: string;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  duration: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  saveCount?: number;
  shareCount?: number;
  deleted: boolean;
  deletedAt?: Date | null;
  r2DeletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReelLikeDocument {
  _id?: any;
  reelId: any;
  userId: string;
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
    minPoolSize: 1,
    family: 4,
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
  await posts.createIndex(
    { hashtags: 1, deleted: 1, createdAt: -1 },
    { name: 'idx_posts_hashtags_deleted_createdAt' }
  );

  const postLikes = database.collection<PostLikeDocument>('post_likes');
  await postLikes.createIndex({ postId: 1, userId: 1 }, { unique: true, name: 'idx_post_likes_postId_userId_unique' });
  await postLikes.createIndex({ userId: 1 }, { name: 'idx_post_likes_userId' });

  const comments = database.collection<CommentDocument>('comments');
  await comments.createIndex({ postId: 1, createdAt: 1 }, { name: 'idx_comments_postId_createdAt' });
  await comments.createIndex(
    { postId: 1, parentCommentId: 1, createdAt: 1 },
    { name: 'idx_comments_postId_parent_createdAt' }
  );
  await comments.createIndex(
    { postId: 1, parentCommentId: 1, likeCount: -1 },
    { name: 'idx_comments_postId_parent_likeCount' }
  );
  await comments.createIndex(
    { postId: 1, parentCommentId: 1, pinned: -1, pinnedAt: 1, likeCount: -1, createdAt: -1 },
    { name: 'idx_comments_postId_parent_pinned_top' }
  );
  await comments.createIndex(
    { postId: 1, parentCommentId: 1, pinned: -1, pinnedAt: 1, createdAt: -1 },
    { name: 'idx_comments_postId_parent_pinned_new' }
  );
  await comments.createIndex({ reelId: 1, createdAt: 1 }, { sparse: true, name: 'idx_comments_reelId_createdAt' });
  await comments.createIndex(
    { reelId: 1, parentCommentId: 1, createdAt: 1 },
    { sparse: true, name: 'idx_comments_reelId_parent_createdAt' }
  );
  await comments.createIndex(
    { reelId: 1, parentCommentId: 1, likeCount: -1 },
    { sparse: true, name: 'idx_comments_reelId_parent_likeCount' }
  );
  await comments.createIndex(
    { parentCommentId: 1, createdAt: 1 },
    { sparse: true, name: 'idx_comments_parentCommentId_createdAt' }
  );
  await comments.createIndex({ authorId: 1 }, { name: 'idx_comments_authorId' });

  const commentLikes = database.collection<CommentLikeDocument>('comment_likes');
  await commentLikes.createIndex(
    { commentId: 1, userId: 1 },
    { unique: true, name: 'idx_comment_likes_commentId_userId_unique' }
  );
  await commentLikes.createIndex({ userId: 1 }, { name: 'idx_comment_likes_userId' });

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

  const stories = database.collection<StoryDocument>('stories');
  await stories.createIndex({ authorId: 1, expiresAt: -1 }, { name: 'idx_stories_authorId_expiresAt' });
  await stories.createIndex({ expiresAt: 1 }, { name: 'idx_stories_expiresAt' });

  const reels = database.collection<ReelDocument>('reels');
  await reels.createIndex({ authorId: 1, deleted: 1, createdAt: -1 }, { name: 'idx_reels_authorId_deleted_createdAt' });
  await reels.createIndex({ deleted: 1, createdAt: -1 }, { name: 'idx_reels_deleted_createdAt' });
  await reels.createIndex({ deleted: 1, r2DeletedAt: 1 }, { name: 'idx_reels_deleted_r2DeletedAt' });

  const reelLikes = database.collection<ReelLikeDocument>('reel_likes');
  await reelLikes.createIndex({ reelId: 1, userId: 1 }, { unique: true, name: 'idx_reel_likes_reelId_userId_unique' });
  await reelLikes.createIndex({ userId: 1 }, { name: 'idx_reel_likes_userId' });

  // Migration: rename any legacy profilePicUrl field
  try {
    await profiles.updateMany(
      { profilePicUrl: { $exists: true } } as any,
      { $unset: { profilePicUrl: '' } } as any
    );
  } catch {
    // Ignore migration error if already migrated
  }

  // V4-1 Migration: backfill threading and like counters on comments (run once)
  try {
    const migrations = database.collection('migrations');
    const migrationId = 'v4_1_comments_threading';
    const migrated = await migrations.findOne({ _id: migrationId as any });
    if (!migrated) {
      await comments.updateMany(
        { parentCommentId: { $exists: false } } as any,
        { $set: { parentCommentId: null, likeCount: 0, replyCount: 0 } } as any
      );
      await comments.updateMany(
        { likeCount: { $exists: false } } as any,
        { $set: { likeCount: 0 } } as any
      );
      await comments.updateMany(
        { replyCount: { $exists: false } } as any,
        { $set: { replyCount: 0 } } as any
      );
      await migrations.updateOne(
        { _id: migrationId as any },
        { $setOnInsert: { _id: migrationId, appliedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch {
    // Ignore migration error if already migrated concurrently
  }

  const hashtags = database.collection<HashtagDocument>('hashtags');
  await hashtags.createIndex({ createdAt: -1 }, { name: 'idx_hashtags_createdAt' });

  // V4-2 Migration: backfill pinned/editedAt/mentions/hashtags on comments and posts (run once)
  try {
    const migrations = database.collection('migrations');
    const migrationId = 'v4_2_comments_posts_advanced';
    const migrated = await migrations.findOne({ _id: migrationId as any });
    if (!migrated) {
      await comments.updateMany(
        { pinned: { $exists: false } } as any,
        { $set: { pinned: false, pinnedAt: null, editedAt: null } } as any
      );
      await comments.updateMany(
        { editedAt: { $exists: false } } as any,
        { $set: { editedAt: null } } as any
      );
      await comments.updateMany(
        { pinnedAt: { $exists: false } } as any,
        { $set: { pinnedAt: null } } as any
      );
      await comments.updateMany(
        { mentions: { $exists: false } } as any,
        { $set: { mentions: [] } } as any
      );
      await comments.updateMany(
        { hashtags: { $exists: false } } as any,
        { $set: { hashtags: [] } } as any
      );
      await posts.updateMany(
        { mentions: { $exists: false } } as any,
        { $set: { mentions: [] } } as any
      );
      await posts.updateMany(
        { hashtags: { $exists: false } } as any,
        { $set: { hashtags: [] } } as any
      );
      await migrations.updateOne(
        { _id: migrationId as any },
        { $setOnInsert: { _id: migrationId, appliedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch {
    // Ignore migration error if already migrated concurrently
  }

  // V4-3 Collections & Migration: saved_posts, saved_reels, saved_comments + saveCount/shareCount
  const savedPosts = database.collection<SavedPostDocument>('saved_posts');
  await savedPosts.createIndex({ userId: 1, savedAt: -1 }, { name: 'idx_saved_posts_userId_savedAt' });
  await savedPosts.createIndex({ userId: 1, postId: 1 }, { unique: true, name: 'idx_saved_posts_userId_postId_unique' });

  const savedReels = database.collection<SavedReelDocument>('saved_reels');
  await savedReels.createIndex({ userId: 1, savedAt: -1 }, { name: 'idx_saved_reels_userId_savedAt' });
  await savedReels.createIndex({ userId: 1, reelId: 1 }, { unique: true, name: 'idx_saved_reels_userId_reelId_unique' });

  const savedComments = database.collection<SavedCommentDocument>('saved_comments');
  await savedComments.createIndex({ userId: 1, savedAt: -1 }, { name: 'idx_saved_comments_userId_savedAt' });
  await savedComments.createIndex(
    { userId: 1, commentId: 1 },
    { unique: true, name: 'idx_saved_comments_userId_commentId_unique' }
  );

  try {
    const migrations = database.collection('migrations');
    const migrationId = 'v4_3_saves_and_shares';
    const migrated = await migrations.findOne({ _id: migrationId as any });
    if (!migrated) {
      for (const col of [posts, reels, comments]) {
        await col.updateMany(
          { saveCount: { $exists: false } } as any,
          { $set: { saveCount: 0 } } as any
        );
        await col.updateMany(
          { shareCount: { $exists: false } } as any,
          { $set: { shareCount: 0 } } as any
        );
      }
      await migrations.updateOne(
        { _id: migrationId as any },
        { $setOnInsert: { _id: migrationId, appliedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch {
    // Ignore migration error if already migrated concurrently
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

export function getCommentLikesCollection(dbInstance?: Db): Collection<CommentLikeDocument> {
  return (dbInstance ?? getDb()).collection<CommentLikeDocument>('comment_likes');
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

export function getStoriesCollection(dbInstance?: Db): Collection<StoryDocument> {
  return (dbInstance ?? getDb()).collection<StoryDocument>('stories');
}

export function getReelsCollection(dbInstance?: Db): Collection<ReelDocument> {
  return (dbInstance ?? getDb()).collection<ReelDocument>('reels');
}

export function getReelLikesCollection(dbInstance?: Db): Collection<ReelLikeDocument> {
  return (dbInstance ?? getDb()).collection<ReelLikeDocument>('reel_likes');
}

export function getHashtagsCollection(dbInstance?: Db): Collection<HashtagDocument> {
  return (dbInstance ?? getDb()).collection<HashtagDocument>('hashtags');
}

export function getSavedPostsCollection(dbInstance?: Db): Collection<SavedPostDocument> {
  return (dbInstance ?? getDb()).collection<SavedPostDocument>('saved_posts');
}

export function getSavedReelsCollection(dbInstance?: Db): Collection<SavedReelDocument> {
  return (dbInstance ?? getDb()).collection<SavedReelDocument>('saved_reels');
}

export function getSavedCommentsCollection(dbInstance?: Db): Collection<SavedCommentDocument> {
  return (dbInstance ?? getDb()).collection<SavedCommentDocument>('saved_comments');
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
