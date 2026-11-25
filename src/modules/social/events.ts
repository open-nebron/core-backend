import type { Redis } from 'ioredis';
import { getRedisClient } from '../../db/redis.js';

export interface PostCreatedPayload {
  postId: string;
  authorId: string;
  body: string;
  hasImage: boolean;
  createdAt: string;
}

export interface PostDeletedPayload {
  postId: string;
  authorId: string;
  at: string;
}

export interface PostEditedPayload {
  postId: string;
  authorId: string;
  body: string;
  hasImage: boolean;
  at: string;
}

export interface PostLikedPayload {
  postId: string;
  authorId: string;
  userId: string;
  at: string;
}

export interface PostUnlikedPayload {
  postId: string;
  authorId: string;
  userId: string;
  at: string;
}

export interface CommentCreatedPayload {
  commentId: string;
  postId: string;
  commentAuthorId: string;
  postAuthorId: string;
  body: string;
  at: string;
}

export interface CommentDeletedPayload {
  commentId: string;
  postId: string;
  commentAuthorId: string;
  at: string;
}

export interface UserFollowedPayload {
  followerId: string;
  followingId: string;
  at: string;
}

export interface UserUnfollowedPayload {
  followerId: string;
  followingId: string;
  at: string;
}

export class SocialEventPublisher {
  private redis: Redis;
  private readonly streamKey: string;

  constructor(redis?: Redis, streamKey: string = 'nebron.events') {
    this.redis = redis ?? getRedisClient();
    this.streamKey = streamKey;
  }

  async publish(type: string, payload: unknown): Promise<void> {
    try {
      await this.redis.xadd(
        this.streamKey,
        '*',
        'type',
        type,
        'payload',
        JSON.stringify(payload)
      );
    } catch (err: unknown) {
      console.error(`Failed to publish event ${type}:`, err);
    }
  }

  async publishPostCreated(payload: PostCreatedPayload): Promise<void> {
    await this.publish('core.post.created', payload);
  }

  async publishPostDeleted(payload: PostDeletedPayload): Promise<void> {
    await this.publish('core.post.deleted', payload);
  }

  async publishPostEdited(payload: PostEditedPayload): Promise<void> {
    await this.publish('core.post.edited', payload);
  }

  async publishPostLiked(payload: PostLikedPayload): Promise<void> {
    await this.publish('core.post.liked', payload);
  }

  async publishPostUnliked(payload: PostUnlikedPayload): Promise<void> {
    await this.publish('core.post.unliked', payload);
  }

  async publishCommentCreated(payload: CommentCreatedPayload): Promise<void> {
    await this.publish('core.comment.created', payload);
  }

  async publishCommentDeleted(payload: CommentDeletedPayload): Promise<void> {
    await this.publish('core.comment.deleted', payload);
  }

  async publishUserFollowed(payload: UserFollowedPayload): Promise<void> {
    await this.publish('core.user.followed', payload);
  }

  async publishUserUnfollowed(payload: UserUnfollowedPayload): Promise<void> {
    await this.publish('core.user.unfollowed', payload);
  }
}

export const defaultSocialEventPublisher = new SocialEventPublisher();
