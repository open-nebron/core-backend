import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { PostRepository, defaultPostRepository } from './repository.js';
import { PostLikeRepository, defaultPostLikeRepository } from '../likes/repository.js';
import { FollowRepository, defaultFollowRepository } from '../follows/repository.js';
import {
  SocialEventPublisher,
  defaultSocialEventPublisher,
} from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import {
  getProfilesCollection,
  getDb,
  getMongoClient,
  runInTransaction,
  type ProfileDocument,
} from '../../../db/mongo.js';
import {
  NotFoundError,
  BlockedError,
  ForbiddenError,
  BadRequestError,
  NotPostAuthorError,
} from '../../../utils/errors.js';
import { computePublicUrl } from '../../../lib/r2.js';
import { sanitizePostBody } from '../validate.js';

export interface AuthorSummary {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface PostResponse {
  id: string;
  body: string;
  imageKey?: string | null;
  imageUrl?: string | null;
  likeCount: number;
  commentCount: number;
  likedByViewer: boolean;
  createdAt: string;
  author: AuthorSummary;
}

export class PostService {
  private repo: PostRepository;
  private likeRepo: PostLikeRepository;
  private followRepo: FollowRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: PostRepository,
    likeRepo?: PostLikeRepository,
    followRepo?: FollowRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient
  ) {
    this.repo = repo ?? (customDb ? new PostRepository(customDb) : defaultPostRepository);
    this.likeRepo = likeRepo ?? (customDb ? new PostLikeRepository(customDb) : defaultPostLikeRepository);
    this.followRepo = followRepo ?? (customDb ? new FollowRepository(customDb) : defaultFollowRepository);
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customClient = customClient;
  }

  private getProfilesCol() {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  private parseObjectId(id: string): ObjectId {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }
    return new ObjectId(id);
  }

  async createPost(authorId: string, rawBody: string): Promise<PostResponse> {
    const body = sanitizePostBody(rawBody);
    if (!body || body.length < 1) {
      throw new BadRequestError('Post body must not be empty', 'empty_body');
    }
    if (body.length > 500) {
      throw new BadRequestError('Post body cannot exceed 500 characters', 'body_too_long');
    }

    const now = new Date();
    let createdPost: any;

    await runInTransaction(this.customClient, async (session) => {
      createdPost = await this.repo.createPost(
        {
          authorId,
          body,
          imageKey: null,
          imageUrl: null,
          likeCount: 0,
          commentCount: 0,
          deleted: false,
          createdAt: now,
          updatedAt: now,
        },
        session
      );
      await this.repo.incrementProfilePostCount(authorId, session);
    });

    await this.publisher.publishPostCreated({
      postId: createdPost._id.toString(),
      authorId,
      body,
      hasImage: false,
      createdAt: now.toISOString(),
    });

    const authorProfile = await this.getProfilesCol().findOne({ userId: authorId });

    return {
      id: createdPost._id.toString(),
      body: createdPost.body,
      imageKey: null,
      imageUrl: null,
      likeCount: 0,
      commentCount: 0,
      likedByViewer: false,
      createdAt: now.toISOString(),
      author: {
        userId: authorId,
        username: authorProfile?.username || 'unknown',
        name: authorProfile?.name ?? null,
        avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
      },
    };
  }

  async getUserPosts(
    viewerId: string,
    targetUserId: string,
    limit: number = 20,
    before?: string
  ): Promise<PostResponse[]> {
    const isBlocked = await isBlockedPair(viewerId, targetUserId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const beforeDate = before ? new Date(before) : undefined;
    const posts = await this.repo.getUserPosts(targetUserId, limit, beforeDate);
    if (posts.length === 0) return [];

    const postIds = posts.map((p) => p._id);
    const likedSet = await this.likeRepo.hasLikedBatch(viewerId, postIds);

    const authorProfile = await this.getProfilesCol().findOne({ userId: targetUserId });
    const authorSummary: AuthorSummary = {
      userId: targetUserId,
      username: authorProfile?.username || 'unknown',
      name: authorProfile?.name ?? null,
      avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
    };

    return posts.map((p) => ({
      id: p._id.toString(),
      body: p.body,
      imageKey: p.imageKey ?? null,
      imageUrl: p.imageUrl ?? null,
      likeCount: p.likeCount ?? 0,
      commentCount: p.commentCount ?? 0,
      likedByViewer: likedSet.has(p._id.toString()),
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : new Date(p.createdAt).toISOString(),
      author: authorSummary,
    }));
  }

  async getPost(viewerId: string, postIdStr: string): Promise<PostResponse> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.repo.getPostById(postId);
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, post.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const liked = await this.likeRepo.findLike(postId, viewerId);
    const authorProfile = await this.getProfilesCol().findOne({ userId: post.authorId });

    return {
      id: post._id.toString(),
      body: post.body,
      imageKey: post.imageKey ?? null,
      imageUrl: post.imageUrl ?? null,
      likeCount: post.likeCount ?? 0,
      commentCount: post.commentCount ?? 0,
      likedByViewer: !!liked,
      createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : new Date(post.createdAt).toISOString(),
      author: {
        userId: post.authorId,
        username: authorProfile?.username || 'unknown',
        name: authorProfile?.name ?? null,
        avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
      },
    };
  }

  async deletePost(viewerId: string, postIdStr: string): Promise<void> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.repo.getPostById(postId);
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    if (post.authorId !== viewerId) {
      throw new NotPostAuthorError();
    }

    await runInTransaction(this.customClient, async (session) => {
      await this.repo.softDeletePost(postId, session);
      await this.repo.decrementProfilePostCount(post.authorId, session);
    });

    await this.publisher.publishPostDeleted({
      postId: postId.toString(),
      authorId: viewerId,
      at: new Date().toISOString(),
    });
  }

  async getFeed(
    viewerId: string,
    limit: number = 20,
    before?: string
  ): Promise<{ data: PostResponse[]; hasMore: boolean }> {
    const followingIds = await this.followRepo.getAllFollowingIds(viewerId);
    if (!followingIds || followingIds.length === 0) {
      return { data: [], hasMore: false };
    }

    const blockedIds = await getBlockedUserIds(viewerId, followingIds, this.customDb);
    const allowedIds = followingIds.filter((id) => !blockedIds.has(id));
    if (allowedIds.length === 0) {
      return { data: [], hasMore: false };
    }

    const beforeDate = before ? new Date(before) : undefined;
    const rawPosts = await this.repo.getFeedPosts(allowedIds, limit + 1, beforeDate);
    const hasMore = rawPosts.length > limit;
    const posts = hasMore ? rawPosts.slice(0, limit) : rawPosts;

    if (posts.length === 0) {
      return { data: [], hasMore: false };
    }

    const postIds = posts.map((p) => p._id);
    const likedSet = await this.likeRepo.hasLikedBatch(viewerId, postIds);

    const authorIds = Array.from(new Set(posts.map((p) => p.authorId)));
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: authorIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    const data: PostResponse[] = posts.map((p) => {
      const authorProfile = profileMap.get(p.authorId);
      return {
        id: p._id.toString(),
        body: p.body,
        imageKey: p.imageKey ?? null,
        imageUrl: p.imageUrl ?? null,
        likeCount: p.likeCount ?? 0,
        commentCount: p.commentCount ?? 0,
        likedByViewer: likedSet.has(p._id.toString()),
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : new Date(p.createdAt).toISOString(),
        author: {
          userId: p.authorId,
          username: authorProfile?.username || 'unknown',
          name: authorProfile?.name ?? null,
          avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
        },
      };
    });

    return { data, hasMore };
  }
}

export const defaultPostService = new PostService();
