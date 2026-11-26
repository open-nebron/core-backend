import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { CommentRepository, defaultCommentRepository } from './repository.js';
import { PostRepository, defaultPostRepository } from '../posts/repository.js';
import {
  SocialEventPublisher,
  defaultSocialEventPublisher,
} from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import {
  getProfilesCollection,
  getReelsCollection,
  getDb,
  getMongoClient,
  runInTransaction,
  type ProfileDocument,
  type ReelDocument,
} from '../../../db/mongo.js';
import {
  NotFoundError,
  BlockedError,
  ForbiddenError,
  BadRequestError,
} from '../../../utils/errors.js';
import { computePublicUrl } from '../../../lib/r2.js';
import { sanitizePostBody } from '../validate.js';

export interface CommentAuthor {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface CommentResponse {
  id: string;
  postId: string;
  body: string;
  createdAt: string;
  author: CommentAuthor;
}

export interface ReelCommentResponse {
  id: string;
  reelId: string;
  targetType: 'reel';
  body: string;
  createdAt: string;
  author: CommentAuthor;
}

export class CommentService {
  private repo: CommentRepository;
  private postRepo: PostRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: CommentRepository,
    postRepo?: PostRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient
  ) {
    this.repo = repo ?? (customDb ? new CommentRepository(customDb) : defaultCommentRepository);
    this.postRepo = postRepo ?? (customDb ? new PostRepository(customDb) : defaultPostRepository);
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customClient = customClient;
  }

  private getProfilesCol() {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  private getReelsCol() {
    return getReelsCollection(this.customDb ?? getDb());
  }

  private parseObjectId(id: string, entity: string = 'Post'): ObjectId {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      throw new NotFoundError(`${entity} not found`, `${entity.toLowerCase()}_not_found`);
    }
    return new ObjectId(id);
  }

  async createComment(
    viewerId: string,
    postIdStr: string,
    rawBody: string
  ): Promise<CommentResponse> {
    const postId = this.parseObjectId(postIdStr, 'Post');

    const post = await this.postRepo.getPostById(postId);
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, post.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const body = sanitizePostBody(rawBody);
    if (!body || body.length < 1) {
      throw new BadRequestError('Comment body must not be empty', 'empty_body');
    }
    if (body.length > 300) {
      throw new BadRequestError('Comment body cannot exceed 300 characters', 'body_too_long');
    }

    const now = new Date();
    let createdComment: any;

    await runInTransaction(this.customClient, async (session) => {
      createdComment = await this.repo.createComment(
        {
          targetType: 'post',
          postId,
          authorId: viewerId,
          body,
          deleted: false,
          createdAt: now,
        },
        session
      );
      await this.repo.incrementCommentCount(postId, session);
    });

    await this.publisher.publishCommentCreated({
      commentId: createdComment._id.toString(),
      postId: postId.toString(),
      commentAuthorId: viewerId,
      postAuthorId: post.authorId,
      body,
      at: now.toISOString(),
    });

    const authorProfile = await this.getProfilesCol().findOne({ userId: viewerId });

    return {
      id: createdComment._id.toString(),
      postId: postId.toString(),
      body: createdComment.body,
      createdAt: now.toISOString(),
      author: {
        userId: viewerId,
        username: authorProfile?.username || 'unknown',
        name: authorProfile?.name ?? null,
        avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
      },
    };
  }

  async getComments(
    viewerId: string,
    postIdStr: string,
    limit: number = 30,
    before?: string
  ): Promise<CommentResponse[]> {
    const postId = this.parseObjectId(postIdStr, 'Post');

    const post = await this.postRepo.getPostById(postId);
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, post.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const beforeDate = before ? new Date(before) : undefined;
    const rawComments = await this.repo.getCommentsByPost(postId, limit, beforeDate);
    if (rawComments.length === 0) return [];

    const authorIds = Array.from(new Set(rawComments.map((c) => c.authorId)));
    const blockedIds = await getBlockedUserIds(viewerId, authorIds, this.customDb);

    const filteredComments = rawComments.filter((c) => !blockedIds.has(c.authorId));
    if (filteredComments.length === 0) return [];

    const allowedAuthorIds = Array.from(new Set(filteredComments.map((c) => c.authorId)));
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedAuthorIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    return filteredComments.map((c) => {
      const p = profileMap.get(c.authorId);
      return {
        id: c._id.toString(),
        postId: postId.toString(),
        body: c.body,
        createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : new Date(c.createdAt).toISOString(),
        author: {
          userId: c.authorId,
          username: p?.username || 'unknown',
          name: p?.name ?? null,
          avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
        },
      };
    });
  }

  async createReelComment(
    viewerId: string,
    reelIdStr: string,
    rawBody: string
  ): Promise<ReelCommentResponse> {
    const reelId = this.parseObjectId(reelIdStr, 'Reel');

    const reel: ReelDocument | null = await this.getReelsCol().findOne({ _id: reelId });
    if (!reel || reel.deleted) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    const reelAuthorProfile = await this.getProfilesCol().findOne({ userId: reel.authorId });
    if (reelAuthorProfile?.isBanned) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const body = sanitizePostBody(rawBody);
    if (!body || body.length < 1) {
      throw new BadRequestError('Comment body must not be empty', 'empty_body');
    }
    if (body.length > 300) {
      throw new BadRequestError('Comment body cannot exceed 300 characters', 'body_too_long');
    }

    const now = new Date();
    let createdComment: any;

    await runInTransaction(this.customClient, async (session) => {
      createdComment = await this.repo.createComment(
        {
          targetType: 'reel',
          reelId,
          authorId: viewerId,
          body,
          deleted: false,
          createdAt: now,
        },
        session
      );
      await this.repo.incrementReelCommentCount(reelId, session);
    });

    await this.publisher.publishCommentCreated({
      commentId: createdComment._id.toString(),
      postId: reelId.toString(),
      commentAuthorId: viewerId,
      postAuthorId: reel.authorId,
      body,
      at: now.toISOString(),
    });

    const authorProfile = await this.getProfilesCol().findOne({ userId: viewerId });

    return {
      id: createdComment._id.toString(),
      reelId: reelId.toString(),
      targetType: 'reel',
      body: createdComment.body,
      createdAt: now.toISOString(),
      author: {
        userId: viewerId,
        username: authorProfile?.username || 'unknown',
        name: authorProfile?.name ?? null,
        avatarUrl: authorProfile ? computePublicUrl(authorProfile.avatarKey, authorProfile.updatedAt) : null,
      },
    };
  }

  async getReelComments(
    viewerId: string,
    reelIdStr: string,
    limit: number = 30,
    before?: string
  ): Promise<ReelCommentResponse[]> {
    const reelId = this.parseObjectId(reelIdStr, 'Reel');

    const reel: ReelDocument | null = await this.getReelsCol().findOne({ _id: reelId });
    if (!reel || reel.deleted) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    const reelAuthorProfile = await this.getProfilesCol().findOne({ userId: reel.authorId });
    if (reelAuthorProfile?.isBanned) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, reel.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const beforeDate = before ? new Date(before) : undefined;
    const rawComments = await this.repo.getCommentsByReel(reelId, limit, beforeDate);
    if (rawComments.length === 0) return [];

    const authorIds = Array.from(new Set(rawComments.map((c) => c.authorId)));
    const blockedIds = await getBlockedUserIds(viewerId, authorIds, this.customDb);

    const filteredComments = rawComments.filter((c) => !blockedIds.has(c.authorId));
    if (filteredComments.length === 0) return [];

    const allowedAuthorIds = Array.from(new Set(filteredComments.map((c) => c.authorId)));
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedAuthorIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    return filteredComments
      .filter((c) => !profileMap.get(c.authorId)?.isBanned)
      .map((c) => {
        const p = profileMap.get(c.authorId);
        return {
          id: c._id.toString(),
          reelId: reelId.toString(),
          targetType: 'reel' as const,
          body: c.body,
          createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : new Date(c.createdAt).toISOString(),
          author: {
            userId: c.authorId,
            username: p?.username || 'unknown',
            name: p?.name ?? null,
            avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
          },
        };
      });
  }

  async deleteComment(viewerId: string, commentIdStr: string): Promise<void> {
    const commentId = this.parseObjectId(commentIdStr, 'Comment');

    const comment = await this.repo.getCommentById(commentId);
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }

    const isReelComment = comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);

    if (isReelComment) {
      const reelId = comment.reelId;
      const reel = await this.getReelsCol().findOne({ _id: reelId });
      if (!reel) {
        throw new NotFoundError('Reel not found', 'reel_not_found');
      }

      if (comment.authorId !== viewerId && reel.authorId !== viewerId) {
        throw new ForbiddenError(
          'You do not have permission to delete this comment',
          'not_comment_or_reel_author'
        );
      }

      await runInTransaction(this.customClient, async (session) => {
        await this.repo.softDeleteComment(commentId, session);
        await this.repo.decrementReelCommentCount(reelId, session);
      });

      await this.publisher.publishCommentDeleted({
        commentId: commentId.toString(),
        postId: reelId.toString(),
        commentAuthorId: comment.authorId,
        at: new Date().toISOString(),
      });
      return;
    }

    const post = await this.postRepo.getPostById(comment.postId);
    if (!post) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    // Permission check: author of comment OR author of post
    if (comment.authorId !== viewerId && post.authorId !== viewerId) {
      throw new ForbiddenError(
        'You do not have permission to delete this comment',
        'not_comment_or_post_author'
      );
    }

    await runInTransaction(this.customClient, async (session) => {
      await this.repo.softDeleteComment(commentId, session);
      await this.repo.decrementCommentCount(comment.postId, session);
    });

    await this.publisher.publishCommentDeleted({
      commentId: commentId.toString(),
      postId: comment.postId.toString(),
      commentAuthorId: comment.authorId,
      at: new Date().toISOString(),
    });
  }

  async adminDeleteComment(commentIdStr: string): Promise<void> {
    const commentId = this.parseObjectId(commentIdStr, 'Comment');

    const comment = await this.repo.getCommentById(commentId);
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }

    const isReelComment = comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
    const targetId = isReelComment ? comment.reelId : comment.postId;

    await runInTransaction(this.customClient, async (session) => {
      await this.repo.softDeleteComment(commentId, session);
      if (isReelComment) {
        await this.repo.decrementReelCommentCount(targetId, session);
      } else {
        await this.repo.decrementCommentCount(targetId, session);
      }
    });

    await this.publisher.publishCommentDeleted({
      commentId: commentId.toString(),
      postId: targetId.toString(),
      commentAuthorId: comment.authorId,
      at: new Date().toISOString(),
    });
  }

  async getRecentPreview(
    postId: ObjectId,
    viewerId: string,
    limit: number = 3
  ): Promise<CommentResponse[]> {
    const rawComments = await this.repo.getRecentCommentsForPost(postId, limit);
    if (rawComments.length === 0) return [];

    const authorIds = Array.from(new Set(rawComments.map((c) => c.authorId)));
    const blockedIds = await getBlockedUserIds(viewerId, authorIds, this.customDb);

    const filtered = rawComments.filter((c) => !blockedIds.has(c.authorId));
    if (filtered.length === 0) return [];

    const allowedAuthors = Array.from(new Set(filtered.map((c) => c.authorId)));
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedAuthors } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    return filtered.map((c) => {
      const p = profileMap.get(c.authorId);
      return {
        id: c._id.toString(),
        postId: postId.toString(),
        body: c.body,
        createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : new Date(c.createdAt).toISOString(),
        author: {
          userId: c.authorId,
          username: p?.username || 'unknown',
          name: p?.name ?? null,
          avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
        },
      };
    });
  }

  async getBatchRecentPreview(
    postIds: ObjectId[],
    viewerId: string,
    limitPerPost: number = 3
  ): Promise<Map<string, CommentResponse[]>> {
    const map = await this.repo.getRecentCommentsForPosts(postIds, limitPerPost);
    const result = new Map<string, CommentResponse[]>();
    if (map.size === 0) return result;

    const allAuthorIds = new Set<string>();
    for (const list of map.values()) {
      for (const c of list) {
        allAuthorIds.add(c.authorId);
      }
    }

    const blockedIds = await getBlockedUserIds(viewerId, Array.from(allAuthorIds), this.customDb);
    const allowedAuthorIds = Array.from(allAuthorIds).filter((id) => !blockedIds.has(id));

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: allowedAuthorIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    for (const [pid, list] of map.entries()) {
      const filtered = list.filter((c) => !blockedIds.has(c.authorId));
      result.set(
        pid,
        filtered.map((c) => {
          const p = profileMap.get(c.authorId);
          return {
            id: c._id.toString(),
            postId: pid,
            body: c.body,
            createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : new Date(c.createdAt).toISOString(),
            author: {
              userId: c.authorId,
              username: p?.username || 'unknown',
              name: p?.name ?? null,
              avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
            },
          };
        })
      );
    }

    return result;
  }
}

export const defaultCommentService = new CommentService();
