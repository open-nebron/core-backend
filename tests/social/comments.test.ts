import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import * as r2Module from '../../src/lib/r2.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Social - Media & Comments Module (Stage 7C)', () => {
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

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_comments_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'usera@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'userb@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'userc@nebron.io' });

    // Seed profiles
    const profiles = db.collection('profiles');
    const now = new Date();
    await profiles.insertMany([
      {
        userId: userA,
        username: 'alice_c',
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
        username: 'bob_c',
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
        username: 'charlie_c',
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

    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (client) {
      await db.dropDatabase();
      await mongoDb.closeMongo();
    }
  });

  // 1. Upload presigned URL returns correct prefix
  it('1. Upload presigned URL returns correct prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts/image/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'image/png',
        contentLength: 2048,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadUrl).toBeDefined();
    expect(body.fields).toBeDefined();
    expect(body.objectKey).toMatch(new RegExp(`^posts/${userA}/.+\\.png$`));
  });

  // 2. Confirm rejects wrong-prefix key
  it('2. Confirm rejects wrong-prefix key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts/image/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        objectKey: `posts/${userB}/some-image.png`,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  // 3. POST with imageKey creates post with image
  it('3. POST with imageKey creates post with image', async () => {
    const imageKey = `posts/${userA}/valid-image.png`;
    vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce({
      contentLength: 2048,
      contentType: 'image/png',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        body: 'Post with image attachment',
        imageKey,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.imageKey).toBe(imageKey);
    expect(body.imageUrl).toContain(imageKey);
  });

  // Helper to create a fresh post by userA
  let sharedPostId: string;
  it('setup: create shared post', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Discussion post by Alice' },
    });
    expect(res.statusCode).toBe(201);
    sharedPostId = res.json().id;
  });

  // 4. Comments CRUD works
  let commentAId: string;
  it('4. Comments CRUD works', async () => {
    // Create comment by Bob
    const resCreate = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Nice post, Alice!' },
    });
    expect(resCreate.statusCode).toBe(201);
    const comment = resCreate.json();
    expect(comment.id).toBeDefined();
    expect(comment.body).toBe('Nice post, Alice!');
    expect(comment.author.userId).toBe(userB);
    expect(comment.author.username).toBe('bob_c');
    commentAId = comment.id;

    // List comments
    const resList = await app.inject({
      method: 'GET',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resList.statusCode).toBe(200);
    const list = resList.json();
    expect(list.some((c: any) => c.id === commentAId)).toBe(true);

    // Delete comment
    const resDelete = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentAId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resDelete.statusCode).toBe(204);

    // Verify deleted
    const resListAfter = await app.inject({
      method: 'GET',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resListAfter.json().some((c: any) => c.id === commentAId)).toBe(false);
  });

  // 5. Comment on deleted post -> 404
  it('5. Comment on deleted post -> 404', async () => {
    // Create a temporary post and delete it
    const resPost = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Post to delete' },
    });
    const tempPostId = resPost.json().id;

    await app.inject({
      method: 'DELETE',
      url: `/posts/${tempPostId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const resComment = await app.inject({
      method: 'POST',
      url: `/posts/${tempPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'This should fail' },
    });
    expect(resComment.statusCode).toBe(404);
  });

  // 6. Comment on blocked user's post -> 403
  it("6. Comment on blocked user's post -> 403", async () => {
    // UserA blocks UserC
    const relCol = db.collection('relationships');
    await relCol.insertOne({
      fromUserId: userA,
      toUserId: userC,
      blocked: true,
      muted: { messages: false, calls: false, until: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await redis.del(`rel:blocked:${userA}`);
    await redis.del(`rel:blocked:${userC}`);

    const res = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Blocked comment attempt' },
    });
    expect(res.statusCode).toBe(403);
  });

  // 7. Delete own comment -> success
  it('7. Delete own comment -> success', async () => {
    const resCreate = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Bob deletes own comment' },
    });
    expect(resCreate.statusCode).toBe(201);
    const commentId = resCreate.json().id;

    const resDelete = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resDelete.statusCode).toBe(204);
  });

  // 8. Delete comment on your post (post owner) -> success
  it("8. Delete comment on your post (post owner) -> success", async () => {
    // Bob comments on Alice's post
    const resCreate = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Bob comment on Alice post' },
    });
    expect(resCreate.statusCode).toBe(201);
    const commentId = resCreate.json().id;

    // Alice (post owner) deletes Bob's comment
    const resDelete = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resDelete.statusCode).toBe(204);
  });

  // 9. Delete other's comment on someone else's post -> 403
  it("9. Delete other's comment on someone else's post -> 403", async () => {
    // Bob comments on Alice's post
    const resCreate = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Protected comment' },
    });
    expect(resCreate.statusCode).toBe(201);
    const commentId = resCreate.json().id;

    // Charlie tries to delete Bob's comment on Alice's post
    const resDelete = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(resDelete.statusCode).toBe(403);
  });

  // 10. Comment count incremented/decremented correctly
  it('10. Comment count incremented/decremented correctly', async () => {
    // Check initial count
    const resBefore = await app.inject({
      method: 'GET',
      url: `/posts/${sharedPostId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const countBefore = resBefore.json().commentCount;

    // Add comment
    const resCreate = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Count test comment' },
    });
    const commentId = resCreate.json().id;

    const resAfterAdd = await app.inject({
      method: 'GET',
      url: `/posts/${sharedPostId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resAfterAdd.json().commentCount).toBe(countBefore + 1);

    // Delete comment
    await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const resAfterDel = await app.inject({
      method: 'GET',
      url: `/posts/${sharedPostId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resAfterDel.json().commentCount).toBe(countBefore);
  });

  // 11. Comments filtered for blocked users
  it('11. Comments filtered for blocked users', async () => {
    // Unblock Charlie for this test setup
    const relCol = db.collection('relationships');
    await relCol.deleteMany({ fromUserId: userA, toUserId: userC });
    await redis.del(`rel:blocked:${userA}`);
    await redis.del(`rel:blocked:${userC}`);

    // Charlie comments on Alice's post
    const resCharlie = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Comment from Charlie' },
    });
    expect(resCharlie.statusCode).toBe(201);
    const charlieCommentId = resCharlie.json().id;

    // Bob also comments
    const resBob = await app.inject({
      method: 'POST',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Comment from Bob' },
    });
    expect(resBob.statusCode).toBe(201);
    const bobCommentId = resBob.json().id;

    // Now Alice blocks Charlie
    await relCol.insertOne({
      fromUserId: userA,
      toUserId: userC,
      blocked: true,
      muted: { messages: false, calls: false, until: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await redis.del(`rel:blocked:${userA}`);
    await redis.del(`rel:blocked:${userC}`);

    // Alice views comments: Charlie's comment must be omitted
    const resListAlice = await app.inject({
      method: 'GET',
      url: `/posts/${sharedPostId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const ids = resListAlice.json().map((c: any) => c.id);
    expect(ids).not.toContain(charlieCommentId);
    expect(ids).toContain(bobCommentId);
  });

  // 12. Comments pagination
  it('12. Comments pagination', async () => {
    // Create dedicated post
    const resPost = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Pagination test post' },
    });
    const pId = resPost.json().id;

    // Insert 5 comments with 100ms timestamps
    const commentsCol = db.collection('comments');
    const baseTime = Date.now();
    for (let i = 0; i < 5; i++) {
      await commentsCol.insertOne({
        postId: new ObjectId(pId),
        authorId: userB,
        body: `Comment ${i}`,
        deleted: false,
        createdAt: new Date(baseTime + i * 1000),
      });
    }

    // Page 1: limit 2 (default sort=top DESC -> Comment 4, Comment 3)
    const res1 = await app.inject({
      method: 'GET',
      url: `/posts/${pId}/comments?limit=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json();
    expect(page1.length).toBe(2);
    expect(page1[0].body).toBe('Comment 4');
    expect(page1[1].body).toBe('Comment 3');

    // Page 2: before date of comment 3, limit 2 -> Comment 2, Comment 1
    const beforeDate = new Date(baseTime + 3 * 1000).toISOString();
    const res2 = await app.inject({
      method: 'GET',
      url: `/posts/${pId}/comments?limit=2&before=${encodeURIComponent(beforeDate)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json();
    expect(page2.length).toBe(2);
    expect(page2[0].body).toBe('Comment 2');
    expect(page2[1].body).toBe('Comment 1');
  });

  // =========================================================================
  // V4-1: Threaded comments & comment likes (17 tests)
  // =========================================================================

  async function resetRateLimitsForTestUsers() {
    const keys = [
      ...(await redis.keys(`ratelimit:*:${userA}:*`)),
      ...(await redis.keys(`ratelimit:*:${userB}:*`)),
      ...(await redis.keys(`ratelimit:*:${userC}:*`)),
    ];
    if (keys.length > 0) await redis.del(...keys);
  }

  async function createFreshDiscussionPost(title: string): Promise<string> {
    await resetRateLimitsForTestUsers();
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: title },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('13. Reply to top-level comment -> parent.replyCount++', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 13 post');
    const rootRes = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Root comment' },
    });
    expect(rootRes.statusCode).toBe(201);
    const root = rootRes.json();

    const streamBefore = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 1);
    const lastId = streamBefore[0]?.[0] || '0-0';

    const replyRes = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { body: 'Direct reply to root', parentCommentId: root.id },
    });
    expect(replyRes.statusCode).toBe(201);
    const reply = replyRes.json();
    expect(reply.parentCommentId).toBe(root.id);
    expect(reply.replyToUserId).toBeNull();
    expect(reply.parent?.id).toBe(root.id);

    const rootDoc = await db.collection('comments').findOne({ _id: new ObjectId(root.id) });
    expect(rootDoc?.replyCount).toBe(1);

    const events = await redis.xrange('nebron.events', `(${lastId}`, '+');
    expect(
      events.some(([, fields]) => {
        const idx = fields.indexOf('type');
        return idx !== -1 && fields[idx + 1] === 'core.comment.replied';
      })
    ).toBe(true);
  });

  it('14. Reply to reply in two-level mode -> flattened to root parent, replyToUserId set correctly', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 14 post');
    await db.collection('relationships').deleteMany({ fromUserId: userA, toUserId: userC });
    await redis.del(`rel:blocked:${userA}`, `rel:blocked:${userC}`);

    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Root' },
      })
    ).json().id;

    const reply1Id = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Bob reply', parentCommentId: rootId },
      })
    ).json().id;

    const reply2Res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Charlie replying to Bob', parentCommentId: reply1Id },
    });
    expect(reply2Res.statusCode).toBe(201);
    const reply2 = reply2Res.json();
    expect(reply2.parentCommentId).toBe(rootId);
    expect(reply2.replyToUserId).toBe(userB);
    expect(reply2.replyToUser).toEqual({ userId: userB, username: 'bob_c' });
  });

  it('15. Comment on reply-to-reply does not exceed 2 levels in two-level mode', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 15 post');
    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Root' },
      })
    ).json().id;

    const lvl1Id = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Level 1', parentCommentId: rootId },
      })
    ).json().id;

    const lvl2Id = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenC}` },
        payload: { body: 'Level 2', parentCommentId: lvl1Id },
      })
    ).json().id;

    const lvl3Res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Level 3 reply', parentCommentId: lvl2Id },
    });
    expect(lvl3Res.statusCode).toBe(201);
    const lvl3 = lvl3Res.json();
    expect(lvl3.parentCommentId).toBe(rootId);
    expect(lvl3.replyToUserId).toBe(userC);
    expect(lvl3.replyToUser).toEqual({ userId: userC, username: 'charlie_c' });

    const replies = (
      await app.inject({
        method: 'GET',
        url: `/comments/${rootId}/replies`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(replies.length).toBe(3);
    expect(replies.every((r: any) => r.parentCommentId === rootId)).toBe(true);
  });

  it('16. Reply to deleted parent -> 400 invalid_parent', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 16 post');
    const deletedCommentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Temp comment' },
      })
    ).json().id;

    await app.inject({
      method: 'DELETE',
      url: `/comments/${deletedCommentId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Reply to deleted parent', parentCommentId: deletedCommentId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_parent');
  });

  it('17. Reply to wrong-post or malformed parent -> 400 invalid_parent', async () => {
    const p1Id = await createFreshDiscussionPost('V4-1 test 17 p1');
    const p2Id = await createFreshDiscussionPost('V4-1 test 17 p2');

    const badRes = await app.inject({
      method: 'POST',
      url: `/posts/${p1Id}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Bad parent', parentCommentId: 'not-an-object-id' },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.code).toBe('invalid_parent');

    const otherPostCommentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${p2Id}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Comment on p2' },
      })
    ).json().id;

    const crossRes = await app.inject({
      method: 'POST',
      url: `/posts/${p1Id}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Cross post reply', parentCommentId: otherPostCommentId },
    });
    expect(crossRes.statusCode).toBe(400);
    expect(crossRes.json().error.code).toBe('invalid_parent');
  });

  it('18. Like comment -> likeCount++, idempotent', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 18 post');
    const commentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Like me' },
      })
    ).json().id;

    const like1 = await app.inject({
      method: 'POST',
      url: `/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(like1.statusCode).toBe(204);

    const like2 = await app.inject({
      method: 'POST',
      url: `/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(like2.statusCode).toBe(204);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
      })
    ).json();
    expect(list[0].likeCount).toBe(1);
    expect(list[0].likedByViewer).toBe(true);
  });

  it('19. Liking own comment allowed', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 19 post');
    const commentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Self like comment' },
      })
    ).json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(204);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list[0].likeCount).toBe(1);
    expect(list[0].likedByViewer).toBe(true);
  });

  it('20. Unlike -> decrement and emits core.comment.unliked', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 20 post');
    const commentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Unlike me' },
      })
    ).json().id;

    await app.inject({
      method: 'POST',
      url: `/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const streamBefore = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 1);
    const lastId = streamBefore[0]?.[0] || '0-0';

    const unlikeRes = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(unlikeRes.statusCode).toBe(204);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
      })
    ).json();
    expect(list[0].likeCount).toBe(0);
    expect(list[0].likedByViewer).toBe(false);

    const events = await redis.xrange('nebron.events', `(${lastId}`, '+');
    expect(
      events.some(([, fields]) => {
        const idx = fields.indexOf('type');
        return idx !== -1 && fields[idx + 1] === 'core.comment.unliked';
      })
    ).toBe(true);
  });

  it('21. Comment like count does not drop below 0 on idempotent unlike', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 21 post');
    const commentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Zero floor comment' },
      })
    ).json().id;

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/comments/${commentId}/like`,
          headers: { authorization: `Bearer ${tokenB}` },
        })
      ).statusCode
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/comments/${commentId}/like`,
          headers: { authorization: `Bearer ${tokenC}` },
        })
      ).statusCode
    ).toBe(204);

    const doc = await db.collection('comments').findOne({ _id: new ObjectId(commentId) });
    expect(doc?.likeCount).toBe(0);
  });

  it('22. Top-level comments list sorts top vs new', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 22 post');
    const olderLikedId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Older popular' },
      })
    ).json().id;

    await new Promise((r) => setTimeout(r, 20));

    const newerZeroId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenC}` },
        payload: { body: 'Newer zero likes' },
      })
    ).json().id;

    await app.inject({
      method: 'POST',
      url: `/comments/${olderLikedId}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const topList = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments?sort=top`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(topList[0].id).toBe(olderLikedId);
    expect(topList[1].id).toBe(newerZeroId);

    const newList = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments?sort=new`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(newList[0].id).toBe(newerZeroId);
    expect(newList[1].id).toBe(olderLikedId);
  });

  it('23. topReplies preview (max 3) returned on GET /posts/:id/comments', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 23 post');
    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Parent with 5 replies' },
      })
    ).json().id;

    for (let i = 1; i <= 5; i++) {
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: `Reply #${i}`, parentCommentId: rootId },
      });
    }

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list[0].replyCount).toBe(5);
    expect(list[0].topReplies.length).toBe(3);
  });

  it('24. Deleted parent with replies shows "[deleted]" but replies visible', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 24 post');
    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Parent to delete' },
      })
    ).json().id;

    const childId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenC}` },
        payload: { body: 'Still visible reply', parentCommentId: rootId },
      })
    ).json().id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/comments/${rootId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(delRes.statusCode).toBe(204);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list.length).toBe(1);
    expect(list[0].body).toBe('[deleted]');
    expect(list[0].deleted).toBe(true);
    expect(list[0].topReplies.some((r: any) => r.id === childId)).toBe(true);

    const repliesRes = await app.inject({
      method: 'GET',
      url: `/comments/${rootId}/replies`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(repliesRes.statusCode).toBe(200);
    expect(repliesRes.json().some((r: any) => r.id === childId)).toBe(true);
  });

  it('25. Deleted parent without replies removed from list', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 25 post');
    const commentId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'No replies comment' },
      })
    ).json().id;

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/comments/${commentId}`,
          headers: { authorization: `Bearer ${tokenB}` },
        })
      ).statusCode
    ).toBe(204);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list.some((c: any) => c.id === commentId)).toBe(false);
  });

  it('26. replyCount correct after multiple replies and reply deletions', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 26 post');
    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Counter root' },
      })
    ).json().id;

    const r1Id = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'First reply', parentCommentId: rootId },
      })
    ).json().id;

    await app.inject({
      method: 'POST',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Second reply', parentCommentId: rootId },
    });

    let doc = await db.collection('comments').findOne({ _id: new ObjectId(rootId) });
    expect(doc?.replyCount).toBe(2);

    await app.inject({
      method: 'DELETE',
      url: `/comments/${r1Id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    doc = await db.collection('comments').findOne({ _id: new ObjectId(rootId) });
    expect(doc?.replyCount).toBe(1);
  });

  it('27. Reply list pagination', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 27 post');
    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Paginated parent' },
      })
    ).json().id;

    const base = Date.now() - 10000;
    const commentsCol = db.collection('comments');
    for (let i = 0; i < 4; i++) {
      await commentsCol.insertOne({
        targetType: 'post',
        postId: new ObjectId(postId),
        parentCommentId: new ObjectId(rootId),
        replyToUserId: null,
        authorId: userB,
        body: `Reply ${i}`,
        likeCount: 0,
        replyCount: 0,
        deleted: false,
        createdAt: new Date(base + i * 1000),
      });
    }

    const p1 = (
      await app.inject({
        method: 'GET',
        url: `/comments/${rootId}/replies?limit=2`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(p1.length).toBe(2);
    expect(p1[0].body).toBe('Reply 3');
    expect(p1[1].body).toBe('Reply 2');

    const p2 = (
      await app.inject({
        method: 'GET',
        url: `/comments/${rootId}/replies?limit=2&before=${encodeURIComponent(p1[1].createdAt)}`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(p2.length).toBe(2);
    expect(p2[0].body).toBe('Reply 1');
    expect(p2[1].body).toBe('Reply 0');
  });

  it('28. Block filter in replies and comment lists', async () => {
    const postId = await createFreshDiscussionPost('V4-1 test 28 post');
    const rootId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Shared parent' },
      })
    ).json().id;

    const charlieReplyId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenC}` },
        payload: { body: 'Charlie reply before block', parentCommentId: rootId },
      })
    ).json().id;

    const aliceReplyId = (
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: 'Alice reply', parentCommentId: rootId },
      })
    ).json().id;

    // Alice blocks Charlie
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userC,
      blocked: true,
      muted: { messages: false, calls: false, until: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await redis.del(`rel:blocked:${userA}`, `rel:blocked:${userC}`);

    const replies = (
      await app.inject({
        method: 'GET',
        url: `/comments/${rootId}/replies`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(replies.some((r: any) => r.id === charlieReplyId)).toBe(false);
    expect(replies.some((r: any) => r.id === aliceReplyId)).toBe(true);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/posts/${postId}/comments`,
        headers: { authorization: `Bearer ${tokenA}` },
      })
    ).json();
    expect(list[0].topReplies.some((r: any) => r.id === charlieReplyId)).toBe(false);
    expect(list[0].topReplies.some((r: any) => r.id === aliceReplyId)).toBe(true);

    const blockLikeRes = await app.inject({
      method: 'POST',
      url: `/comments/${charlieReplyId}/like`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(blockLikeRes.statusCode).toBe(403);
  });

  it('29. Migration defaults missing V4-1 comment fields once via migrations collection', async () => {
    const migrationsCol = db.collection('migrations');
    const migration = await migrationsCol.findOne({ _id: 'v4_1_comments_threading' as any });
    expect(migration).toBeTruthy();

    const postId = await createFreshDiscussionPost('V4-1 test 29 post');
    await db.collection('comments').insertOne({
      postId: new ObjectId(postId),
      authorId: userB,
      body: 'Pre-V4 comment',
      deleted: false,
      createdAt: new Date(),
    });

    const listRes = await app.inject({
      method: 'GET',
      url: `/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()[0].body).toBe('Pre-V4 comment');
    expect(listRes.json()[0].likeCount).toBe(0);
    expect(listRes.json()[0].replyCount).toBe(0);
    expect(listRes.json()[0].likedByViewer).toBe(false);
    expect(listRes.json()[0].parentCommentId).toBeNull();
  });
});
