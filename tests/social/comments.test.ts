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

    // Page 1: limit 2
    const res1 = await app.inject({
      method: 'GET',
      url: `/posts/${pId}/comments?limit=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json();
    expect(page1.length).toBe(2);
    expect(page1[0].body).toBe('Comment 0');
    expect(page1[1].body).toBe('Comment 1');

    // Page 2: before date of comment 4, limit 2
    const beforeDate = new Date(baseTime + 4 * 1000).toISOString();
    const res2 = await app.inject({
      method: 'GET',
      url: `/posts/${pId}/comments?limit=2&before=${encodeURIComponent(beforeDate)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json();
    expect(page2.length).toBe(2);
    expect(page2[0].body).toBe('Comment 0');
    expect(page2[1].body).toBe('Comment 1');
  });
});
