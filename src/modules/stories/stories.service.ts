import { ObjectId, type Collection, type Db } from 'mongodb';
import {
  getDb,
  getProfilesCollection,
  getStoriesCollection,
  type ProfileDocument,
  type StoryDocument,
} from '../../db/mongo.js';
import { env } from '../../config/env.js';
import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_VIDEO_TYPES,
  computePublicUrl,
  createPresignedUpload,
  deleteObject,
  headObject,
  isValidUserKey,
  type AcceptedStoryMediaType,
  type PresignedUploadSlot,
} from '../../lib/r2.js';
import {
  BadRequestError,
  BlockedError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import { FollowRepository, defaultFollowRepository } from '../social/follows/repository.js';
import { getBlockedUserIds, isBlockedPair } from '../social/block-filter.js';
import { SocialEventPublisher, defaultSocialEventPublisher } from '../social/events.js';
import type { StoryConfirmInput } from './stories.schema.js';

export interface StoryResponse {
  id: string;
  authorId: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  thumbnailUrl: string | null;
  duration: number;
  caption: string | null;
  viewedByMe: boolean;
  viewerCount?: number;
  createdAt: string;
  expiresAt: string;
}

export interface StoryGroupResponse {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  isMine: boolean;
  stories: StoryResponse[];
  hasUnviewed: boolean;
}

export interface StoryViewerResponse {
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  viewedAt: string;
}

export class StoriesService {
  private followRepo: FollowRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;

  constructor(
    followRepo?: FollowRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db
  ) {
    this.followRepo = followRepo ?? (customDb ? new FollowRepository(customDb) : defaultFollowRepository);
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
  }

  private getStoriesCol(): Collection<StoryDocument> {
    return getStoriesCollection(this.customDb ?? getDb());
  }

  private getProfilesCol(): Collection<ProfileDocument> {
    return getProfilesCollection(this.customDb ?? getDb());
  }

  private parseObjectId(id: string): ObjectId {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      throw new NotFoundError('Story not found', 'story_not_found');
    }
    return new ObjectId(id);
  }

  private formatStory(doc: StoryDocument, viewerId: string): StoryResponse {
    const isMine = doc.authorId === viewerId;
    const viewedByMe =
      (isMine && Boolean(doc.authorViewed)) ||
      (Array.isArray(doc.viewers) && doc.viewers.some((v) => v.userId === viewerId));

    return {
      id: doc._id.toString(),
      authorId: doc.authorId,
      mediaUrl: doc.mediaUrl,
      mediaType: doc.mediaType,
      thumbnailUrl: doc.thumbnailKey ? computePublicUrl(doc.thumbnailKey) : null,
      duration: doc.duration,
      caption: doc.caption ?? null,
      viewedByMe,
      ...(isMine ? { viewerCount: doc.viewerCount ?? (Array.isArray(doc.viewers) ? doc.viewers.length : 0) } : {}),
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
      expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : new Date(doc.expiresAt).toISOString(),
    };
  }

  private async notifyFollowersAndAuthor(
    authorId: string,
    eventType: 'core.story.created' | 'core.story.deleted',
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      const followerIds = await this.followRepo.getAllFollowerIds(authorId);
      const blockedIds = await getBlockedUserIds(authorId, followerIds, this.customDb);
      const recipients = Array.from(
        new Set([authorId, ...followerIds.filter((id) => !blockedIds.has(id))])
      );
      await this.publisher.publishWsToUsers(recipients, eventType, payload);
    } catch {
      // Non-blocking WS notification
    }
  }

  /**
   * Generate a presigned POST upload URL for story media (image <= 10MB, video <= 50MB).
   */
  async createUploadUrl(
    userId: string,
    contentType: AcceptedStoryMediaType,
    contentLength: number
  ): Promise<PresignedUploadSlot> {
    const isVideo = contentType === 'video/mp4';
    const maxBytes = isVideo ? env.MAX_STORY_VIDEO_BYTES : env.MAX_STORY_IMAGE_BYTES;

    if (contentLength > maxBytes) {
      throw new BadRequestError(
        `Content length exceeds maximum allowed story ${isVideo ? 'video' : 'image'} size of ${maxBytes} bytes`,
        'file_too_large'
      );
    }

    return createPresignedUpload(userId, 'story', contentType, contentLength);
  }

  /**
   * Confirm uploaded story object and create an ephemeral 24-hour story record.
   */
  async confirmStory(userId: string, input: StoryConfirmInput): Promise<StoryResponse> {
    const { objectKey, mediaType, thumbnailKey } = input;

    if (!isValidUserKey(userId, 'story', objectKey)) {
      throw new ForbiddenError('Object key does not belong to the authenticated user', 'forbidden');
    }

    if (thumbnailKey && !isValidUserKey(userId, 'story', thumbnailKey)) {
      throw new ForbiddenError('Thumbnail key does not belong to the authenticated user', 'forbidden');
    }

    const duration = input.duration ?? (mediaType === 'image' ? 5 : 15);
    if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
      throw new BadRequestError('Duration must be between 1 and 15 seconds', 'invalid_duration');
    }

    const cleanCaption = input.caption && input.caption.length > 0 ? input.caption : null;
    if (cleanCaption && cleanCaption.length > 200) {
      throw new BadRequestError('Caption cannot exceed 200 characters', 'caption_too_long');
    }

    const meta = await headObject(objectKey);
    if (!meta) {
      throw new BadRequestError('Story media does not exist in storage', 'object_not_found');
    }

    if (mediaType === 'image') {
      if (!ACCEPTED_IMAGE_TYPES.includes(meta.contentType as any)) {
        throw new BadRequestError(
          `Unsupported image content type: ${meta.contentType}`,
          'unsupported_media_type'
        );
      }
      if (meta.contentLength > env.MAX_STORY_IMAGE_BYTES) {
        throw new BadRequestError(
          `Uploaded image exceeds maximum size of ${env.MAX_STORY_IMAGE_BYTES} bytes`,
          'file_too_large'
        );
      }
    } else {
      if (!ACCEPTED_VIDEO_TYPES.includes(meta.contentType as any)) {
        throw new BadRequestError(
          `Unsupported video content type: ${meta.contentType}`,
          'unsupported_media_type'
        );
      }
      if (meta.contentLength > env.MAX_STORY_VIDEO_BYTES) {
        throw new BadRequestError(
          `Uploaded video exceeds maximum size of ${env.MAX_STORY_VIDEO_BYTES} bytes`,
          'file_too_large'
        );
      }
    }

    const mediaUrl = computePublicUrl(objectKey) || '';
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const doc: StoryDocument = {
      authorId: userId,
      mediaType,
      mediaKey: objectKey,
      mediaUrl,
      thumbnailKey: thumbnailKey ?? null,
      duration,
      caption: cleanCaption,
      viewers: [],
      viewerCount: 0,
      authorViewed: false,
      expiresAt,
      createdAt: now,
    };

    const res = await this.getStoriesCol().insertOne(doc);
    doc._id = res.insertedId;

    const eventPayload = {
      storyId: res.insertedId.toString(),
      authorId: userId,
      mediaType,
      at: now.toISOString(),
    };

    await this.publisher.publishStoryCreated(eventPayload);
    await this.notifyFollowersAndAuthor(userId, 'core.story.created', eventPayload);

    return this.formatStory(doc, userId);
  }

  /**
   * Fetch grouped stories from users the viewer follows plus the viewer themselves.
   */
  async getFeedStories(viewerId: string): Promise<{ groups: StoryGroupResponse[] }> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const followingIds = await this.followRepo.getAllFollowingIds(viewerId);
    const blockedIds = await getBlockedUserIds(viewerId, followingIds, this.customDb);

    const candidateIds = Array.from(
      new Set([viewerId, ...followingIds.filter((id) => id !== viewerId && !blockedIds.has(id))])
    );

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: candidateIds } })
      .toArray();

    const profileMap = new Map<string, ProfileDocument>();
    const bannedSet = new Set<string>();
    for (const p of profiles) {
      if (p.isBanned) {
        bannedSet.add(p.userId);
      } else {
        profileMap.set(p.userId, p);
      }
    }

    const allowedIds = candidateIds.filter((id) => !bannedSet.has(id));
    if (allowedIds.length === 0) {
      return { groups: [] };
    }

    const stories = await this.getStoriesCol()
      .find({
        authorId: { $in: allowedIds },
        expiresAt: { $gt: now },
        createdAt: { $gte: last24h },
      })
      .sort({ createdAt: 1 })
      .toArray();

    const grouped = new Map<string, StoryDocument[]>();
    for (const s of stories) {
      const list = grouped.get(s.authorId) || [];
      list.push(s);
      grouped.set(s.authorId, list);
    }

    const groupsWithMeta: Array<{ group: StoryGroupResponse; latestAt: number }> = [];

    for (const [authorId, authorStories] of grouped.entries()) {
      const profile = profileMap.get(authorId);
      const isMine = authorId === viewerId;
      const formattedStories = authorStories.map((s) => this.formatStory(s, viewerId));
      const hasUnviewed = formattedStories.some((s) => !s.viewedByMe);
      const latestAt = Math.max(
        ...authorStories.map((s) =>
          (s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt)).getTime()
        )
      );

      groupsWithMeta.push({
        group: {
          userId: authorId,
          username: profile?.username || 'unknown',
          name: profile?.name ?? null,
          avatarUrl: profile ? computePublicUrl(profile.avatarKey, profile.updatedAt) : null,
          isMine,
          stories: formattedStories,
          hasUnviewed,
        },
        latestAt,
      });
    }

    groupsWithMeta.sort((a, b) => {
      if (a.group.isMine !== b.group.isMine) {
        return a.group.isMine ? -1 : 1;
      }
      if (a.group.hasUnviewed !== b.group.hasUnviewed) {
        return a.group.hasUnviewed ? -1 : 1;
      }
      return b.latestAt - a.latestAt;
    });

    return {
      groups: groupsWithMeta.map((g) => g.group),
    };
  }

  /**
   * Fetch a single user's active story group.
   */
  async getUserStories(viewerId: string, targetUserId: string): Promise<StoryGroupResponse> {
    if (viewerId !== targetUserId) {
      const blocked = await isBlockedPair(viewerId, targetUserId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }
    }

    const profile = await this.getProfilesCol().findOne({ userId: targetUserId });
    if (!profile) {
      throw new NotFoundError('User not found', 'user_not_found');
    }
    if (profile.isBanned) {
      throw new ForbiddenError('User is unavailable', 'user_banned');
    }

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const docs = await this.getStoriesCol()
      .find({
        authorId: targetUserId,
        expiresAt: { $gt: now },
        createdAt: { $gte: last24h },
      })
      .sort({ createdAt: 1 })
      .toArray();

    const stories = docs.map((d) => this.formatStory(d, viewerId));
    const hasUnviewed = stories.some((s) => !s.viewedByMe);

    return {
      userId: targetUserId,
      username: profile.username,
      name: profile.name ?? null,
      avatarUrl: computePublicUrl(profile.avatarKey, profile.updatedAt),
      isMine: viewerId === targetUserId,
      stories,
      hasUnviewed,
    };
  }

  /**
   * Idempotently record a viewer on an active story.
   */
  async viewStory(viewerId: string, storyIdStr: string): Promise<void> {
    const storyId = this.parseObjectId(storyIdStr);
    const now = new Date();

    const story = await this.getStoriesCol().findOne({
      _id: storyId,
      expiresAt: { $gt: now },
    });

    if (!story) {
      throw new NotFoundError('Story not found', 'story_not_found');
    }

    if (viewerId !== story.authorId) {
      const blocked = await isBlockedPair(viewerId, story.authorId, this.customDb);
      if (blocked) {
        throw new BlockedError();
      }

      await this.getStoriesCol().updateOne(
        {
          _id: storyId,
          'viewers.userId': { $ne: viewerId },
          'viewers.999': { $exists: false },
        } as any,
        {
          $push: {
            viewers: { userId: viewerId, viewedAt: now },
          },
          $inc: { viewerCount: 1 },
        }
      );
    } else {
      await this.getStoriesCol().updateOne(
        { _id: storyId },
        { $set: { authorViewed: true } }
      );
    }
  }

  /**
   * Immediately delete own story from both R2 storage and MongoDB.
   */
  async deleteStory(viewerId: string, storyIdStr: string): Promise<void> {
    const storyId = this.parseObjectId(storyIdStr);
    const story = await this.getStoriesCol().findOne({ _id: storyId });

    if (!story) {
      throw new NotFoundError('Story not found', 'story_not_found');
    }

    if (story.authorId !== viewerId) {
      throw new ForbiddenError('You are not the author of this story', 'not_story_author');
    }

    await deleteObject(story.mediaKey);
    if (story.thumbnailKey) {
      await deleteObject(story.thumbnailKey);
    }

    await this.getStoriesCol().deleteOne({ _id: storyId });

    const eventPayload = {
      storyId: storyIdStr,
      authorId: viewerId,
      at: new Date().toISOString(),
    };

    await this.publisher.publishStoryDeleted(eventPayload);
    await this.notifyFollowersAndAuthor(viewerId, 'core.story.deleted', eventPayload);
  }

  /**
   * Retrieve enriched list of viewers for a story (author-only, capped at 100).
   */
  async getStoryViewers(
    viewerId: string,
    storyIdStr: string
  ): Promise<{ viewers: StoryViewerResponse[]; viewerCount: number }> {
    const storyId = this.parseObjectId(storyIdStr);
    const story = await this.getStoriesCol().findOne({ _id: storyId });

    if (!story) {
      throw new NotFoundError('Story not found', 'story_not_found');
    }

    if (story.authorId !== viewerId) {
      throw new ForbiddenError('Only the story author can view viewers', 'not_story_author');
    }

    const rawViewers = Array.isArray(story.viewers) ? story.viewers : [];
    const viewerIds = rawViewers.map((v) => v.userId);
    const blockedIds = await getBlockedUserIds(viewerId, viewerIds, this.customDb);

    const filteredSorted = rawViewers
      .filter((v) => !blockedIds.has(v.userId))
      .sort((a, b) => new Date(b.viewedAt).getTime() - new Date(a.viewedAt).getTime())
      .slice(0, 100);

    if (filteredSorted.length === 0) {
      return { viewers: [], viewerCount: story.viewerCount ?? 0 };
    }

    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: filteredSorted.map((v) => v.userId) } })
      .toArray();
    const profileMap = new Map<string, ProfileDocument>();
    for (const p of profiles) {
      profileMap.set(p.userId, p);
    }

    const viewers: StoryViewerResponse[] = filteredSorted.map((v) => {
      const p = profileMap.get(v.userId);
      return {
        userId: v.userId,
        username: p?.username || 'unknown',
        name: p?.name ?? null,
        avatarUrl: p ? computePublicUrl(p.avatarKey, p.updatedAt) : null,
        viewedAt: v.viewedAt instanceof Date ? v.viewedAt.toISOString() : new Date(v.viewedAt).toISOString(),
      };
    });

    return {
      viewers,
      viewerCount: story.viewerCount ?? rawViewers.length,
    };
  }
}

export const defaultStoriesService = new StoriesService();
