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

export interface StoryCreatedPayload {
  storyId: string;
  authorId: string;
  mediaType: 'image' | 'video';
  at: string;
}

export interface StoryDeletedPayload {
  storyId: string;
  authorId: string;
  at: string;
}

export interface ReelCreatedPayload {
  reelId: string;
  authorId: string;
  duration: number;
  at: string;
}

export interface ReelLikedPayload {
  reelId: string;
  authorId: string;
  userId: string;
  at: string;
}

export interface ReelUnlikedPayload {
  reelId: string;
  authorId: string;
  userId: string;
  at: string;
}

export interface ReelViewedPayload {
  reelId: string;
  viewDelta: number;
  totalViews: number;
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

  async publishStoryCreated(payload: StoryCreatedPayload): Promise<void> {
    await this.publish('core.story.created', payload);
  }

  async publishStoryDeleted(payload: StoryDeletedPayload): Promise<void> {
    await this.publish('core.story.deleted', payload);
  }

  async publishReelCreated(payload: ReelCreatedPayload): Promise<void> {
    await this.publish('core.reel.created', payload);
  }

  async publishReelLiked(payload: ReelLikedPayload): Promise<void> {
    await this.publish('core.reel.liked', payload);
  }

  async publishReelUnliked(payload: ReelUnlikedPayload): Promise<void> {
    await this.publish('core.reel.unliked', payload);
  }

  async publishReelViewed(payload: ReelViewedPayload): Promise<void> {
    await this.publish('core.reel.viewed', payload);
  }

  async publishWsToUsers(userIds: string[], type: string, payload: unknown): Promise<void> {
    if (!userIds || userIds.length === 0) return;
    try {
      const msg = JSON.stringify({ type, payload });
      if (typeof (this.redis as any)?.pipeline === 'function') {
        const pipe = this.redis.pipeline();
        for (const uid of userIds) {
          pipe.publish(`ws:user:${uid}`, msg);
        }
        await pipe.exec();
      } else if (typeof (this.redis as any)?.publish === 'function') {
        for (const uid of userIds) {
          await this.redis.publish(`ws:user:${uid}`, msg);
        }
      }
    } catch (err: unknown) {
      console.error(`Failed to publish WS event ${type}:`, err);
    }
  }
}

export const defaultSocialEventPublisher = new SocialEventPublisher();
