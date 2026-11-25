import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Social - Feed Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const viewer = crypto.randomUUID();
  const user1 = crypto.randomUUID();
  const user2 = crypto.randomUUID();
  const user3 = crypto.randomUUID();

  let tokenViewer: string;
  let tokenUser1: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_feed_${crypto.randomUUID().replace(/-/g, '')}`;
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
        username: 'viewer_feed',
        name: 'Viewer',
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
        username: 'user1_feed',
        name: 'User One',
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
        username: 'user2_feed',
        name: 'User Two',
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
        userId: user3,
        username: 'user3_feed',
        name: 'User Three',
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

  it('1. Feed empty when no follows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/feed',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('2. Feed returns posts from followed users DESC', async () => {
    // Viewer follows user1 and user2
    await app.inject({
      method: 'POST',
      url: `/users/${user1}/follow`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });
    await app.inject({
      method: 'POST',
      url: `/users/${user2}/follow`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    // Insert posts with distinct timestamps
    const postsCol = db.collection('posts');
    const t1 = new Date(Date.now() - 30000);
    const t2 = new Date(Date.now() - 20000);
    const t3 = new Date(Date.now() - 10000);

    const post1 = {
      authorId: user1,
      body: 'Post 1 by user1',
      imageKey: null,
      imageUrl: null,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: t1,
      updatedAt: t1,
    };
    const post2 = {
      authorId: user2,
      body: 'Post 2 by user2',
      imageKey: null,
      imageUrl: null,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: t2,
      updatedAt: t2,
    };
    const post3 = {
      authorId: user1,
      body: 'Post 3 by user1',
      imageKey: null,
      imageUrl: null,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: t3,
      updatedAt: t3,
    };

    await postsCol.insertMany([post1, post2, post3]);

    const res = await app.inject({
      method: 'GET',
      url: '/feed',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(3);
    // DESC order: post3, post2, post1
    expect(body.data[0].body).toBe('Post 3 by user1');
    expect(body.data[1].body).toBe('Post 2 by user2');
    expect(body.data[2].body).toBe('Post 1 by user1');
    expect(body.hasMore).toBe(false);
  });

  it('3. Feed excludes posts from unfollowed users (post-still-exists case)', async () => {
    // user3 has a post, but viewer does not follow user3
    const postsCol = db.collection('posts');
    const tNow = new Date();
    await postsCol.insertOne({
      authorId: user3,
      body: 'Unfollowed post from user3',
      imageKey: null,
      imageUrl: null,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: tNow,
      updatedAt: tNow,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/feed',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const bodies = body.data.map((p: any) => p.body);
    expect(bodies).not.toContain('Unfollowed post from user3');

    // Now unfollow user2
    await app.inject({
      method: 'DELETE',
      url: `/users/${user2}/follow`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    const resAfterUnfollow = await app.inject({
      method: 'GET',
      url: '/feed',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    const bodiesAfter = resAfterUnfollow.json().data.map((p: any) => p.body);
    expect(bodiesAfter).not.toContain('Post 2 by user2');
    expect(bodiesAfter).toContain('Post 3 by user1');
    expect(bodiesAfter).toContain('Post 1 by user1');
  });

  it('4. Feed excludes posts from blocked users', async () => {
    // Re-follow user2
    await app.inject({
      method: 'POST',
      url: `/users/${user2}/follow`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    // Block user2 via relationships
    const relCol = db.collection('relationships');
    await relCol.insertOne({
      fromUserId: viewer,
      toUserId: user2,
      blocked: true,
      muted: { messages: false, calls: false, until: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Invalidate Redis block cache if any
    await redis.del(`rel:blocked:${viewer}`);

    const res = await app.inject({
      method: 'GET',
      url: '/feed',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const authors = body.data.map((p: any) => p.author.userId);
    expect(authors).not.toContain(user2);
    expect(authors).toContain(user1);
  });

  it('5. Feed pagination works correctly', async () => {
    // Create 5 posts for user1 with 1s gaps
    const postsCol = db.collection('posts');
    await postsCol.deleteMany({ authorId: user1 });

    const baseTime = Date.now();
    const docs = [];
    for (let i = 0; i < 5; i++) {
      const dt = new Date(baseTime + i * 1000);
      docs.push({
        authorId: user1,
        body: `Paged post ${i}`,
        imageKey: null,
        imageUrl: null,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: dt,
        updatedAt: dt,
      });
    }
    await postsCol.insertMany(docs);

    // Page 1: limit 2
    const res1 = await app.inject({
      method: 'GET',
      url: '/feed?limit=2',
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.data.length).toBe(2);
    expect(body1.hasMore).toBe(true);
    expect(body1.data[0].body).toBe('Paged post 4');
    expect(body1.data[1].body).toBe('Paged post 3');

    // Page 2: before = body1.data[1].createdAt, limit 2
    const beforeCursor = body1.data[1].createdAt;
    const res2 = await app.inject({
      method: 'GET',
      url: `/feed?limit=2&before=${encodeURIComponent(beforeCursor)}`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.data.length).toBe(2);
    expect(body2.hasMore).toBe(true);
    expect(body2.data[0].body).toBe('Paged post 2');
    expect(body2.data[1].body).toBe('Paged post 1');

    // Page 3: before = body2.data[1].createdAt, limit 2
    const beforeCursor2 = body2.data[1].createdAt;
    const res3 = await app.inject({
      method: 'GET',
      url: `/feed?limit=2&before=${encodeURIComponent(beforeCursor2)}`,
      headers: { authorization: `Bearer ${tokenViewer}` },
    });

    expect(res3.statusCode).toBe(200);
    const body3 = res3.json();
    expect(body3.data.length).toBe(1);
    expect(body3.hasMore).toBe(false);
    expect(body3.data[0].body).toBe('Paged post 0');
  });
});
