import { ObjectId, type Db, type MongoClient } from 'mongodb';
import {
  getDb,
  getPostsCollection,
  getReelsCollection,
  getCommentsCollection,
  getProfilesCollection,
  runInTransaction,
  type PostDocument,
  type ReelDocument,
  type CommentDocument,
  type ProfileDocument,
  type SavedPostDocument,
  type SavedReelDocument,
  type SavedCommentDocument,
} from '../../../db/mongo.js';
import { SaveRepository, defaultSaveRepository, type SaveContentType } from './repository.js';
import { PostService, defaultPostService, type PostResponse } from '../posts/service.js';
import { CommentService, defaultCommentService, type CommentResponse } from '../comments/service.js';
import { ReelsService, defaultReelsService, type ReelResponse } from '../../reels/reels.service.js';
import { SocialEventPublisher, defaultSocialEventPublisher } from '../events.js';
import { getBlockedUserIds, isBlockedPair } from '../block-filter.js';
import { BlockedError, NotFoundError } from '../../../utils/errors.js';

interface ResolvedTargetInfo {
  targetId: ObjectId;
  authorId: string;
  postIdStr?: string;
  reelIdStr?: string;
}

/**
 * Manages bookmarks (saved posts, saved reels, saved comments) with transactional saveCount tracking.
 */
export class SaveService {
  private repo: SaveRepository;
  private postService: PostService;
  private commentService: CommentService;
  private reelsService: ReelsService;
  private publisher: SocialEventPublisher;
  private customDb?: Db;
  private customClient?: MongoClient;

  constructor(
    repo?: SaveRepository,
    postService?: PostService,
    commentService?: CommentService,
    reelsService?: ReelsService,
    publisher?: SocialEventPublisher,
    customDb?: Db,
    customClient?: MongoClient
  ) {
    this.repo = repo ?? (customDb ? new SaveRepository(customDb) : defaultSaveRepository);
    this.postService = postService ?? (customDb ? new PostService(undefined, undefined, undefined, undefined, publisher, customDb, customClient, this.repo) : defaultPostService);
    this.commentService = commentService ?? (customDb ? new CommentService(undefined, undefined, publisher, customDb, customClient, undefined, this.repo) : defaultCommentService);
    this.reelsService = reelsService ?? (customDb ? new ReelsService(undefined, publisher, customDb, customClient, undefined, this.repo) : defaultReelsService);
    this.publisher = publisher ?? defaultSocialEventPublisher;
    this.customDb = customDb;
    this.customClient = customClient;
  }

  private db(): Db {
    return this.customDb ?? getDb();
  }

  private parseObjectId(idStr: string, type: SaveContentType): ObjectId {
    if (!ObjectId.isValid(idStr) || String(new ObjectId(idStr)) !== idStr) {
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      throw new NotFoundError(`${label} not found`, `${type}_not_found`);
    }
    return new ObjectId(idStr);
  }

  private async resolveTargetForSave(
    viewerId: string,
    type: SaveContentType,
    targetIdStr: string
  ): Promise<ResolvedTargetInfo> {
    const targetId = this.parseObjectId(targetIdStr, type);
    const profilesCol = getProfilesCollection(this.db());

    if (type === 'post') {
      const post = await getPostsCollection(this.db()).findOne({ _id: targetId });
      if (!post || post.deleted) {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      const author = await profilesCol.findOne({ userId: post.authorId });
      if (author?.isBanned && post.authorId !== viewerId) {
        throw new NotFoundError('Post not found', 'post_not_found');
      }
      if (post.authorId !== viewerId && (await isBlockedPair(viewerId, post.authorId, this.db()))) {
        throw new BlockedError();
      }
      return { targetId, authorId: post.authorId };
    }

    if (type === 'reel') {
      const reel = await getReelsCollection(this.db()).findOne({ _id: targetId });
      if (!reel || reel.deleted) {
        throw new NotFoundError('Reel not found', 'reel_not_found');
      }
      const author = await profilesCol.findOne({ userId: reel.authorId });
      if (author?.isBanned && reel.authorId !== viewerId) {
        throw new NotFoundError('Reel not found', 'reel_not_found');
      }
      if (reel.authorId !== viewerId && (await isBlockedPair(viewerId, reel.authorId, this.db()))) {
        throw new BlockedError();
      }
      return { targetId, authorId: reel.authorId };
    }

    const comment = await getCommentsCollection(this.db()).findOne({ _id: targetId });
    if (!comment || comment.deleted) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }
    const author = await profilesCol.findOne({ userId: comment.authorId });
    if (author?.isBanned && comment.authorId !== viewerId) {
      throw new NotFoundError('Comment not found', 'comment_not_found');
    }
    if (comment.authorId !== viewerId && (await isBlockedPair(viewerId, comment.authorId, this.db()))) {
      throw new BlockedError();
    }

    const isReel = comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
    if (isReel && comment.reelId) {
      const reel = await getReelsCollection(this.db()).findOne({ _id: comment.reelId });
      if (!reel || reel.deleted) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      const parentAuthor = await profilesCol.findOne({ userId: reel.authorId });
      if (parentAuthor?.isBanned && reel.authorId !== viewerId) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      if (reel.authorId !== viewerId && (await isBlockedPair(viewerId, reel.authorId, this.db()))) {
        throw new BlockedError();
      }
      return { targetId, authorId: comment.authorId, reelIdStr: comment.reelId.toString() };
    }

    if (comment.postId) {
      const post = await getPostsCollection(this.db()).findOne({ _id: comment.postId });
      if (!post || post.deleted) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      const parentAuthor = await profilesCol.findOne({ userId: post.authorId });
      if (parentAuthor?.isBanned && post.authorId !== viewerId) {
        throw new NotFoundError('Comment not found', 'comment_not_found');
      }
      if (post.authorId !== viewerId && (await isBlockedPair(viewerId, post.authorId, this.db()))) {
        throw new BlockedError();
      }
      return { targetId, authorId: comment.authorId, postIdStr: comment.postId.toString() };
    }

    throw new NotFoundError('Comment not found', 'comment_not_found');
  }

  private async ensureTargetExistsForUnsave(type: SaveContentType, targetIdStr: string): Promise<{
    targetId: ObjectId;
    postIdStr?: string;
    reelIdStr?: string;
  }> {
    const targetId = this.parseObjectId(targetIdStr, type);
    if (type === 'post') {
      const doc = await getPostsCollection(this.db()).findOne({ _id: targetId }, { projection: { _id: 1 } });
      if (!doc) throw new NotFoundError('Post not found', 'post_not_found');
      return { targetId };
    }
    if (type === 'reel') {
      const doc = await getReelsCollection(this.db()).findOne({ _id: targetId }, { projection: { _id: 1 } });
      if (!doc) throw new NotFoundError('Reel not found', 'reel_not_found');
      return { targetId };
    }
    const doc = await getCommentsCollection(this.db()).findOne(
      { _id: targetId },
      { projection: { _id: 1, postId: 1, reelId: 1, targetType: 1 } }
    );
    if (!doc) throw new NotFoundError('Comment not found', 'comment_not_found');
    const isReel = doc.targetType === 'reel' || (Boolean(doc.reelId) && !doc.postId);
    return {
      targetId,
      ...(isReel && doc.reelId ? { reelIdStr: doc.reelId.toString() } : {}),
      ...(!isReel && doc.postId ? { postIdStr: doc.postId.toString() } : {}),
    };
  }

  private async emitSaveChangeEvents(
    action: 'saved' | 'unsaved',
    type: SaveContentType,
    viewerId: string,
    targetIdStr: string,
    saveCount: number,
    at: string,
    context?: { postIdStr?: string; reelIdStr?: string }
  ): Promise<void> {
    if (type === 'post') {
      if (action === 'saved') {
        await this.publisher.publishPostSaved({ postId: targetIdStr, userId: viewerId, at });
      } else {
        await this.publisher.publishPostUnsaved({ postId: targetIdStr, userId: viewerId, at });
      }
      await this.publisher.publishWsToUsers([viewerId], `core.post.${action}`, {
        postId: targetIdStr,
        userId: viewerId,
        saveCount,
        at,
      });
      return;
    }

    if (type === 'reel') {
      if (action === 'saved') {
        await this.publisher.publishReelSaved({ reelId: targetIdStr, userId: viewerId, at });
      } else {
        await this.publisher.publishReelUnsaved({ reelId: targetIdStr, userId: viewerId, at });
      }
      await this.publisher.publishWsToUsers([viewerId], `core.reel.${action}`, {
        reelId: targetIdStr,
        userId: viewerId,
        saveCount,
        at,
      });
      return;
    }

    if (action === 'saved') {
      await this.publisher.publishCommentSaved({ commentId: targetIdStr, userId: viewerId, at });
    } else {
      await this.publisher.publishCommentUnsaved({ commentId: targetIdStr, userId: viewerId, at });
    }
    await this.publisher.publishWsToUsers([viewerId], `core.comment.${action}`, {
      commentId: targetIdStr,
      postId: context?.postIdStr,
      reelId: context?.reelIdStr,
      userId: viewerId,
      saveCount,
      at,
    });
  }

  async saveContent(viewerId: string, type: SaveContentType, targetIdStr: string): Promise<void> {
    const resolved = await this.resolveTargetForSave(viewerId, type, targetIdStr);
    const now = new Date();
    let inserted = false;
    let saveCount = 0;

    await runInTransaction(this.customClient, async (session) => {
      inserted = await this.repo.insertSave(type, viewerId, resolved.targetId, now, session);
      if (inserted) {
        saveCount = await this.repo.adjustSaveCount(type, resolved.targetId, 1, session);
      }
    });

    if (inserted) {
      await this.emitSaveChangeEvents('saved', type, viewerId, targetIdStr, saveCount, now.toISOString(), {
        postIdStr: resolved.postIdStr,
        reelIdStr: resolved.reelIdStr,
      });
    }
  }

  async unsaveContent(viewerId: string, type: SaveContentType, targetIdStr: string): Promise<void> {
    const target = await this.ensureTargetExistsForUnsave(type, targetIdStr);
    let removed = false;
    let saveCount = 0;

    await runInTransaction(this.customClient, async (session) => {
      removed = await this.repo.removeSave(type, viewerId, target.targetId, session);
      if (removed) {
        saveCount = await this.repo.adjustSaveCount(type, target.targetId, -1, session);
      }
    });

    if (removed) {
      await this.emitSaveChangeEvents(
        'unsaved',
        type,
        viewerId,
        targetIdStr,
        saveCount,
        new Date().toISOString(),
        { postIdStr: target.postIdStr, reelIdStr: target.reelIdStr }
      );
    }
  }

  async getSavedPosts(viewerId: string, limit: number = 20, before?: string): Promise<PostResponse[]> {
    const blockedIds = await getBlockedUserIds(viewerId, undefined, this.db());
    const collected: Array<{ doc: PostDocument; savedAt: string }> = [];
    let cursor = before ? new Date(before) : undefined;
    const batchSize = Math.min(limit * 3, 100);

    for (let round = 0; round < 5 && collected.length < limit; round++) {
      const entries = await this.repo.getSavedEntries<SavedPostDocument>('post', viewerId, batchSize, cursor);
      if (entries.length === 0) break;

      cursor = entries[entries.length - 1].savedAt;
      const postIds = entries.map((e) => e.postId);
      const posts = await getPostsCollection(this.db())
        .find({ _id: { $in: postIds }, deleted: false })
        .toArray();

      const authorIds = Array.from(new Set(posts.map((p) => p.authorId)));
      const profiles = authorIds.length > 0
        ? await getProfilesCollection(this.db()).find({ userId: { $in: authorIds } }).toArray()
        : [];
      const bannedSet = new Set(profiles.filter((p) => p.isBanned).map((p) => p.userId));
      const postMap = new Map(posts.map((p) => [p._id.toString(), p]));

      for (const entry of entries) {
        const post = postMap.get(entry.postId.toString());
        if (!post) continue;
        if (blockedIds.has(post.authorId)) continue;
        if (bannedSet.has(post.authorId) && post.authorId !== viewerId) continue;

        const savedAt = entry.savedAt instanceof Date ? entry.savedAt.toISOString() : new Date(entry.savedAt).toISOString();
        collected.push({ doc: post, savedAt });
        if (collected.length >= limit) break;
      }

      if (entries.length < batchSize) break;
    }

    if (collected.length === 0) return [];
    const formatted = await this.postService.formatPostsList(
      viewerId,
      collected.map((c) => c.doc),
      { savedAllTrue: true }
    );
    const savedAtById = new Map(collected.map((c) => [c.doc._id.toString(), c.savedAt]));
    return formatted.map((p) => ({
      ...p,
      savedByViewer: true,
      savedAt: savedAtById.get(p.id) ?? p.createdAt,
    }));
  }

  async getSavedReels(viewerId: string, limit: number = 20, before?: string): Promise<ReelResponse[]> {
    const blockedIds = await getBlockedUserIds(viewerId, undefined, this.db());
    const collected: Array<{ doc: ReelDocument; savedAt: string }> = [];
    let cursor = before ? new Date(before) : undefined;
    const batchSize = Math.min(limit * 3, 100);

    for (let round = 0; round < 5 && collected.length < limit; round++) {
      const entries = await this.repo.getSavedEntries<SavedReelDocument>('reel', viewerId, batchSize, cursor);
      if (entries.length === 0) break;

      cursor = entries[entries.length - 1].savedAt;
      const reelIds = entries.map((e) => e.reelId);
      const reels = await getReelsCollection(this.db())
        .find({ _id: { $in: reelIds }, deleted: false })
        .toArray();

      const authorIds = Array.from(new Set(reels.map((r) => r.authorId)));
      const profiles = authorIds.length > 0
        ? await getProfilesCollection(this.db()).find({ userId: { $in: authorIds } }).toArray()
        : [];
      const bannedSet = new Set(profiles.filter((p) => p.isBanned).map((p) => p.userId));
      const reelMap = new Map(reels.map((r) => [r._id.toString(), r]));

      for (const entry of entries) {
        const reel = reelMap.get(entry.reelId.toString());
        if (!reel) continue;
        if (blockedIds.has(reel.authorId)) continue;
        if (bannedSet.has(reel.authorId) && reel.authorId !== viewerId) continue;

        const savedAt = entry.savedAt instanceof Date ? entry.savedAt.toISOString() : new Date(entry.savedAt).toISOString();
        collected.push({ doc: reel, savedAt });
        if (collected.length >= limit) break;
      }

      if (entries.length < batchSize) break;
    }

    if (collected.length === 0) return [];
    const formatted = await this.reelsService.enrichReels(
      collected.map((c) => c.doc),
      viewerId
    );
    const savedAtById = new Map(collected.map((c) => [c.doc._id.toString(), c.savedAt]));
    return formatted.map((r) => ({
      ...r,
      savedByViewer: true,
      savedAt: savedAtById.get(r.id) ?? r.createdAt,
    }));
  }

  async getSavedComments(viewerId: string, limit: number = 20, before?: string): Promise<CommentResponse[]> {
    const blockedIds = await getBlockedUserIds(viewerId, undefined, this.db());
    const collected: Array<{ doc: CommentDocument; savedAt: string }> = [];
    let cursor = before ? new Date(before) : undefined;
    const batchSize = Math.min(limit * 3, 100);

    for (let round = 0; round < 5 && collected.length < limit; round++) {
      const entries = await this.repo.getSavedEntries<SavedCommentDocument>('comment', viewerId, batchSize, cursor);
      if (entries.length === 0) break;

      cursor = entries[entries.length - 1].savedAt;
      const commentIds = entries.map((e) => e.commentId);
      const comments = await getCommentsCollection(this.db())
        .find({ _id: { $in: commentIds }, deleted: false })
        .toArray();

      const parentPostIds: ObjectId[] = [];
      const parentReelIds: ObjectId[] = [];
      for (const c of comments) {
        const isReel = c.targetType === 'reel' || (Boolean(c.reelId) && !c.postId);
        if (isReel && c.reelId) parentReelIds.push(c.reelId);
        else if (c.postId) parentPostIds.push(c.postId);
      }

      const [parentPosts, parentReels] = await Promise.all([
        parentPostIds.length > 0
          ? getPostsCollection(this.db()).find({ _id: { $in: parentPostIds }, deleted: false }).toArray()
          : Promise.resolve([]),
        parentReelIds.length > 0
          ? getReelsCollection(this.db()).find({ _id: { $in: parentReelIds }, deleted: false }).toArray()
          : Promise.resolve([]),
      ]);

      const postMap = new Map(parentPosts.map((p) => [p._id.toString(), p]));
      const reelMap = new Map(parentReels.map((r) => [r._id.toString(), r]));
      const allAuthorIds = Array.from(
        new Set([
          ...comments.map((c) => c.authorId),
          ...parentPosts.map((p) => p.authorId),
          ...parentReels.map((r) => r.authorId),
        ])
      );
      const profiles = allAuthorIds.length > 0
        ? await getProfilesCollection(this.db()).find({ userId: { $in: allAuthorIds } }).toArray()
        : [];
      const bannedSet = new Set(profiles.filter((p) => p.isBanned).map((p) => p.userId));
      const commentMap = new Map(comments.map((c) => [c._id.toString(), c]));

      for (const entry of entries) {
        const comment = commentMap.get(entry.commentId.toString());
        if (!comment) continue;
        if (blockedIds.has(comment.authorId)) continue;
        if (bannedSet.has(comment.authorId) && comment.authorId !== viewerId) continue;

        const isReel = comment.targetType === 'reel' || (Boolean(comment.reelId) && !comment.postId);
        const parentAuthorId = isReel
          ? reelMap.get(comment.reelId?.toString() ?? '')?.authorId
          : postMap.get(comment.postId?.toString() ?? '')?.authorId;
        if (!parentAuthorId) continue;
        if (blockedIds.has(parentAuthorId)) continue;
        if (bannedSet.has(parentAuthorId) && parentAuthorId !== viewerId) continue;

        const savedAt = entry.savedAt instanceof Date ? entry.savedAt.toISOString() : new Date(entry.savedAt).toISOString();
        collected.push({ doc: comment, savedAt });
        if (collected.length >= limit) break;
      }

      if (entries.length < batchSize) break;
    }

    if (collected.length === 0) return [];
    const formatted = await this.commentService.formatSavedComments(
      viewerId,
      collected.map((c) => c.doc)
    );
    const savedAtById = new Map(collected.map((c) => [c.doc._id.toString(), c.savedAt]));
    return formatted.map((c) => ({
      ...c,
      savedByViewer: true,
      savedAt: savedAtById.get(c.id) ?? c.createdAt,
    }));
  }
}

export const defaultSaveService = new SaveService();
