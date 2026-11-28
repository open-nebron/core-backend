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

export interface CommentReactionDocument {
  _id?: any;
  commentId: ObjectId;
  emoji: string;
  userId: string;
  createdAt: Date;
}

export interface CommentThreadDepthDocument {
  _id: ObjectId;
  commentId: ObjectId;
  postId: ObjectId;
  targetType?: 'post' | 'reel';
  depth: number;
  authorId: string;
  createdAt: Date;
}

export type EngagementEventType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'reaction'
  | 'save'
  | 'share'
  | 'view_long'
  | 'dm_share';

export interface EngagementEventDocument {
  _id?: any;
  contentType: AnalyticsContentType;
  contentId: string;
  userId: string;
  event: EngagementEventType;
  emoji?: string;
  refId?: string;
  at: Date;
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

export type AnalyticsContentType = 'post' | 'reel' | 'story';
export type AnalyticsSource = 'feed' | 'profile' | 'explore' | 'shared' | 'hashtag' | 'recommendations';
export type FollowSourceType = 'profile' | 'feed' | 'reel' | 'search' | 'suggestion' | 'other';

export interface UnfollowEventDocument {
  _id?: any;
  followerId: string;
  followingId: string;
  at: Date;
}

export interface ImpressionDocument {
  _id?: any;
  userId: string;
  contentType: AnalyticsContentType;
  contentId: string;
  source: AnalyticsSource;
  seenAt: Date;
}

export interface ContentViewDocument {
  _id?: any;
  userId: string;
  contentType: 'post' | 'reel' | 'story';
  contentId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  watchedSeconds: number;
  totalSeconds: number;
  completed: boolean;
  source: string;
  tapsForward?: number;
  tapsBack?: number;
  exited?: boolean;
  replayed?: boolean;
}

export interface ProfileVisitDocument {
  _id?: any;
  visitorId: string;
  visitedUserId: string;
  at: Date;
}

export interface FollowSourceDocument {
  _id?: any;
  followerId: string;
  followingId: string;
  source: FollowSourceType;
  at: Date;
}

export interface ShareEventDocument {
  _id?: any;
  contentType: 'post' | 'reel' | 'comment';
  contentId: string;
  byUserId: string;
  at: Date;
}

export interface AnalyticsDailyDocument {
  _id?: any;
  contentType: AnalyticsContentType;
  contentId: string;
  authorId: string;
  preview?: string;
  contentCreatedAt?: Date;
  date: string; // 'YYYY-MM-DD'
  impressions: number;
  reach: number;
  views: number;
  uniqueViews: number;
  watchSeconds: number;
  completions: number;
  tapsForward: number;
  tapsBack: number;
  exits: number;
  replays: number;
  likes: number;
  comments: number;
  replies: number;
  shares: number;
  saves: number;
  profileVisits: number;
  newFollowers: number;
  updatedAt: Date;
}

export interface CreatorDailyStatsDocument {
  _id?: any;
  userId: string;
  date: string; // 'YYYY-MM-DD'
  totalFollowers: number;
  followersGained: number;
  totalLikesReceived: number;
  totalViews: number;
  totalImpressions: number;
  totalReach: number;
  totalCommentsReceived: number;
  totalSharesReceived: number;
  totalSavesReceived: number;
  profileVisits: number;
  postsCreated: number;
  reelsCreated: number;
  storiesCreated: number;
  updatedAt: Date;
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

  // V4-4 Analytics Collections & Retention TTL Indexes
  const ttlSeconds = env.DECISION_ANALYTICS_RETENTION === '90d-raw' ? 90 * 24 * 60 * 60 : undefined;

  const ensureSafeIndex = async (
    col: Collection<any>,
    keys: Record<string, 1 | -1>,
    options: Record<string, unknown>
  ) => {
    try {
      await col.createIndex(keys, options as any);
    } catch (err: any) {
      if (err?.code === 85 || err?.code === 86) {
        if (options.name) {
          await col.dropIndex(String(options.name)).catch(() => {});
        }
        await col.createIndex(keys, options as any);
      } else {
        throw err;
      }
    }
  };

  const impressions = database.collection<ImpressionDocument>('impressions');
  await ensureSafeIndex(
    impressions,
    { seenAt: 1 },
    ttlSeconds !== undefined
      ? { expireAfterSeconds: ttlSeconds, name: 'idx_impressions_seenAt_ttl' }
      : { name: 'idx_impressions_seenAt' }
  );
  await impressions.createIndex({ contentId: 1, seenAt: 1 }, { name: 'idx_impressions_contentId_seenAt' });
  await impressions.createIndex({ userId: 1, seenAt: 1 }, { name: 'idx_impressions_userId_seenAt' });

  const contentViews = database.collection<ContentViewDocument>('content_views');
  await ensureSafeIndex(
    contentViews,
    { startedAt: 1 },
    ttlSeconds !== undefined
      ? { expireAfterSeconds: ttlSeconds, name: 'idx_content_views_startedAt_ttl' }
      : { name: 'idx_content_views_startedAt' }
  );
  await contentViews.createIndex({ contentId: 1, startedAt: 1 }, { name: 'idx_content_views_contentId_startedAt' });
  await contentViews.createIndex({ userId: 1, startedAt: 1 }, { name: 'idx_content_views_userId_startedAt' });

  const profileVisits = database.collection<ProfileVisitDocument>('profile_visits');
  await ensureSafeIndex(
    profileVisits,
    { at: 1 },
    ttlSeconds !== undefined
      ? { expireAfterSeconds: ttlSeconds, name: 'idx_profile_visits_at_ttl' }
      : { name: 'idx_profile_visits_at' }
  );
  await profileVisits.createIndex({ visitedUserId: 1, at: -1 }, { name: 'idx_profile_visits_visitedUserId_at' });

  const followSources = database.collection<FollowSourceDocument>('follow_sources');
  await followSources.createIndex({ followingId: 1, at: -1 }, { name: 'idx_follow_sources_followingId_at' });
  await followSources.createIndex({ followerId: 1, followingId: 1 }, { name: 'idx_follow_sources_pair' });

  const unfollowEvents = database.collection<UnfollowEventDocument>('unfollow_events');
  await unfollowEvents.createIndex({ followingId: 1, at: -1 }, { name: 'idx_unfollow_events_followingId_at' });
  await unfollowEvents.createIndex({ followerId: 1, followingId: 1 }, { name: 'idx_unfollow_events_pair' });

  const shareEvents = database.collection<ShareEventDocument>('share_events');
  await ensureSafeIndex(
    shareEvents,
    { at: 1 },
    ttlSeconds !== undefined
      ? { expireAfterSeconds: ttlSeconds, name: 'idx_share_events_at_ttl' }
      : { name: 'idx_share_events_at' }
  );
  await shareEvents.createIndex({ contentType: 1, contentId: 1, at: 1 }, { name: 'idx_share_events_content_at' });

  const analyticsDaily = database.collection<AnalyticsDailyDocument>('analytics_daily');
  await analyticsDaily.createIndex(
    { contentType: 1, contentId: 1, date: 1 },
    { unique: true, name: 'idx_analytics_daily_unique' }
  );
  await analyticsDaily.createIndex({ authorId: 1, date: 1 }, { name: 'idx_analytics_daily_author_date' });

  const creatorDailyStats = database.collection<CreatorDailyStatsDocument>('creator_daily_stats');
  await creatorDailyStats.createIndex(
    { userId: 1, date: 1 },
    { unique: true, name: 'idx_creator_daily_stats_unique' }
  );

  // V4.5-1 Collections: comment_reactions, comment_thread_depth, engagement_events
  const commentReactions = database.collection<CommentReactionDocument>('comment_reactions');
  await commentReactions.createIndex(
    { commentId: 1, emoji: 1, userId: 1 },
    { unique: true, name: 'idx_comment_reactions_unique' }
  );
  await commentReactions.createIndex({ commentId: 1 }, { name: 'idx_comment_reactions_commentId' });

  const commentThreadDepth = database.collection<CommentThreadDepthDocument>('comment_thread_depth');
  await commentThreadDepth.createIndex(
    { postId: 1, depth: 1 },
    { name: 'idx_comment_thread_depth_postId_depth' }
  );
  await commentThreadDepth.createIndex(
    { authorId: 1, createdAt: -1 },
    { name: 'idx_comment_thread_depth_authorId_createdAt' }
  );

  const engagementEvents = database.collection<EngagementEventDocument>('engagement_events');
  await ensureSafeIndex(
    engagementEvents,
    { at: 1 },
    ttlSeconds !== undefined
      ? { expireAfterSeconds: ttlSeconds, name: 'idx_engagement_events_at_ttl' }
      : { name: 'idx_engagement_events_at' }
  );
  await engagementEvents.createIndex(
    { contentType: 1, contentId: 1, event: 1, at: -1 },
    { name: 'idx_engagement_events_content_event_at' }
  );
  await engagementEvents.createIndex(
    { contentType: 1, contentId: 1, at: 1 },
    { name: 'idx_engagement_events_content_at' }
  );
  await engagementEvents.createIndex(
    { userId: 1, at: -1 },
    { name: 'idx_engagement_events_userId_at' }
  );
  await engagementEvents.createIndex(
    { refId: 1 },
    { unique: true, sparse: true, name: 'idx_engagement_events_refId_unique' }
  );
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

export function getImpressionsCollection(dbInstance?: Db): Collection<ImpressionDocument> {
  return (dbInstance ?? getDb()).collection<ImpressionDocument>('impressions');
}

export function getContentViewsCollection(dbInstance?: Db): Collection<ContentViewDocument> {
  return (dbInstance ?? getDb()).collection<ContentViewDocument>('content_views');
}

export function getProfileVisitsCollection(dbInstance?: Db): Collection<ProfileVisitDocument> {
  return (dbInstance ?? getDb()).collection<ProfileVisitDocument>('profile_visits');
}

export function getFollowSourcesCollection(dbInstance?: Db): Collection<FollowSourceDocument> {
  return (dbInstance ?? getDb()).collection<FollowSourceDocument>('follow_sources');
}

export function getUnfollowEventsCollection(dbInstance?: Db): Collection<UnfollowEventDocument> {
  return (dbInstance ?? getDb()).collection<UnfollowEventDocument>('unfollow_events');
}

export function getShareEventsCollection(dbInstance?: Db): Collection<ShareEventDocument> {
  return (dbInstance ?? getDb()).collection<ShareEventDocument>('share_events');
}

export function getAnalyticsDailyCollection(dbInstance?: Db): Collection<AnalyticsDailyDocument> {
  return (dbInstance ?? getDb()).collection<AnalyticsDailyDocument>('analytics_daily');
}

export function getCreatorDailyStatsCollection(dbInstance?: Db): Collection<CreatorDailyStatsDocument> {
  return (dbInstance ?? getDb()).collection<CreatorDailyStatsDocument>('creator_daily_stats');
}

export function getCommentReactionsCollection(dbInstance?: Db): Collection<CommentReactionDocument> {
  return (dbInstance ?? getDb()).collection<CommentReactionDocument>('comment_reactions');
}

export function getCommentThreadDepthCollection(dbInstance?: Db): Collection<CommentThreadDepthDocument> {
  return (dbInstance ?? getDb()).collection<CommentThreadDepthDocument>('comment_thread_depth');
}

export function getEngagementEventsCollection(dbInstance?: Db): Collection<EngagementEventDocument> {
  return (dbInstance ?? getDb()).collection<EngagementEventDocument>('engagement_events');
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
