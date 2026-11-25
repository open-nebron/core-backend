import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Social - Stage 7D (Edit, Popular, Likes Tab)', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const viewer = crypto.randomUUID();
  const user1 = crypto.randomUUID();
  const user2 = crypto.randomUUID();
  const blockedUser = crypto.randomUUID();

  let tokenViewer: string;
  let tokenUser1: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_7d_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenViewer = await createMockAccessToken({ sub: viewer, email: 'viewer@nebron.io' });
    tokenUser1 = await createMockAccessToken({ sub: user1, email: 'user1@nebron.io' });

    // Seed profiles
    const profiles = db.collection('profiles');
    const now = new Date();
    await profiles.insertMany([
      {
        userId: viewer,
        username: 'viewer_7d',
        name: 'Viewer 7D',
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
        userId: user1,
        username: 'user1_7d',
        name: 'User 1 7D',
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
        userId: user2,
        username: 'user2_7d',
        name: 'User 2 7D',
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
        userId: blockedUser,
        username: 'blocked_7d',
        name: 'Blocked User',
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

    // Block relationship: viewer blocked blockedUser
    await db.collection('relationships').insertOne({
      fromUserId: viewer,
      toUserId: blockedUser,
      blocked: true,
      muted: { calls: false, messages: false, until: null },
      createdAt: now,
      updatedAt: now,
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (client) {
      await db.dropDatabase();
      await client.close();
    }
  });

  it('1. PATCH /posts/:id — edit own post body', async () => {
    // User1 creates post
    const createRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { body: 'Original post body' },
    });
    expect(createRes.statusCode).toBe(201);
    const post = createRes.json();

    // User1 edits post body
    const editRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { body: 'Updated post body content' },
    });
    expect(editRes.statusCode).toBe(200);
    const updated = editRes.json();
    expect(updated.body).toBe('Updated post body content');
    expect(updated.updatedAt).toBeDefined();

    // Fetch single post to confirm persistence
    const getRes = await app.inject({
      method: 'GET',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenUser1}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().body).toBe('Updated post body content');
  });

  it('2. PATCH post — remove image', async () => {
    // Insert post directly with image
    const now = new Date();
    const insertRes = await db.collection('posts').insertOne({
      authorId: user1,
      body: 'Post with image',
      imageKey: `posts/${user1}/sample.png`,
      imageUrl: `http://localhost:9000/nebron-media/posts/${user1}/sample.png`,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    const postId = insertRes.insertedId.toString();

    // User1 removes image
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${postId}`,
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { removeImage: true },
    });
    expect(patchRes.statusCode).toBe(200);
    const resBody = patchRes.json();
    expect(resBody.imageKey).toBeNull();
    expect(resBody.imageUrl).toBeNull();
    expect(resBody.body).toBe('Post with image');
  });

  it("3. PATCH other's post -> 403", async () => {
    // User1 post
    const createRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { body: 'User 1 post' },
    });
    const post = createRes.json();

    // Viewer attempts to edit user1 post
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenViewer}` },
      payload: { body: 'Hacked post' },
    });
    expect(patchRes.statusCode).toBe(403);
    expect(patchRes.json().error.code).toBe('not_post_author');
  });

  it('4. GET /users/me/likes returns correctly', async () => {
    // Create posts
    const p1Res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { body: 'User1 post for likes test' },
    });
    const p1 = p1Res.json();

    // Viewer likes p1
    await app.inject({
      method: 'POST',
      url: `/posts/${p1.id}/like`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    // Viewer fetches own likes
    const likesRes = await app.inject({
      method: 'GET',
      url: '/users/me/likes',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });
    expect(likesRes.statusCode).toBe(200);
    const likesList = likesRes.json();
    expect(Array.isArray(likesList)).toBe(true);
    expect(likesList.length).toBeGreaterThanOrEqual(1);
    expect(likesList[0].id).toBe(p1.id);
    expect(likesList[0].likedByViewer).toBe(true);
  });

  it('5. GET /posts/popular returns sorted by likes', async () => {
    // Seed 3 posts with different likeCounts
    const now = new Date();
    const postLow = await db.collection('posts').insertOne({
      authorId: user1,
      body: 'Low likes post',
      imageKey: null,
      imageUrl: null,
      likeCount: 2,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    const postHigh = await db.collection('posts').insertOne({
      authorId: user2,
      body: 'High likes post',
      imageKey: null,
      imageUrl: null,
      likeCount: 25,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    const postMedium = await db.collection('posts').insertOne({
      authorId: user1,
      body: 'Medium likes post',
      imageKey: null,
      imageUrl: null,
      likeCount: 10,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });

    const popRes = await app.inject({
      method: 'GET',
      url: '/posts/popular?limit=10',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });
    expect(popRes.statusCode).toBe(200);
    const popList = popRes.json();
    expect(popList.length).toBeGreaterThanOrEqual(3);

    // Verify ordering
    const idxHigh = popList.findIndex((p: any) => p.id === postHigh.insertedId.toString());
    const idxMed = popList.findIndex((p: any) => p.id === postMedium.insertedId.toString());
    const idxLow = popList.findIndex((p: any) => p.id === postLow.insertedId.toString());

    expect(idxHigh).toBeLessThan(idxMed);
    expect(idxMed).toBeLessThan(idxLow);
  });

  it('6. GET /posts/popular respects block filter', async () => {
    // Seed post by blockedUser with huge likeCount
    const now = new Date();
    const blockedPost = await db.collection('posts').insertOne({
      authorId: blockedUser,
      body: 'Super popular blocked user post',
      imageKey: null,
      imageUrl: null,
      likeCount: 999,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });

    const popRes = await app.inject({
      method: 'GET',
      url: '/posts/popular?limit=20',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });
    expect(popRes.statusCode).toBe(200);
    const popList = popRes.json();
    const found = popList.find((p: any) => p.id === blockedPost.insertedId.toString());
    expect(found).toBeUndefined();
  });

  it('7. Edit event published', async () => {
    // Create and edit a post to check event stream
    const createRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { body: 'Body for event verification' },
    });
    const post = createRes.json();

    await app.inject({
      method: 'PATCH',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${tokenUser1}` },
      payload: { body: 'Updated body for event verification' },
    });

    // Check Redis stream nebron.events
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 10);
    const editEvent = events.find(([_, fields]) => {
      const typeIdx = fields.indexOf('type');
      return typeIdx !== -1 && fields[typeIdx + 1] === 'core.post.edited';
    });

    expect(editEvent).toBeDefined();
    if (editEvent) {
      const payloadIdx = editEvent[1].indexOf('payload');
      const payload = JSON.parse(editEvent[1][payloadIdx + 1]);
      expect(payload.postId).toBe(post.id);
      expect(payload.authorId).toBe(user1);
      expect(payload.body).toBe('Updated body for event verification');
    }
  });
});
