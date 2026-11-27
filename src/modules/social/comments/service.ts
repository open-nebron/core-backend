import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { CommentRepository, defaultCommentRepository, type CommentSortOrder } from './repository.js';
import { PostRepository, defaultPostRepository } from '../posts/repository.js';
import { FollowRepository, defaultFollowRepository } from '../follows/repository.js';
import {
  SocialEventPublisher,
  defaultSocialEventPublisher,
} from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import {
  getProfilesCollection,
  getReelsCollection,
  getDb,
  runInTransaction,
  type CommentDocument,
  type ProfileDocument,
  type ReelDocument,
} from '../../../db/mongo.js';
import { env } from '../../../config/env.js';
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

export interface ReplyToUser {
  userId: string;
  username: string;
}

export interface CommentParentPreview {
  id: string;
  body: string;
  createdAt: string;
  author: CommentAuthor;
}

export interface CommentResponse {
  id: string;
  postId?: string;
  reelId?: string;
  targetType?: 'post' | 'reel';
  parentCommentId: string | null;
  replyToUserId?: string | null;
  replyToUser?: ReplyToUser | null;
  body: string;
  likeCount: number;
  replyCount: number;
  likedByViewer: boolean;
  deleted?: boolean;
  createdAt: string;
  author: CommentAuthor;
  topReplies?: CommentResponse[];
  parent?: CommentParentPreview;
}

export interface ReelCommentResponse extends CommentResponse {
  reelId: string;
  targetType: 'reel';
}

interface ResolvedTarget {
  targetType: 'post' | 'reel';
  targetId: ObjectId;
  ownerId: string;
}

interface ResolvedParent {
  actualParent: CommentDocument;
  targetParent: CommentDocument;
  replyToUserId: string | null;
}

export class CommentService {
  private repo: CommentRepository;
  private postRepo: PostRepository;
  private followRepo: FollowRepository;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: CommentRepository,
    postRepo?: PostRepository,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient,
    followRepo?: FollowRepository
  ) {
    this.repo = repo ?? (customDb ? new CommentRepository(customDb) : defaultCommentRepository);
    this.postRepo = postRepo ?? (customDb ? new PostRepository(customDb) : defaultPostRepository);
    this.followRepo = followRepo ?? (customDb ? new FollowRepository(customDb) : defaultFollowRepository);
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

  private toIsoString(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  }

  private formatAuthor(profile: ProfileDocument | undefined, userId: string): CommentAuthor {
    return {
      userId,
      username: profile?.username || 'unknown',
      name: profile?.name ?? null,
      avatarUrl: profile ? computePublicUrl(profile.avatarKey, profile.updatedAt) : null,
    };
  }

  private async fetchProfileMap(userIds: string[]): Promise<Map<string, ProfileDocument>> {
    if (userIds.length === 0) return new Map();
    const profiles = await this.getProfilesCol()
      .find({ userId: { $in: userIds } })
      .toArray();
    return new Map(profiles.map((p) => [p.userId, p]));
  }

  private async resolveTarget(
    viewerId: string,
    targetType: 'post' | 'reel',
    targetIdStr: string
  ): Promise<ResolvedTarget> {
    if (targetType === 'post') {
      const postId = this.parseObjectId(targetIdStr, 'Post');
      const post = await this.postRepo.getPostById(postId);
      if (!post || post.deleted) {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      if (await isBlockedPair(viewerId, post.authorId, this.customDb)) {
        throw new BlockedError();
      }
      return { targetType: 'post', targetId: postId, ownerId: post.authorId };
    }

    const reelId = this.parseObjectId(targetIdStr, 'Reel');
    const reel: ReelDocument | null = await this.getReelsCol().findOne({ _id: reelId });
    if (!reel || reel.deleted) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }
    const reelAuthorProfile = await this.getProfilesCol().findOne({ userId: reel.authorId });
    if (reelAuthorProfile?.isBanned) {
      throw new NotFoundError('Reel not found', 'reel_not_found');
    }
    if (await isBlockedPair(viewerId, reel.authorId, this.customDb)) {
      throw new BlockedError();
    }
    return { targetType: 'reel', targetId: reelId, ownerId: reel.authorId };
  }

  private async resolveParentForReply(
    viewerId: string,
    rawParentId: string,
    target: ResolvedTarget
  ): Promise<ResolvedParent> {
    if (!ObjectId.isValid(rawParentId) || String(new ObjectId(rawParentId)) !== rawParentId) {
      throw new BadRequestError('Invalid parent comment', 'invalid_parent');
    }

    const parentId = new ObjectId(rawParentId);
    const parent = await this.repo.getCommentById(parentId);
    if (!parent || parent.deleted) {
      throw new BadRequestError('Parent comment not found or deleted', 'invalid_parent');
    }

    const isSameTarget =
      target.targetType === 'post'
        ? parent.targetType !== 'reel' && parent.postId?.toString() === target.targetId.toString()
        : parent.targetType === 'reel' && parent.reelId?.toString() === target.targetId.toString();

    if (!isSameTarget) {
      throw new BadRequestError('Parent comment does not belong to this target', 'invalid_parent');
    }

    if (parent.authorId !== viewerId && (await isBlockedPair(viewerId, parent.authorId, this.customDb))) {
      throw new BlockedError();
    }

    let actualParent = parent;
    let replyToUserId: string | null = null;

    if (env.DECISION_COMMENT_THREADING === 'two-level' && parent.parentCommentId) {
      const rootParent = await this.repo.getCommentById(parent.parentCommentId);
      const rootSameTarget =
        rootParent &&
        (target.targetType === 'post'
          ? rootParent.targetType !== 'reel' && rootParent.postId?.toString() === target.targetId.toString()
          : rootParent.targetType === 'reel' && rootParent.reelId?.toString() === target.targetId.toString());

      if (!rootParent || !rootSameTarget) {
        throw new BadRequestError('Root parent comment not found', 'invalid_parent');
      }

      if (
        rootParent.authorId !== viewerId &&
        rootParent.authorId !== parent.authorId &&
        (await isBlockedPair(viewerId, rootParent.authorId, this.customDb))
      ) {
        throw new BlockedError();
      }

      actualParent = rootParent;
      replyToUserId = parent.authorId;
    }

    return {
      actualParent,
      targetParent: parent,
      replyToUserId,
    };
  }

  private async notifyCommentWsRecipients(
    target: ResolvedTarget,
    actorId: string,
    eventType: string,
    payload: Record<string, unknown>,
    extraCandidateIds: string[] = []
  ): Promise<void> {
    try {
      const targetField = target.targetType === 'reel' ? 'reelId' : 'postId';
      const [followerIds, commenterIds] = await Promise.all([
        this.followRepo.getAllFollowerIds(target.ownerId),
        this.repo.getDistinctCommentAuthors(targetField, target.targetId),
      ]);

      const rawCandidates = Array.from(
        new Set([target.ownerId, actorId, ...followerIds, ...commenterIds, ...extraCandidateIds])
      );

      const others = rawCandidates.filter((id) => id !== actorId);
      const blockedByActor = await getBlockedUserIds(actorId, others, this.customDb);
      const ownerOthers = rawCandidates.filter((id) => id !== target.ownerId);
      const blockedByOwner = await getBlockedUserIds(target.ownerId, ownerOthers, this.customDb);

      const recipients = rawCandidates.filter(
        (id) => !blockedByActor.has(id) && !blockedByOwner.has(id)
      );

      await this.publisher.publishWsToUsers(recipients, eventType, payload);
    } catch {
      // Non-blocking WS broadcast
    }
  }

  private async createThreadedComment(
    viewerId: string,
    targetType: 'post' | 'reel',
    targetIdStr: string,
    rawBody: string,
    rawParentCommentId?: string | null
  ): Promise<CommentResponse> {
    const target = await this.resolveTarget(viewerId, targetType, targetIdStr);

    const body = sanitizePostBody(rawBody);
    if (!body || body.length < 1) {
      throw new BadRequestError('Comment body must not be empty', 'empty_body');
    }
    if (body.length > 300) {
      throw new BadRequestError('Comment body cannot exceed 300 characters', 'body_too_long');
    }

    const parentInfo =
      rawParentCommentId && rawParentCommentId.trim().length > 0
        ? await this.resolveParentForReply(viewerId, rawParentCommentId.trim(), target)
        : null;

    const now = new Date();
    let createdComment!: CommentDocument;

    await runInTransaction(this.customClient, async (session) => {
      createdComment = await this.repo.createComment(
        {
          targetType,
          ...(targetType === 'post' ? { postId: target.targetId } : { reelId: target.targetId }),
          authorId: viewerId,
          body,
          parentCommentId: parentInfo ? parentInfo.actualParent._id : null,
          replyToUserId: parentInfo ? parentInfo.replyToUserId : null,
          likeCount: 0,
          replyCount: 0,
          deleted: false,
          createdAt: now,
        },
        session
      );

      if (parentInfo) {
        await this.repo.incrementReplyCount(parentInfo.actualParent._id, session);
      }

      if (targetType === 'post') {
        await this.repo.incrementCommentCount(target.targetId, session);
      } else {
        await this.repo.incrementReelCommentCount(target.targetId, session);
      }
    });

    const profileIds = [viewerId];
    if (parentInfo) {
      profileIds.push(parentInfo.actualParent.authorId);
      if (parentInfo.replyToUserId) {
        profileIds.push(parentInfo.replyToUserId);
      }
    }
    const profileMap = await this.fetchProfileMap(Array.from(new Set(profileIds)));

    const replyToUserProfile = parentInfo?.replyToUserId
      ? profileMap.get(parentInfo.replyToUserId)
      : undefined;

    const parentPreview: CommentParentPreview | undefined = parentInfo
      ? {
          id: parentInfo.actualParent._id.toString(),
          body: parentInfo.actualParent.body,
          createdAt: this.toIsoString(parentInfo.actualParent.createdAt),
          author: this.formatAuthor(
            profileMap.get(parentInfo.actualParent.authorId),
            parentInfo.actualParent.authorId
          ),
        }
      : undefined;

    const response: CommentResponse = {
      id: createdComment._id.toString(),
      ...(targetType === 'post'
        ? { postId: target.targetId.toString() }
        : { reelId: target.targetId.toString(), targetType: 'reel' as const }),
      parentCommentId: parentInfo ? parentInfo.actualParent._id.toString() : null,
      replyToUserId: parentInfo ? parentInfo.replyToUserId : null,
      ...(parentInfo?.replyToUserId
        ? {
            replyToUser: {
              userId: parentInfo.replyToUserId,
              username: replyToUserProfile?.username || 'unknown',
            },
          }
        : {}),
      body: createdComment.body,
      likeCount: 0,
      replyCount: 0,
      likedByViewer: false,
      deleted: false,
      createdAt: now.toISOString(),
      author: this.formatAuthor(profileMap.get(viewerId), viewerId),
      topReplies: [],
      ...(parentPreview ? { parent: parentPreview } : {}),
    };

    const targetIdString = target.targetId.toString();
    const createdPayload = {
      commentId: response.id,
      postId: targetIdString,
      commentAuthorId: viewerId,
      postAuthorId: target.ownerId,
      body,
      at: now.toISOString(),
    };
    await this.publisher.publishCommentCreated(createdPayload);

    if (parentInfo) {
      const repliedPayload = {
        commentId: response.id,
        parentCommentId: parentInfo.actualParent._id.toString(),
        postId: targetIdString,
        commentAuthorId: viewerId,
        parentAuthorId: parentInfo.targetParent.authorId,
        at: now.toISOString(),
      };
      await this.publisher.publishCommentReplied(repliedPayload);

      await this.notifyCommentWsRecipients(
        target,
        viewerId,
        'core.comment.replied',
        {
          ...repliedPayload,
          targetType,
          ...(targetType === 'reel' ? { reelId: targetIdString } : {}),
          reply: response,
          replyCount: (parentInfo.actualParent.replyCount ?? 0) + 1,
        },
        [parentInfo.actualParent.authorId, parentInfo.targetParent.authorId]
      );
    } else {
      await this.notifyCommentWsRecipients(target, viewerId, 'core.comment.created', {
        ...createdPayload,
        targetType,
        ...(targetType === 'reel' ? { reelId: targetIdString } : {}),
        comment: response,
      });
    }

    return response;
  }

  async createComment(
    viewerId: string,
    postIdStr: string,
    rawBody: string,
    parentCommentId?: string | null
  ): Promise<CommentResponse> {
    return this.createThreadedComment(viewerId, 'post', postIdStr, rawBody, parentCommentId);
  }

  async createReelComment(
    viewerId: string,
    reelIdStr: string,
    rawBody: string,
    parentCommentId?: string | null
  ): Promise<ReelCommentResponse> {
    const res = await this.createThreadedComment(
      viewerId,
      'reel',
      reelIdStr,
      rawBody,
      parentCommentId
    );
    return res as ReelCommentResponse;
  }

  private formatDocResponse(
    doc: CommentDocument,
    targetType: 'post' | 'reel',
    targetIdStr: string,
    profileMap: Map<string, ProfileDocument>,
    likedSet: Set<string>,
    blockedIds: Set<string>,
    topReplies?: CommentResponse[]
  ): CommentResponse {
    const idStr = doc._id.toString();
    const isBlockedPlaceholder = Boolean(doc.deleted && blockedIds.has(doc.authorId));
    const author = isBlockedPlaceholder
      ? { userId: 'deleted', username: 'deleted', name: null, avatarUrl: null }
      : this.formatAuthor(profileMap.get(doc.authorId), doc.authorId);

    const replyToProfile = doc.replyToUserId ? profileMap.get(doc.replyToUserId) : undefined;

    return {
      id: idStr,
      ...(targetType === 'post'
        ? { postId: targetIdStr }
        : { reelId: targetIdStr, targetType: 'reel' as const }),
      parentCommentId: doc.parentCommentId ? doc.parentCommentId.toString() : null,
      replyToUserId: doc.replyToUserId ?? null,
      ...(doc.replyToUserId
        ? {
            replyToUser: {
              userId: doc.replyToUserId,
              username: replyToProfile?.username || 'unknown',
            },
          }
        : {}),
      body: doc.deleted ? '[deleted]' : doc.body,
      likeCount: doc.likeCount ?? 0,
      replyCount: doc.replyCount ?? 0,
      likedByViewer: likedSet.has(idStr),
      deleted: Boolean(doc.deleted),
      createdAt: this.toIsoString(doc.createdAt),
      author,
      ...(topReplies !== undefined ? { topReplies } : {}),
    };
  }

  private async listTopLevelComments(
    viewerId: string,
    targetType: 'post' | 'reel',
    targetIdStr: string,
    limit: number = 20,
    before?: string,
    sort: CommentSortOrder = 'top'
  ): Promise<CommentResponse[]> {
    const target = await this.resolveTarget(viewerId, targetType, targetIdStr);
    const blockedIds = await getBlockedUserIds(viewerId, undefined, this.customDb);
    const beforeDate = before ? new Date(before) : undefined;
    const rawComments = await this.repo.getTopLevelComments(
      targetType === 'reel' ? 'reelId' : 'postId',
      target.targetId,
      limit,
      beforeDate,
      sort,
      Array.from(blockedIds)
    );
    if (rawComments.length === 0) return [];

    const parentIds = rawComments.map((c) => c._id as ObjectId);
    const rawReplies = await this.repo.getRepliesForParents(parentIds);

    const extraProfileIds = new Set<string>();
    for (const r of rawReplies) {
      if (r.replyToUserId) extraProfileIds.add(r.replyToUserId);
    }

    const visibleParents = rawComments.filter((c) => c.deleted || !blockedIds.has(c.authorId));
    if (visibleParents.length === 0) return [];

    const visibleRepliesAll = rawReplies.filter((r) => !blockedIds.has(r.authorId));
    const profileIdsNeeded = Array.from(
      new Set([
        ...visibleParents.filter((c) => !c.deleted || !blockedIds.has(c.authorId)).map((c) => c.authorId),
        ...visibleRepliesAll.map((r) => r.authorId),
        ...extraProfileIds,
      ])
    );

    const profileMap = await this.fetchProfileMap(profileIdsNeeded);

    const filteredParents = visibleParents.filter(
      (c) => c.deleted || !profileMap.get(c.authorId)?.isBanned
    );
    if (filteredParents.length === 0) return [];

    const repliesByParent = new Map<string, CommentDocument[]>();
    for (const r of visibleRepliesAll) {
      if (profileMap.get(r.authorId)?.isBanned) continue;
      const pid = r.parentCommentId?.toString();
      if (!pid) continue;
      const existing = repliesByParent.get(pid) || [];
      if (existing.length < 3) {
        existing.push(r);
        repliesByParent.set(pid, existing);
      }
    }

    const commentIdsForLikes: ObjectId[] = filteredParents.map((c) => c._id);
    for (const list of repliesByParent.values()) {
      for (const r of list) {
        commentIdsForLikes.push(r._id);
      }
    }
    const likedSet = await this.repo.hasLikedCommentsBatch(viewerId, commentIdsForLikes);

    const tid = target.targetId.toString();
    return filteredParents.map((c) => {
      const childDocs = repliesByParent.get(c._id.toString()) || [];
      const topReplies = childDocs.map((r) =>
        this.formatDocResponse(r, targetType, tid, profileMap, likedSet, blockedIds)
      );
      return this.formatDocResponse(
        c,
        targetType,
        tid,
        profileMap,
        likedSet,
        blockedIds,
        topReplies
      );
    });
  }

  async getComments(
    viewerId: string,
    postIdStr: string,
    limit: number = 20,
    before?: string,
    sort: CommentSortOrder = 'top'
  ): Promise<CommentResponse[]> {
    return this.listTopLevelComments(viewerId, 'post', postIdStr, limit, before, sort);
  }

  async getReelComments(
    viewerId: string,
    reelIdStr: string,
    limit: number = 20,
    before?: string,
    sort: CommentSortOrder = 'top'
  ): Promise<ReelCommentResponse[]> {
    const items = await this.listTopLevelComments(viewerId, 'reel', reelIdStr, limit, before, sort);
    return items as ReelCommentResponse[];
  }

  async getCommentReplies(
    viewerId: string,
    commentIdStr: string,
    limit: number = 20,
    before?: string
  ): Promise<CommentResponse[]> {
    const commentId = this.parseObjectId(commentIdStr, 'Comment');
    const parent = await this.repo.getCommentById(commentId);
    if (!parent || (parent.deleted && (parent.replyCount ?? 0) === 0)) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }

    const isReelComment =
      parent.targetType === 'reel' || (Boolean(parent.reelId) && !parent.postId);
    const target = await this.resolveTarget(
      viewerId,
      isReelComment ? 'reel' : 'post',
      (isReelComment ? parent.reelId : parent.postId).toString()
    );

    const blockedIds = await getBlockedUserIds(viewerId, undefined, this.customDb);
    const beforeDate = before ? new Date(before) : undefined;
    const rawReplies = await this.repo.getRepliesByParentId(
      commentId,
      limit,
      beforeDate,
      Array.from(blockedIds)
    );
    if (rawReplies.length === 0) return [];

    const unblocked = rawReplies.filter((r) => !blockedIds.has(r.authorId));
    if (unblocked.length === 0) return [];

    const profileIds = Array.from(
      new Set([
        ...unblocked.map((r) => r.authorId),
        ...unblocked
          .map((r) => r.replyToUserId)
          .filter((id): id is string => Boolean(id)),
      ])
    );
    const profileMap = await this.fetchProfileMap(profileIds);

    const visibleReplies = unblocked.filter((r) => !profileMap.get(r.authorId)?.isBanned);
    if (visibleReplies.length === 0) return [];

    const likedSet = await this.repo.hasLikedCommentsBatch(
      viewerId,
      visibleReplies.map((r) => r._id)
    );

    const tid = target.targetId.toString();
    return visibleReplies.map((r) =>
      this.formatDocResponse(r, target.targetType, tid, profileMap, likedSet, blockedIds)
    );
  }

  async likeComment(viewerId: string, commentIdStr: string): Promise<void> {
    const commentId = this.parseObjectId(commentIdStr, 'Comment');
    const comment = await this.repo.getCommentById(commentId);
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }

    const isReelComment =
      comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
    const target = await this.resolveTarget(
      viewerId,
      isReelComment ? 'reel' : 'post',
      (isReelComment ? comment.reelId : comment.postId).toString()
    );

    if (
      comment.authorId !== viewerId &&
      (await isBlockedPair(viewerId, comment.authorId, this.customDb))
    ) {
      throw new BlockedError();
    }

    let inserted = false;
    await runInTransaction(this.customClient, async (session) => {
      const existing = await this.repo.findCommentLike(commentId, viewerId);
      if (existing) {
        return;
      }
      inserted = await this.repo.insertCommentLike(commentId, viewerId, session);
      if (inserted) {
        await this.repo.incrementCommentLikeCount(commentId, session);
      }
    });

    if (inserted) {
      const updated = await this.repo.getCommentById(commentId);
      const likeCount = updated?.likeCount ?? (comment.likeCount ?? 0) + 1;
      const nowIso = new Date().toISOString();
      const targetIdStr = target.targetId.toString();

      const streamPayload = {
        commentId: commentId.toString(),
        postId: targetIdStr,
        userId: viewerId,
        commentAuthorId: comment.authorId,
        at: nowIso,
      };
      await this.publisher.publishCommentLiked(streamPayload);

      await this.notifyCommentWsRecipients(
        target,
        viewerId,
        'core.comment.liked',
        {
          ...streamPayload,
          targetType: target.targetType,
          ...(target.targetType === 'reel' ? { reelId: targetIdStr } : {}),
          parentCommentId: comment.parentCommentId ? comment.parentCommentId.toString() : null,
          likeCount,
        },
        [comment.authorId]
      );
    }
  }

  async unlikeComment(viewerId: string, commentIdStr: string): Promise<void> {
    const commentId = this.parseObjectId(commentIdStr, 'Comment');
    const comment = await this.repo.getCommentById(commentId);
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }

    const isReelComment =
      comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
    const targetId = isReelComment ? comment.reelId : comment.postId;

    let removed = false;
    await runInTransaction(this.customClient, async (session) => {
      const existing = await this.repo.findCommentLike(commentId, viewerId);
      if (!existing) {
        return;
      }
      removed = await this.repo.removeCommentLike(commentId, viewerId, session);
      if (removed) {
        await this.repo.decrementCommentLikeCount(commentId, session);
      }
    });

    if (removed) {
      const updated = await this.repo.getCommentById(commentId);
      const likeCount = updated?.likeCount ?? Math.max(0, (comment.likeCount ?? 0) - 1);
      const nowIso = new Date().toISOString();
      const targetIdStr = targetId.toString();

      const streamPayload = {
        commentId: commentId.toString(),
        postId: targetIdStr,
        userId: viewerId,
        commentAuthorId: comment.authorId,
        at: nowIso,
      };
      await this.publisher.publishCommentUnliked(streamPayload);

      let ownerId = comment.authorId;
      if (isReelComment) {
        const reel = await this.getReelsCol().findOne({ _id: targetId });
        if (reel) ownerId = reel.authorId;
      } else {
        const post = await this.postRepo.getPostById(targetId);
        if (post) ownerId = post.authorId;
      }

      await this.notifyCommentWsRecipients(
        {
          targetType: isReelComment ? 'reel' : 'post',
          targetId,
          ownerId,
        },
        viewerId,
        'core.comment.unliked',
        {
          ...streamPayload,
          targetType: isReelComment ? 'reel' : 'post',
          ...(isReelComment ? { reelId: targetIdStr } : {}),
          parentCommentId: comment.parentCommentId ? comment.parentCommentId.toString() : null,
          likeCount,
        },
        [comment.authorId]
      );
    }
  }

  private async performCommentDelete(
    comment: CommentDocument,
    isReelComment: boolean,
    targetId: ObjectId,
    ownerId: string,
    actorId: string
  ): Promise<void> {
    const commentId = comment._id as ObjectId;
    const isTopLevel = !comment.parentCommentId;
    const activeReplies = isTopLevel ? await this.repo.countActiveReplies(commentId) : 0;
    const keepPlaceholder = isTopLevel && (activeReplies > 0 || (comment.replyCount ?? 0) > 0);

    await runInTransaction(this.customClient, async (session) => {
      await this.repo.softDeleteComment(
        commentId,
        session,
        keepPlaceholder ? '[deleted]' : undefined
      );
      if (comment.parentCommentId) {
        await this.repo.decrementReplyCount(comment.parentCommentId, session);
      }
      if (isReelComment) {
        await this.repo.decrementReelCommentCount(targetId, session);
      } else {
        await this.repo.decrementCommentCount(targetId, session);
      }
    });

    const nowIso = new Date().toISOString();
    const targetIdStr = targetId.toString();
    const deletedPayload = {
      commentId: commentId.toString(),
      postId: targetIdStr,
      commentAuthorId: comment.authorId,
      at: nowIso,
    };

    await this.publisher.publishCommentDeleted(deletedPayload);

    await this.notifyCommentWsRecipients(
      {
        targetType: isReelComment ? 'reel' : 'post',
        targetId,
        ownerId,
      },
      actorId,
      'core.comment.deleted',
      {
        ...deletedPayload,
        targetType: isReelComment ? 'reel' : 'post',
        ...(isReelComment ? { reelId: targetIdStr } : {}),
        parentCommentId: comment.parentCommentId ? comment.parentCommentId.toString() : null,
        keepPlaceholder,
      }
    );
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

      await this.performCommentDelete(comment, true, reelId, reel.authorId, viewerId);
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

    await this.performCommentDelete(comment, false, comment.postId, post.authorId, viewerId);
  }

  async adminDeleteComment(commentIdStr: string): Promise<void> {
    const commentId = this.parseObjectId(commentIdStr, 'Comment');

    const comment = await this.repo.getCommentById(commentId);
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }

    const isReelComment = comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
    const targetId = isReelComment ? comment.reelId : comment.postId;

    let ownerId = comment.authorId;
    if (isReelComment) {
      const reel = await this.getReelsCol().findOne({ _id: targetId });
      if (reel) ownerId = reel.authorId;
    } else {
      const post = await this.postRepo.getPostById(targetId);
      if (post) ownerId = post.authorId;
    }

    await this.performCommentDelete(comment, isReelComment, targetId, ownerId, comment.authorId);
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
    const profileMap = await this.fetchProfileMap(allowedAuthors);
    const likedSet = await this.repo.hasLikedCommentsBatch(
      viewerId,
      filtered.map((c) => c._id)
    );

    const pid = postId.toString();
    return filtered.map((c) =>
      this.formatDocResponse(c, 'post', pid, profileMap, likedSet, blockedIds)
    );
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
    const allCommentIds: ObjectId[] = [];
    for (const list of map.values()) {
      for (const c of list) {
        allAuthorIds.add(c.authorId);
        allCommentIds.push(c._id);
      }
    }

    const blockedIds = await getBlockedUserIds(viewerId, Array.from(allAuthorIds), this.customDb);
    const allowedAuthorIds = Array.from(allAuthorIds).filter((id) => !blockedIds.has(id));

    const [profileMap, likedSet] = await Promise.all([
      this.fetchProfileMap(allowedAuthorIds),
      this.repo.hasLikedCommentsBatch(viewerId, allCommentIds),
    ]);

    for (const [pid, list] of map.entries()) {
      const filtered = list.filter((c) => !blockedIds.has(c.authorId));
      result.set(
        pid,
        filtered.map((c) =>
          this.formatDocResponse(c, 'post', pid, profileMap, likedSet, blockedIds)
        )
      );
    }

    return result;
  }
}

export const defaultCommentService = new CommentService();
