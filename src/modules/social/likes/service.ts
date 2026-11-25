import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { PostLikeRepository, defaultPostLikeRepository } from './repository.js';
import {
  SocialEventPublisher,
  defaultSocialEventPublisher,
} from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import {
  getPostsCollection,
  getProfilesCollection,
  getDb,
  getMongoClient,
  runInTransaction,
} from '../../../db/mongo.js';
import {
  NotFoundError,
  BlockedError,
  BadRequestError,
} from '../../../utils/errors.js';
import { computePublicUrl } from '../../../lib/r2.js';

export interface PostLikerItem {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export class PostLikeService {
  private repo: PostLikeRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: PostLikeRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient
  ) {
    this.repo = repo ?? defaultPostLikeRepository;
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customClient = customClient;
  }

  private getPostsCol() {
    return getPostsCollection(this.customDb ?? getDb());
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

  async likePost(viewerId: string, postIdStr: string): Promise<void> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.getPostsCol().findOne({ _id: postId });
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, post.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    let inserted = false;
    await runInTransaction(this.customClient, async (session) => {
      const existing = await this.repo.findLike(postId, viewerId);
      if (existing) {
        return;
      }
      inserted = await this.repo.insertLike(postId, viewerId, session);
      if (inserted) {
        await this.repo.incrementPostLikeCount(postId, session);
      }
    });

    if (inserted) {
      await this.publisher.publishPostLiked({
        postId: postId.toString(),
        authorId: post.authorId,
        userId: viewerId,
        at: new Date().toISOString(),
      });
    }
  }

  async unlikePost(viewerId: string, postIdStr: string): Promise<void> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.getPostsCol().findOne({ _id: postId });
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    let removed = false;
    await runInTransaction(this.customClient, async (session) => {
      const existing = await this.repo.findLike(postId, viewerId);
      if (!existing) {
        return;
      }
      removed = await this.repo.removeLike(postId, viewerId, session);
      if (removed) {
        await this.repo.decrementPostLikeCount(postId, session);
      }
    });

    if (removed) {
      await this.publisher.publishPostUnliked({
        postId: postId.toString(),
        authorId: post.authorId,
        userId: viewerId,
        at: new Date().toISOString(),
      });
    }
  }

  async getPostLikes(
    viewerId: string,
    postIdStr: string,
    limit: number = 30,
    before?: string
  ): Promise<PostLikerItem[]> {
    const postId = this.parseObjectId(postIdStr);

    const post = await this.getPostsCol().findOne({ _id: postId });
    if (!post || post.deleted) {
      throw new NotFoundError('Post not found', 'post_not_found');
    }

    const isBlocked = await isBlockedPair(viewerId, post.authorId, this.customDb);
    if (isBlocked) {
      throw new BlockedError();
    }

    const beforeDate = before ? new Date(before) : undefined;
    const likes = await this.repo.getPostLikes(postId, limit, beforeDate);
    if (likes.length === 0) return [];

    const userIds = likes.map((l) => l.userId);
    const blockedUserIds = await getBlockedUserIds(viewerId, userIds, this.customDb);
    const visibleUserIds = userIds.filter((id) => !blockedUserIds.has(id));

    if (visibleUserIds.length === 0) return [];

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: visibleUserIds } })
      .toArray();

    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    return visibleUserIds.map((userId) => {
      const p = profileMap.get(userId);
      return {
        userId,
        username: p?.username || 'unknown',
        name: p?.name ?? null,
        avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
      };
    });
  }
}

export const defaultPostLikeService = new PostLikeService();
