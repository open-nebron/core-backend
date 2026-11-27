import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Social - V4-3 Saves & Share Tracking', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;

  async function clearRedisKeys() {
    if (!redis) return;
    for (const uid of [userA, userB, userC]) {
      const rateKeys = await redis.keys(`ratelimit:*:${uid}:*`);
      const dedupKeys = await redis.keys(`share:dedup:${uid}:*`);
      const allKeys = [...rateKeys, ...dedupKeys, `rel:blocked:${uid}`];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    }
  }

  async function createPost(token: string, body: string): Promise<any> {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createComment(token: string, postId: string, body: string): Promise<any> {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function insertReel(authorId: string, caption: string): Promise<string> {
    const now = new Date();
    const res = await db.collection('reels').insertOne({
      authorId,
      caption,
      videoKey: `users/${authorId}/reels/test-${Date.now()}.mp4`,
      videoUrl: 'https://cdn.example.com/reel.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 15,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      deleted: false,
      deletedAt: null,
      r2DeletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return res.insertedId.toString();
  }

  async function findStreamEvent(type: string, matchFn: (payload: any) => boolean) {
    const entries = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 30);
    return entries.find(([, fields]) => {
      const idxType = fields.indexOf('type');
      const idxPayload = fields.indexOf('payload');
      if (idxType === -1 || idxPayload === -1) return false;
      if (fields[idxType + 1] !== type) return false;
      const parsed = JSON.parse(fields[idxPayload + 1]);
      return matchFn(parsed);
    });
  }

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_v4_3_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'v43a@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'v43b@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'v43c@nebron.io' });

    const now = new Date();
    await db.collection('profiles').insertMany([
      {
        userId: userA,
        username: 'alice_v43',
        name: 'Alice',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userB,
        username: 'bob_v43',
        name: 'Bob',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userC,
        username: 'charlie_v43',
        name: 'Charlie',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    app = await buildApp();
  });

  beforeEach(async () => {
    await clearRedisKeys();
  });

  afterAll(async () => {
    await clearRedisKeys();
    if (app) await app.close();
    if (client) {
      await db.dropDatabase();
      await mongoDb.closeMongo();
    }
  });

  it('1. Save post increments saveCount, sets savedByViewer=true in GETs, and emits core.post.saved', async () => {
    const post = await createPost(tokenA, 'Saveable post');
    expect(post.saveCount).toBe(0);
    expect(post.shareCount).toBe(0);
    expect(post.savedByViewer).toBe(false);

    const saveRes = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(saveRes.statusCode).toBe(204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.saveCount).toBe(1);
    expect(fetched.shareCount).toBe(0);
    expect(fetched.savedByViewer).toBe(true);

    const evt = await findStreamEvent(
      'core.post.saved',
      (p) => p.postId === post.id && p.userId === userB
    );
    expect(evt).toBeTruthy();
  });

  it('2. Save post is idempotent (duplicate saves keep saveCount at 1)', async () => {
    const post = await createPost(tokenA, 'Idempotent save post');

    const res1 = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const res2 = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res1.statusCode).toBe(204);
    expect(res2.statusCode).toBe(204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getRes.json().saveCount).toBe(1);
    expect(getRes.json().savedByViewer).toBe(true);
  });

  it('3. Unsave post decrements saveCount, clears savedByViewer, and emits core.post.unsaved', async () => {
    const post = await createPost(tokenA, 'Unsave test post');

    await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(delRes.statusCode).toBe(204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getRes.json().saveCount).toBe(0);
    expect(getRes.json().savedByViewer).toBe(false);

    const evt = await findStreamEvent(
      'core.post.unsaved',
      (p) => p.postId === post.id && p.userId === userB
    );
    expect(evt).toBeTruthy();
  });

  it('4. Saved posts list is sorted DESC by savedAt and supports before cursor pagination', async () => {
    await db.collection('saved_posts').deleteMany({ userId: userB });
    const p1 = await createPost(tokenA, 'Saved order 1');
    const p2 = await createPost(tokenA, 'Saved order 2');
    const p3 = await createPost(tokenA, 'Saved order 3');

    await app.inject({ method: 'POST', url: `/posts/${p1.id}/save`, headers: { authorization: `Bearer ${tokenB}` } });
    await new Promise((r) => setTimeout(r, 10));
    await app.inject({ method: 'POST', url: `/posts/${p2.id}/save`, headers: { authorization: `Bearer ${tokenB}` } });
    await new Promise((r) => setTimeout(r, 10));
    await app.inject({ method: 'POST', url: `/posts/${p3.id}/save`, headers: { authorization: `Bearer ${tokenB}` } });

    const page1Res = await app.inject({
      method: 'GET',
      url: '/users/me/saved/posts?limit=2',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json();
    expect(page1.map((p: any) => p.id)).toEqual([p3.id, p2.id]);
    expect(page1[0].savedByViewer).toBe(true);
    expect(page1[0].savedAt).toBeTruthy();

    const page2Res = await app.inject({
      method: 'GET',
      url: `/users/me/saved/posts?limit=2&before=${encodeURIComponent(page1[1].savedAt)}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json();
    expect(page2.map((p: any) => p.id)).toEqual([p1.id]);
  });

  it('5. Save/unsave/list works for reels and updates GET /reels/:id metadata', async () => {
    const reelId = await insertReel(userA, 'Cool reel for bookmarking');

    const saveRes = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(saveRes.statusCode).toBe(204);

    const getReel = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getReel.statusCode).toBe(200);
    expect(getReel.json().saveCount).toBe(1);
    expect(getReel.json().shareCount).toBe(0);
    expect(getReel.json().savedByViewer).toBe(true);

    const listSaved = await app.inject({
      method: 'GET',
      url: '/users/me/saved/reels?limit=20',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listSaved.statusCode).toBe(200);
    expect(listSaved.json().some((r: any) => r.id === reelId && r.savedByViewer === true)).toBe(true);

    const unsaveRes = await app.inject({
      method: 'DELETE',
      url: `/reels/${reelId}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(unsaveRes.statusCode).toBe(204);

    const afterGet = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(afterGet.json().saveCount).toBe(0);
    expect(afterGet.json().savedByViewer).toBe(false);
  });

  it('6. Save/unsave/list works for comments and updates GET /posts/:id/comments', async () => {
    const post = await createPost(tokenA, 'Post with saveable comment');
    const comment = await createComment(tokenA, post.id, 'Insightful comment');

    const saveRes = await app.inject({
      method: 'POST',
      url: `/comments/${comment.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(saveRes.statusCode).toBe(204);

    const getComments = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getComments.statusCode).toBe(200);
    const item = getComments.json().find((c: any) => c.id === comment.id);
    expect(item.saveCount).toBe(1);
    expect(item.shareCount).toBe(0);
    expect(item.savedByViewer).toBe(true);

    const listSaved = await app.inject({
      method: 'GET',
      url: '/users/me/saved/comments?limit=20',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listSaved.statusCode).toBe(200);
    expect(listSaved.json().some((c: any) => c.id === comment.id && c.savedByViewer === true)).toBe(true);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/comments/${comment.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(delRes.statusCode).toBe(204);

    const afterComments = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const afterItem = afterComments.json().find((c: any) => c.id === comment.id);
    expect(afterItem.saveCount).toBe(0);
    expect(afterItem.savedByViewer).toBe(false);
  });

  it('7. POST /share increments shareCount, returns canonical deep links, and emits core.content.shared', async () => {
    const post = await createPost(tokenA, 'Shareable post');
    const comment = await createComment(tokenA, post.id, 'Shareable comment');
    const reelId = await insertReel(userA, 'Shareable reel');

    const postShare = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id },
    });
    expect(postShare.statusCode).toBe(200);
    expect(postShare.json().url).toMatch(new RegExp(`/posts/${post.id}$`));
    expect(postShare.json().shareCount).toBe(1);

    const reelShare = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reelId },
    });
    expect(reelShare.statusCode).toBe(200);
    expect(reelShare.json().url).toMatch(new RegExp(`/reels/${reelId}$`));
    expect(reelShare.json().shareCount).toBe(1);

    const commentShare = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'comment', contentId: comment.id },
    });
    expect(commentShare.statusCode).toBe(200);
    expect(commentShare.json().url).toMatch(new RegExp(`/posts/${post.id}#comment-${comment.id}$`));
    expect(commentShare.json().shareCount).toBe(1);

    const getPost = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(getPost.json().shareCount).toBe(1);

    const evt = await findStreamEvent(
      'core.content.shared',
      (p) => p.contentType === 'post' && p.contentId === post.id && p.byUserId === userB
    );
    expect(evt).toBeTruthy();
  });

  it('8. POST /share deduplicates per user per content for 24h while counting distinct users', async () => {
    const post = await createPost(tokenA, 'Dedup share post');

    const first = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().shareCount).toBe(1);

    // Same user shares again immediately -> deduplicated
    const second = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().shareCount).toBe(1);

    // Distinct user shares -> increments to 2
    const third = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { contentType: 'post', contentId: post.id },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().shareCount).toBe(2);
  });

  it('9. POST /share enforces 30/min rate limit per user', async () => {
    const post = await createPost(tokenA, 'Rate limit share target');

    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/share',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { contentType: 'post', contentId: post.id },
      });
      expect(res.statusCode).toBe(200);
    }

    const limitedRes = await app.inject({
      method: 'POST',
      url: '/share',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id },
    });
    expect(limitedRes.statusCode).toBe(429);
  });

  it('10. Saved list excludes deleted posts, reels, and comments', async () => {
    const keepPost = await createPost(tokenA, 'Keep post');
    const delPost = await createPost(tokenA, 'Delete me post');
    const delReelId = await insertReel(userA, 'Delete me reel');
    const delComment = await createComment(tokenA, keepPost.id, 'Delete me comment');

    await app.inject({ method: 'POST', url: `/posts/${keepPost.id}/save`, headers: { authorization: `Bearer ${tokenC}` } });
    await app.inject({ method: 'POST', url: `/posts/${delPost.id}/save`, headers: { authorization: `Bearer ${tokenC}` } });
    await app.inject({ method: 'POST', url: `/reels/${delReelId}/save`, headers: { authorization: `Bearer ${tokenC}` } });
    await app.inject({ method: 'POST', url: `/comments/${delComment.id}/save`, headers: { authorization: `Bearer ${tokenC}` } });

    await app.inject({ method: 'DELETE', url: `/posts/${delPost.id}`, headers: { authorization: `Bearer ${tokenA}` } });
    await app.inject({ method: 'DELETE', url: `/reels/${delReelId}`, headers: { authorization: `Bearer ${tokenA}` } });
    await app.inject({ method: 'DELETE', url: `/comments/${delComment.id}`, headers: { authorization: `Bearer ${tokenA}` } });

    const savedPosts = (await app.inject({
      method: 'GET',
      url: '/users/me/saved/posts',
      headers: { authorization: `Bearer ${tokenC}` },
    })).json();
    expect(savedPosts.some((p: any) => p.id === keepPost.id)).toBe(true);
    expect(savedPosts.some((p: any) => p.id === delPost.id)).toBe(false);

    const savedReels = (await app.inject({
      method: 'GET',
      url: '/users/me/saved/reels',
      headers: { authorization: `Bearer ${tokenC}` },
    })).json();
    expect(savedReels.some((r: any) => r.id === delReelId)).toBe(false);

    const savedComments = (await app.inject({
      method: 'GET',
      url: '/users/me/saved/comments',
      headers: { authorization: `Bearer ${tokenC}` },
    })).json();
    expect(savedComments.some((c: any) => c.id === delComment.id)).toBe(false);
  });

  it('11. savedByViewer is isolated per viewer and false for other users', async () => {
    const post = await createPost(tokenA, 'Viewer isolation post');

    await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const getAsC = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(getAsC.statusCode).toBe(200);
    expect(getAsC.json().saveCount).toBe(1);
    expect(getAsC.json().savedByViewer).toBe(false);

    const getSavedAsC = await app.inject({
      method: 'GET',
      url: '/users/me/saved/posts',
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(getSavedAsC.json().some((p: any) => p.id === post.id)).toBe(false);
  });

  it('12. Save counts never go negative on repeated or orphaned DELETE /save', async () => {
    const post = await createPost(tokenA, 'Non-negative saveCount');

    const res1 = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res1.statusCode).toBe(204);

    // Even if DB save row somehow existed while saveCount is 0, count stays >= 0
    await db.collection('saved_posts').insertOne({
      userId: userB,
      postId: new ObjectId(post.id),
      savedAt: new Date(),
    });
    const res2 = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res2.statusCode).toBe(204);

    const getPost = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getPost.json().saveCount).toBe(0);
  });

  it('13. Blocked users cannot save content and previously saved content from blocked users is excluded', async () => {
    const postByC = await createPost(tokenC, 'Charlie post before block');
    const reelByC = await insertReel(userC, 'Charlie reel before block');
    const commentByC = await createComment(tokenC, postByC.id, 'Charlie comment before block');

    // B saves C's content before blocking occurs
    await app.inject({ method: 'POST', url: `/posts/${postByC.id}/save`, headers: { authorization: `Bearer ${tokenB}` } });
    await app.inject({ method: 'POST', url: `/reels/${reelByC}/save`, headers: { authorization: `Bearer ${tokenB}` } });
    await app.inject({ method: 'POST', url: `/comments/${commentByC.id}/save`, headers: { authorization: `Bearer ${tokenB}` } });

    // C blocks B
    await db.collection('relationships').insertOne({
      fromUserId: userC,
      toUserId: userB,
      blocked: true,
      muted: { messages: false, calls: false, until: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await redis.del(`rel:blocked:${userB}`, `rel:blocked:${userC}`);

    const savedPosts = (await app.inject({
      method: 'GET',
      url: '/users/me/saved/posts',
      headers: { authorization: `Bearer ${tokenB}` },
    })).json();
    expect(savedPosts.some((p: any) => p.id === postByC.id)).toBe(false);

    const savedReels = (await app.inject({
      method: 'GET',
      url: '/users/me/saved/reels',
      headers: { authorization: `Bearer ${tokenB}` },
    })).json();
    expect(savedReels.some((r: any) => r.id === reelByC)).toBe(false);

    const savedComments = (await app.inject({
      method: 'GET',
      url: '/users/me/saved/comments',
      headers: { authorization: `Bearer ${tokenB}` },
    })).json();
    expect(savedComments.some((c: any) => c.id === commentByC.id)).toBe(false);

    // New save attempts against blocked user are rejected with 403 blocked
    const newPostByC = await createPost(tokenC, 'Charlie post after block');
    const attemptSave = await app.inject({
      method: 'POST',
      url: `/posts/${newPostByC.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(attemptSave.statusCode).toBe(403);
    expect(attemptSave.json().error.code).toBe('blocked');

    // Clean up block
    await db.collection('relationships').deleteMany({ fromUserId: userC, toUserId: userB });
    await redis.del(`rel:blocked:${userB}`, `rel:blocked:${userC}`);
  });

  it('14. v4_3_saves_and_shares migration populates saveCount and shareCount on legacy docs', async () => {
    const legacyPostId = new ObjectId();
    const legacyReelId = new ObjectId();
    const legacyCommentId = new ObjectId();
    const now = new Date();

    await db.collection('posts').insertOne({
      _id: legacyPostId,
      authorId: userA,
      body: 'Legacy post',
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('reels').insertOne({
      _id: legacyReelId,
      authorId: userA,
      caption: 'Legacy reel',
      videoKey: 'legacy.mp4',
      videoUrl: 'https://cdn.example.com/legacy.mp4',
      duration: 10,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('comments').insertOne({
      _id: legacyCommentId,
      postId: legacyPostId,
      authorId: userA,
      body: 'Legacy comment',
      deleted: false,
      createdAt: now,
    });

    await db.collection('migrations').deleteOne({ _id: 'v4_3_saves_and_shares' as any });
    await mongoDb.initMongoIndexes(db);

    const postDoc = await db.collection('posts').findOne({ _id: legacyPostId });
    const reelDoc = await db.collection('reels').findOne({ _id: legacyReelId });
    const commentDoc = await db.collection('comments').findOne({ _id: legacyCommentId });

    expect(postDoc?.saveCount).toBe(0);
    expect(postDoc?.shareCount).toBe(0);
    expect(reelDoc?.saveCount).toBe(0);
    expect(reelDoc?.shareCount).toBe(0);
    expect(commentDoc?.saveCount).toBe(0);
    expect(commentDoc?.shareCount).toBe(0);
  });
});
