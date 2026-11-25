import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient, closeRedis } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Social - Likes Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();

  let tokenUserA: string;
  let tokenUserB: string;
  let targetPostId: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_likes_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenUserA = await createMockAccessToken({ sub: userA, email: 'usera@nebron.io' });
    tokenUserB = await createMockAccessToken({ sub: userB, email: 'userb@nebron.io' });

    // Seed profiles
    const profiles = db.collection('profiles');
    const now = new Date();
    await profiles.insertMany([
      {
        userId: userA,
        username: 'alice_likes',
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
        username: 'bob_likes',
        name: 'Bob',
        language: 'en',
        theme: 'light',
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

    // Alice creates a post
    const postRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUserA}` },
      payload: { body: 'Likeable post by Alice' },
    });
    expect(postRes.statusCode).toBe(201);
    targetPostId = postRes.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  async function findLikeEvent(type: string, postId: string, userId: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 50);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type && fieldMap.payload) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.postId === postId && payload.userId === userId) {
          return payload;
        }
      }
    }
    return null;
  }

  // 1. Like post → count incremented, event published
  it('Like post -> count incremented, event published', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${targetPostId}/like`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(res.statusCode).toBe(204);

    const postRes = await app.inject({
      method: 'GET',
      url: `/posts/${targetPostId}`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(postRes.statusCode).toBe(200);
    const post = postRes.json();
    expect(post.likeCount).toBe(1);
    expect(post.likedByViewer).toBe(true);

    const event = await findLikeEvent('core.post.liked', targetPostId, userB);
    expect(event).toBeDefined();
    expect(event?.authorId).toBe(userA);
  });

  // 2. Like twice → idempotent
  it('Like twice -> idempotent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${targetPostId}/like`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(res.statusCode).toBe(204);

    const postRes = await app.inject({
      method: 'GET',
      url: `/posts/${targetPostId}`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(postRes.statusCode).toBe(200);
    expect(postRes.json().likeCount).toBe(1);
  });

  // 3. Unlike → decremented
  it('Unlike -> decremented', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/posts/${targetPostId}/like`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(res.statusCode).toBe(204);

    const postRes = await app.inject({
      method: 'GET',
      url: `/posts/${targetPostId}`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(postRes.statusCode).toBe(200);
    const post = postRes.json();
    expect(post.likeCount).toBe(0);
    expect(post.likedByViewer).toBe(false);

    const event = await findLikeEvent('core.post.unliked', targetPostId, userB);
    expect(event).toBeDefined();
    expect(event?.authorId).toBe(userA);
  });

  // 4. Likes list returns users
  it('Likes list returns users', async () => {
    // Both Alice and Bob like the post
    await app.inject({
      method: 'POST',
      url: `/posts/${targetPostId}/like`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });
    await app.inject({
      method: 'POST',
      url: `/posts/${targetPostId}/like`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/posts/${targetPostId}/likes`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(res.statusCode).toBe(200);
    const likers = res.json();
    expect(likers.length).toBe(2);
    expect(likers.map((u: any) => u.userId)).toContain(userA);
    expect(likers.map((u: any) => u.userId)).toContain(userB);
    expect(likers[0].username).toBeDefined();
  });
});
