import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';
import { handleEvent } from '../../src/modules/events/handlers.js';

describe('Social & Analytics V4.5-1 — Comment Reactions & Engagement Depth', () => {
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

  async function seedProfile(userId: string, username: string) {
    await db.collection('profiles').updateOne(
      { userId },
      {
        $set: {
          userId,
          username,
          name: username.toUpperCase(),
          language: 'en',
          theme: 'dark',
          avatarKey: null,
          bannerKey: null,
          followerCount: 0,
          followingCount: 0,
          postCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  async function clearTestKeys() {
    if (!redis) return;
    for (const uid of [userA, userB, userC]) {
      const patterns = [
        `ratelimit:*:${uid}:*`,
        `impression:*:${uid}`,
        `rel:blocked:${uid}`,
      ];
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) await redis.del(...keys);
      }
    }
    const depthKeys = await redis.keys('analytics:depth:*');
    if (depthKeys.length > 0) await redis.del(...depthKeys);
  }

  async function createPost(token: string, body: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createComment(token: string, postId: string, body: string, parentCommentId?: string | null) {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body, ...(parentCommentId ? { parentCommentId } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_v451_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'v451a@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'v451b@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'v451c@nebron.io' });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    for (const name of [
      'profiles',
      'posts',
      'reels',
      'comments',
      'comment_likes',
      'comment_reactions',
      'comment_thread_depth',
      'engagement_events',
      'impressions',
      'content_views',
      'relationships',
      'analytics_daily',
    ]) {
      await db.collection(name).deleteMany({});
    }
    await clearTestKeys();
    await Promise.all([
      seedProfile(userA, 'alice_v451'),
      seedProfile(userB, 'bob_v451'),
      seedProfile(userC, 'carol_v451'),
    ]);
  });

  // === Comment Reactions (8 tests) ===

  it('1. PUT adds reaction and public GET /comments/:id/reactions returns it without auth', async () => {
    const post = await createPost(tokenA, 'Post for reactions');
    const comment = await createComment(tokenB, post.id, 'Nice post!');

    const putRes = await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('🔥')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({
      reactions: [{ emoji: '🔥', count: 1, userIds: [userA] }],
    });

    const getPublic = await app.inject({
      method: 'GET',
      url: `/comments/${comment.id}/reactions`,
    });
    expect(getPublic.statusCode).toBe(200);
    expect(getPublic.json()).toEqual({
      reactions: [{ emoji: '🔥', count: 1, userIds: [userA] }],
    });
  });

  it('2. PUT reaction is idempotent for the same user and emoji', async () => {
    const post = await createPost(tokenA, 'Idempotent post');
    const comment = await createComment(tokenA, post.id, 'Comment body');

    const res1 = await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('❤️')}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const res2 = await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('❤️')}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res2.json().reactions).toEqual([{ emoji: '❤️', count: 1, userIds: [userB] }]);
  });

  it('3. Multiple different emojis coexist cleanly on the same comment', async () => {
    const post = await createPost(tokenA, 'Multi-emoji post');
    const comment = await createComment(tokenB, post.id, 'Cool');

    await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('👏')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const finalRes = await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('👍🏽')}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(finalRes.statusCode).toBe(200);
    expect(finalRes.json().reactions).toHaveLength(2);
    expect(finalRes.json().reactions).toEqual(
      expect.arrayContaining([
        { emoji: '👏', count: 1, userIds: [userA] },
        { emoji: '👍🏽', count: 1, userIds: [userB] },
      ])
    );
  });

  it('4. DELETE removes caller reaction and decrements count idempotently', async () => {
    const post = await createPost(tokenA, 'Remove reaction post');
    const comment = await createComment(tokenA, post.id, 'Great');

    await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('🚀')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('🚀')}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const delA = await app.inject({
      method: 'DELETE',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('🚀')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(delA.statusCode).toBe(200);
    expect(delA.json().reactions).toEqual([{ emoji: '🚀', count: 1, userIds: [userB] }]);

    // Idempotent repeat remove returns same summary cleanly
    const delARepeat = await app.inject({
      method: 'DELETE',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('🚀')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(delARepeat.statusCode).toBe(200);
    expect(delARepeat.json().reactions).toEqual([{ emoji: '🚀', count: 1, userIds: [userB] }]);
  });

  it('5. PUT reaction on deleted comment returns 400 deleted', async () => {
    const post = await createPost(tokenA, 'Deleted comment post');
    const comment = await createComment(tokenB, post.id, 'Will be deleted');

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/comments/${comment.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(delRes.statusCode).toBe(204);

    const reactRes = await app.inject({
      method: 'PUT',
      url: `/comments/${comment.id}/reactions/${encodeURIComponent('🔥')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(reactRes.statusCode).toBe(400);
    expect(reactRes.json().error.code).toBe('deleted');
  });

  it('6. Rejects invalid emojis and >8 codepoint emojis with 400', async () => {
    const post = await createPost(tokenA, 'Emoji validation post');
    const comment = await createComment(tokenB, post.id, 'Validate me');

    for (const bad of ['hello', '123', '#', encodeURIComponent('😀'.repeat(9)), encodeURIComponent('😀😀')]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/comments/${comment.id}/reactions/${bad}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('7. Batch-loads reactions on GET /posts/:id/comments (including topReplies) and GET /comments/:id/replies', async () => {
    const post = await createPost(tokenA, 'Batch comments post');
    const topComment = await createComment(tokenA, post.id, 'Root comment');
    const reply = await createComment(tokenB, post.id, 'Threaded reply', topComment.id);

    await app.inject({
      method: 'PUT',
      url: `/comments/${topComment.id}/reactions/${encodeURIComponent('🎉')}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    await app.inject({
      method: 'PUT',
      url: `/comments/${reply.id}/reactions/${encodeURIComponent('💯')}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });

    const commentsRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(commentsRes.statusCode).toBe(200);
    const list = commentsRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].reactions).toEqual([{ emoji: '🎉', count: 1, userIds: [userB] }]);
    expect(list[0].topReplies[0].reactions).toEqual([{ emoji: '💯', count: 1, userIds: [userC] }]);

    const repliesRes = await app.inject({
      method: 'GET',
      url: `/comments/${topComment.id}/replies`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(repliesRes.statusCode).toBe(200);
    expect(repliesRes.json()[0].reactions).toEqual([{ emoji: '💯', count: 1, userIds: [userC] }]);
  });

  it('8. Caps userIds per emoji reaction summary at 50 while preserving full count', async () => {
    const post = await createPost(tokenA, 'Popular reaction post');
    const comment = await createComment(tokenA, post.id, 'Viral comment');
    const commentOid = new ObjectId(comment.id);

    const docs = Array.from({ length: 65 }, (_, i) => ({
      commentId: commentOid,
      emoji: '🔥',
      userId: `usr_react_${i}`,
      createdAt: new Date(Date.now() + i),
    }));
    await db.collection('comment_reactions').insertMany(docs);

    const res = await app.inject({
      method: 'GET',
      url: `/comments/${comment.id}/reactions`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json().reactions[0];
    expect(summary.emoji).toBe('🔥');
    expect(summary.count).toBe(65);
    expect(summary.userIds).toHaveLength(50);
  });

  // === Engagement Depth (5 tests) ===

  it('9. Populates comment_thread_depth with depth 0 (top), 1 (reply), and 2 (reply-to-reply)', async () => {
    const post = await createPost(tokenA, 'Depth thread post');
    const c0 = await createComment(tokenA, post.id, 'Top comment');
    const c1 = await createComment(tokenB, post.id, 'Reply to top', c0.id);
    const c2 = await createComment(tokenC, post.id, 'Reply to reply', c1.id);

    const rows = await db
      .collection('comment_thread_depth')
      .find({ postId: new ObjectId(post.id) })
      .sort({ depth: 1 })
      .toArray();

    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.commentId.toString() === c0.id)?.depth).toBe(0);
    expect(rows.find((r) => r.commentId.toString() === c1.id)?.depth).toBe(1);
    expect(rows.find((r) => r.commentId.toString() === c2.id)?.depth).toBe(2);
  });

  it('10. Populates engagement_events from event consumer and long views', async () => {
    const post = await createPost(tokenA, 'Event stream post');
    const reelId = new ObjectId();
    await db.collection('reels').insertOne({
      _id: reelId,
      authorId: userA,
      caption: 'Depth reel',
      videoKey: `reels/${userA}/clip.mp4`,
      videoUrl: 'http://localhost:9000/nebron-media/reels/clip.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 15,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const topComment = await createComment(tokenB, post.id, 'First!');
    const replyComment = await createComment(tokenC, post.id, 'Second!', topComment.id);
    const at = new Date().toISOString();

    await handleEvent({ type: 'core.post.liked', data: { postId: post.id, authorId: userA, userId: userB, at } }, db);
    await handleEvent({ type: 'core.post.liked', data: { postId: post.id, authorId: userA, userId: userC, at } }, db);
    await handleEvent({ type: 'core.post.unliked', data: { postId: post.id, authorId: userA, userId: userC, at } }, db);
    await handleEvent({ type: 'core.comment.created', data: { commentId: topComment.id, postId: post.id, commentAuthorId: userB, postAuthorId: userA, body: 'First!', at } }, db);
    await handleEvent({ type: 'core.comment.created', data: { commentId: replyComment.id, postId: post.id, commentAuthorId: userC, postAuthorId: userA, body: 'Second!', at } }, db);
    await handleEvent({ type: 'core.comment.reaction.added', data: { commentId: topComment.id, postId: post.id, emoji: '❤️', userId: userA, at } }, db);
    await handleEvent({ type: 'core.post.saved', data: { postId: post.id, userId: userB, at } }, db);
    await handleEvent({ type: 'core.content.shared', data: { contentType: 'post', contentId: post.id, byUserId: userC, at } }, db);

    const postEvents = await db.collection('engagement_events').find({ contentType: 'post', contentId: post.id }).toArray();
    expect(postEvents.filter((e) => e.event === 'like')).toHaveLength(1);
    expect(postEvents.filter((e) => e.event === 'comment')).toHaveLength(1);
    expect(postEvents.filter((e) => e.event === 'reply')).toHaveLength(1);
    expect(postEvents.filter((e) => e.event === 'reaction')).toHaveLength(1);
    expect(postEvents.filter((e) => e.event === 'save')).toHaveLength(1);
    expect(postEvents.filter((e) => e.event === 'share')).toHaveLength(1);

    // Long view beacon on reel (watchedSeconds >= 5)
    const viewStart = await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reelId.toString(), source: 'feed', totalSeconds: 15 },
    });
    expect(viewStart.statusCode).toBe(201);
    const { viewId } = viewStart.json();

    const hb = await app.inject({
      method: 'POST',
      url: '/analytics/view-heartbeat',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId, watchedSeconds: 7.5 },
    });
    expect(hb.statusCode).toBe(204);

    const viewLongRows = await db.collection('engagement_events').find({
      contentType: 'reel',
      contentId: reelId.toString(),
      event: 'view_long',
    }).toArray();
    expect(viewLongRows).toHaveLength(1);
  });

  it('11. GET /analytics/me/content/:contentType/:contentId/depth returns breakdown, discussionScore, and enforces creator ownership', async () => {
    const post = await createPost(tokenA, 'Depth endpoint post');
    const c1 = await createComment(tokenB, post.id, 'Top');
    const c2 = await createComment(tokenC, post.id, 'Reply', c1.id);

    const at = new Date().toISOString();
    await handleEvent({ type: 'core.post.liked', data: { postId: post.id, authorId: userA, userId: userB, at } }, db);
    await handleEvent({ type: 'core.comment.created', data: { commentId: c1.id, postId: post.id, commentAuthorId: userB, postAuthorId: userA, body: 'Top', at } }, db);
    await handleEvent({ type: 'core.comment.created', data: { commentId: c2.id, postId: post.id, commentAuthorId: userC, postAuthorId: userA, body: 'Reply', at } }, db);
    await handleEvent({ type: 'core.comment.reaction.added', data: { commentId: c1.id, postId: post.id, emoji: '🔥', userId: userA, at } }, db);
    await handleEvent({ type: 'core.comment.reaction.added', data: { commentId: c1.id, postId: post.id, emoji: '🔥', userId: userC, at } }, db);

    // Non-owner cannot view depth
    const forbidden = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${post.id}/depth`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${post.id}/depth`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engagements.total).toBe(5);
    expect(body.engagements.unique).toBe(3); // userA, userB, userC
    expect(body.uniqueEngagedUsers).toBe(3);
    expect(body.engagements.breakdown.like).toEqual({ count: 1, uniqueUsers: 1 });
    expect(body.engagements.breakdown.comment).toEqual({ count: 1, uniqueUsers: 1 });
    expect(body.engagements.breakdown.reply).toEqual({ count: 1, uniqueUsers: 1 });
    expect(body.engagements.breakdown.reaction).toEqual({
      count: 2,
      uniqueUsers: 2,
      topEmojis: [{ emoji: '🔥', count: 2 }],
    });
    // discussionScore = 1 comment + 1 reply * 2 + 2 reactions * 0.5 = 4
    expect(body.discussionScore).toBe(4);
    expect(body.avgDepthPerUser).toBe(1.67);
  });

  it('12. Depth endpoint computes engagementRate = total / impressions accurately', async () => {
    const post = await createPost(tokenA, 'Engagement rate post');
    const now = new Date();
    await db.collection('impressions').insertMany([
      { userId: userB, contentType: 'post', contentId: post.id, source: 'feed', seenAt: now },
      { userId: userC, contentType: 'post', contentId: post.id, source: 'explore', seenAt: now },
      { userId: 'usr_extra_1', contentType: 'post', contentId: post.id, source: 'feed', seenAt: now },
      { userId: 'usr_extra_2', contentType: 'post', contentId: post.id, source: 'feed', seenAt: now },
    ]);
    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: post.id, userId: userB, event: 'like', at: now },
      { contentType: 'post', contentId: post.id, userId: userB, event: 'save', at: now },
      { contentType: 'post', contentId: post.id, userId: userC, event: 'share', at: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${post.id}/depth`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.impressions).toBe(4);
    expect(body.reach).toBe(4);
    expect(body.engagementRate).toBe(0.75); // 3 engagements / 4 impressions
  });

  it('13. Depth endpoint caps topCommenters at 10 sorted descending by commentCount', async () => {
    const post = await createPost(tokenA, 'Many commenters post');
    const postOid = new ObjectId(post.id);

    const profileDocs = [];
    const commentDocs = [];
    for (let u = 1; u <= 12; u++) {
      const uid = `usr_top_${u}`;
      profileDocs.push({
        userId: uid,
        username: `commenter_${u}`,
        name: `Commenter ${u}`,
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (let k = 0; k < u; k++) {
        commentDocs.push({
          postId: postOid,
          targetType: 'post',
          authorId: uid,
          body: `Comment ${k}`,
          parentCommentId: null,
          likeCount: 0,
          replyCount: 0,
          deleted: false,
          createdAt: new Date(),
        });
      }
    }
    await db.collection('profiles').insertMany(profileDocs);
    await db.collection('comments').insertMany(commentDocs);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${post.id}/depth`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.topCommenters).toHaveLength(10);
    expect(body.topCommenters[0]).toMatchObject({
      userId: 'usr_top_12',
      username: 'commenter_12',
      commentCount: 12,
    });
    expect(body.topCommenters[9]).toMatchObject({
      userId: 'usr_top_3',
      username: 'commenter_3',
      commentCount: 3,
    });
  });
});
