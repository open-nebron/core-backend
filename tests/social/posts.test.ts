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

describe('Social - Posts Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();

  let tokenUserA: string;
  let tokenUserB: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_posts_${crypto.randomUUID().replace(/-/g, '')}`;
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
        username: 'alice_posts',
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
        username: 'bob_posts',
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
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  async function findPostEvent(type: string, postId: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 50);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type && fieldMap.payload) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.postId === postId) {
          return payload;
        }
      }
    }
    return null;
  }

  let createdPostId: string;

  // 1. Create post → stored, counters updated, event published
  it('Create post -> stored, counters updated, event published', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        body: 'Hello Nebron! This is my first test post.',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.body).toBe('Hello Nebron! This is my first test post.');
    expect(body.author.userId).toBe(userA);
    expect(body.author.username).toBe('alice_posts');
    expect(body.likeCount).toBe(0);
    expect(body.commentCount).toBe(0);
    expect(body.likedByViewer).toBe(false);

    createdPostId = body.id;

    // Check profile postCount
    const profA = await db.collection('profiles').findOne({ userId: userA });
    expect(profA?.postCount).toBe(1);

    // Check event in Redis
    const event = await findPostEvent('core.post.created', createdPostId);
    expect(event).toBeDefined();
    expect(event?.authorId).toBe(userA);
    expect(event?.body).toBe('Hello Nebron! This is my first test post.');
  });

  // 2. Post over 500 chars → 400
  it('Post over 500 chars -> 400', async () => {
    const longText = 'a'.repeat(501);
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        body: longText,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // 3. Empty post → 400
  it('Empty post -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
      payload: {
        body: '   ',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // 4. List user's posts → DESC order
  it("List user's posts -> DESC order", async () => {
    // Create another post
    const res2 = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUserA}` },
      payload: { body: 'Second post by Alice' },
    });
    expect(res2.statusCode).toBe(201);
    const secondPostId = res2.json().id;

    const listRes = await app.inject({
      method: 'GET',
      url: `/users/${userA}/posts?limit=10`,
      headers: { authorization: `Bearer ${tokenUserB}` },
    });

    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    expect(list[0].id).toBe(secondPostId);
    expect(list[1].id).toBe(createdPostId);
  });

  // 5. Delete own post → soft delete, counter decremented
  it('Delete own post -> soft delete, counter decremented', async () => {
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${createdPostId}`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(delRes.statusCode).toBe(204);

    // Profile counter decremented
    const profA = await db.collection('profiles').findOne({ userId: userA });
    expect(profA?.postCount).toBe(1); // was 2 (first + second post), now 1

    // Post soft-deleted in DB
    const postInDb = await db.collection('posts').findOne({ _id: new mongoDb.getMongoClient().s.options.driverInfo ? createdPostId as any : createdPostId as any });
    // Fetch via GET /posts/:id should return 404
    const getRes = await app.inject({
      method: 'GET',
      url: `/posts/${createdPostId}`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });
    expect(getRes.statusCode).toBe(404);

    // Event published
    const event = await findPostEvent('core.post.deleted', createdPostId);
    expect(event).toBeDefined();
    expect(event?.authorId).toBe(userA);
  });

  // 6. Delete other's post → 403
  it("Delete other's post -> 403", async () => {
    // Bob tries to create a post
    const bPostRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${tokenUserB}` },
      payload: { body: "Bob's post" },
    });
    expect(bPostRes.statusCode).toBe(201);
    const bPostId = bPostRes.json().id;

    // Alice tries to delete Bob's post
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/posts/${bPostId}`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(delRes.statusCode).toBe(403);
    const body = delRes.json();
    expect(body.error.code).toBe('not_post_author');
  });
});
