import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { PostRepository, defaultPostRepository } from './repository.js';
import { PostLikeRepository, defaultPostLikeRepository } from '../likes/repository.js';
import { FollowRepository, defaultFollowRepository } from '../follows/repository.js';
import { CommentService, defaultCommentService, type CommentResponse } from '../comments/service.js';
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
import { computePublicUrl, isValidUserKey, headObject, deleteObject, ACCEPTED_IMAGE_TYPES } from '../../../lib/r2.js';
import { env } from '../../../config/env.js';
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
  comments?: CommentResponse[];
  createdAt: string;
  updatedAt?: string;
  author: AuthorSummary;
}

export class PostService {
  private repo: PostRepository;
  private likeRepo: PostLikeRepository;
  private followRepo: FollowRepository;
  private commentService: CommentService;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: PostRepository,
    likeRepo?: PostLikeRepository,
    followRepo?: FollowRepository,
    commentService?: CommentService,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient
  ) {
    this.repo = repo ?? (customDb ? new PostRepository(customDb) : defaultPostRepository);
    this.likeRepo = likeRepo ?? (customDb ? new PostLikeRepository(customDb) : defaultPostLikeRepository);
    this.followRepo = followRepo ?? (customDb ? new FollowRepository(customDb) : defaultFollowRepository);
    this.commentService = commentService ?? (customDb ? new CommentService(undefined, undefined, undefined, customDb, customClient) : defaultCommentService);
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

  async createPost(
    authorId: string,
    rawBody: string,
    imageKey?: string | null
  ): Promise<PostResponse> {
    const body = sanitizePostBody(rawBody);
    if (!body || body.length < 1) {
      throw new BadRequestError('Post body must not be empty', 'empty_body');
    }
    if (body.length > 500) {
      throw new BadRequestError('Post body cannot exceed 500 characters', 'body_too_long');
    }

    let finalImageKey: string | null = null;
    let finalImageUrl: string | null = null;

    if (imageKey) {
      if (!isValidUserKey(authorId, 'post', imageKey)) {
        throw new ForbiddenError(
          'Image key does not belong to the authenticated user',
          'forbidden'
        );
      }

      const meta = await headObject(imageKey);
      if (!meta) {
        throw new BadRequestError('Image does not exist in storage', 'object_not_found');
      }

      if (meta.contentLength > env.MAX_POST_IMAGE_BYTES) {
        throw new BadRequestError(
          `Image exceeds maximum allowed size of ${env.MAX_POST_IMAGE_BYTES} bytes`,
          'file_too_large'
        );
      }

      if (!ACCEPTED_IMAGE_TYPES.includes(meta.contentType as any)) {
        throw new BadRequestError(
          `Unsupported image content type: ${meta.contentType}`,
          'unsupported_media_type'
        );
      }

      finalImageKey = imageKey;
      finalImageUrl = computePublicUrl(imageKey);
    }

    const now = new Date();
    let createdPost: any;

    await runInTransaction(this.customClient, async (session) => {
      createdPost = await this.repo.createPost(
        {
          authorId,
          body,
          imageKey: finalImageKey,
          imageUrl: finalImageUrl,
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
      hasImage: Boolean(finalImageKey),
      createdAt: now.toISOString(),
    });

    const authorProfile = await this.getProfilesCol().findOne({ userId: authorId });

    return {
      id: createdPost._id.toString(),
      body: createdPost.body,
      imageKey: finalImageKey,
      imageUrl: finalImageUrl,
      likeCount: 0,
      commentCount: 0,
      likedByViewer: false,
      comments: [],
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
    const commentsMap = await this.commentService.getBatchRecentPreview(postIds, viewerId, 3);

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
      comments: commentsMap.get(p._id.toString()) || [],
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
    const commentsPreview = await this.commentService.getRecentPreview(postId, viewerId, 3);

    return {
      id: post._id.toString(),
      body: post.body,
      imageKey: post.imageKey ?? null,
      imageUrl: post.imageUrl ?? null,
      likeCount: post.likeCount ?? 0,
      commentCount: post.commentCount ?? 0,
      likedByViewer: !!liked,
      comments: commentsPreview,
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

  async adminDeletePost(postIdStr: string): Promise<void> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.repo.getPostById(postId);
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    await runInTransaction(this.customClient, async (session) => {
      await this.repo.softDeletePost(postId, session);
      await this.repo.decrementProfilePostCount(post.authorId, session);
    });

    await this.publisher.publishPostDeleted({
      postId: postId.toString(),
      authorId: post.authorId,
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

    const commentsMap = await this.commentService.getBatchRecentPreview(postIds, viewerId, 3);

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
        comments: commentsMap.get(p._id.toString()) || [],
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

  async editPost(
    viewerId: string,
    postIdStr: string,
    patch: { body?: string; removeImage?: boolean }
  ): Promise<PostResponse> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.repo.getPostById(postId);
    if (!post) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }
    if (post.deleted) {
      throw new BadRequestError('Cannot edit deleted post', 'post_deleted');
    }

    if (post.authorId !== viewerId) {
      throw new NotPostAuthorError();
    }

    if (patch.body === undefined && patch.removeImage === undefined) {
      throw new BadRequestError('At least one of body or removeImage must be provided', 'invalid_request');
    }

    if (patch.removeImage && post.imageKey) {
      await deleteObject(post.imageKey).catch(() => {});
    }

    const updated = await this.repo.updatePost(postId, patch);
    if (!updated) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    await this.publisher.publishPostEdited({
      postId: postId.toString(),
      authorId: viewerId,
      body: updated.body,
      hasImage: Boolean(updated.imageKey),
      at: (updated.updatedAt || new Date()).toISOString(),
    });

    const liked = await this.likeRepo.findLike(postId, viewerId);
    const authorProfile = await this.getProfilesCol().findOne({ userId: post.authorId });
    const commentsPreview = await this.commentService.getRecentPreview(postId, viewerId, 3);

    return {
      id: updated._id.toString(),
      body: updated.body,
      imageKey: updated.imageKey ?? null,
      imageUrl: updated.imageUrl ?? null,
      likeCount: updated.likeCount ?? 0,
      commentCount: updated.commentCount ?? 0,
      likedByViewer: !!liked,
      comments: commentsPreview,
      createdAt: updated.createdAt instanceof Date ? updated.createdAt.toISOString() : new Date(updated.createdAt).toISOString(),
      updatedAt: updated.updatedAt instanceof Date ? updated.updatedAt.toISOString() : new Date(updated.updatedAt).toISOString(),
      author: {
        userId: post.authorId,
        username: authorProfile?.username || 'unknown',
        name: authorProfile?.name ?? null,
        avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
      },
    };
  }

  async getPopular(viewerId: string, limit: number = 20): Promise<PostResponse[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const candidatePosts = await this.repo.getPopularPosts(sevenDaysAgo, limit * 3);
    if (candidatePosts.length === 0) return [];

    const authorIds = Array.from(new Set(candidatePosts.map((p) => p.authorId)));
    const blockedIds = await getBlockedUserIds(viewerId, authorIds, this.customDb);
    const allowedPosts = candidatePosts
      .filter((p) => !blockedIds.has(p.authorId))
      .slice(0, limit);

    if (allowedPosts.length === 0) return [];

    const postIds = allowedPosts.map((p) => p._id);
    const likedSet = await this.likeRepo.hasLikedBatch(viewerId, postIds);

    const allowedAuthorIds = Array.from(new Set(allowedPosts.map((p) => p.authorId)));
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedAuthorIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    const commentsMap = await this.commentService.getBatchRecentPreview(postIds, viewerId, 3);

    return allowedPosts.map((p) => {
      const authorProfile = profileMap.get(p.authorId);
      return {
        id: p._id.toString(),
        body: p.body,
        imageKey: p.imageKey ?? null,
        imageUrl: p.imageUrl ?? null,
        likeCount: p.likeCount ?? 0,
        commentCount: p.commentCount ?? 0,
        likedByViewer: likedSet.has(p._id.toString()),
        comments: commentsMap.get(p._id.toString()) || [],
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : new Date(p.createdAt).toISOString(),
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : new Date(p.updatedAt).toISOString(),
        author: {
          userId: p.authorId,
          username: authorProfile?.username || 'unknown',
          name: authorProfile?.name ?? null,
          avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
        },
      };
    });
  }

  async getViewerLikedPosts(
    viewerId: string,
    limit: number = 20,
    before?: string
  ): Promise<PostResponse[]> {
    const beforeDate = before ? new Date(before) : undefined;
    const likes = await this.likeRepo.getUserLikes(viewerId, limit * 3, beforeDate);
    if (likes.length === 0) return [];

    const postIds = likes.map((l) => l.postId);
    const posts = await this.repo.getPostsByIds(postIds);
    if (posts.length === 0) return [];

    const postMap = new Map<string, typeof posts[0]>();
    for (const p of posts) {
      postMap.set(p._id.toString(), p);
    }

    const orderedPosts: typeof posts = [];
    for (const l of likes) {
      const post = postMap.get(l.postId.toString());
      if (post) {
        orderedPosts.push(post);
      }
    }

    const authorIds = Array.from(new Set(orderedPosts.map((p) => p.authorId)));
    const blockedIds = await getBlockedUserIds(viewerId, authorIds, this.customDb);
    const allowedPosts = orderedPosts
      .filter((p) => !blockedIds.has(p.authorId))
      .slice(0, limit);

    if (allowedPosts.length === 0) return [];

    const allowedPostIds = allowedPosts.map((p) => p._id);
    const allowedAuthorIds = Array.from(new Set(allowedPosts.map((p) => p.authorId)));
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedAuthorIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    const commentsMap = await this.commentService.getBatchRecentPreview(allowedPostIds, viewerId, 3);

    return allowedPosts.map((p) => {
      const authorProfile = profileMap.get(p.authorId);
      return {
        id: p._id.toString(),
        body: p.body,
        imageKey: p.imageKey ?? null,
        imageUrl: p.imageUrl ?? null,
        likeCount: p.likeCount ?? 0,
        commentCount: p.commentCount ?? 0,
        likedByViewer: true,
        comments: commentsMap.get(p._id.toString()) || [],
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : new Date(p.createdAt).toISOString(),
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : new Date(p.updatedAt).toISOString(),
        author: {
          userId: p.authorId,
          username: authorProfile?.username || 'unknown',
          name: authorProfile?.name ?? null,
          avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
        },
      };
    });
  }
}

export const defaultPostService = new PostService();
