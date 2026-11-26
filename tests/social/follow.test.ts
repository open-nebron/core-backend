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

describe('Social - Follow Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();
  const userBlocked = crypto.randomUUID();

  let tokenUserA: string;
  let tokenUserB: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_follow_${crypto.randomUUID().replace(/-/g, '')}`;
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
        username: 'alice',
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
        username: 'bob',
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
      {
        userId: userC,
        username: 'charlie',
        name: 'Charlie',
        language: 'en',
        theme: 'system',
        avatarKey: null,
        bannerKey: null,
        followerCount: 0,
        followingCount: 0,
        postCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userBlocked,
        username: 'blocked_user',
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

    // Insert relationship: userA blocked userBlocked
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userBlocked,
      blocked: true,
      muteCalls: false,
      muteMessages: false,
      muteUntil: null,
      updatedAt: now,
    });

    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  async function findFollowEvent(type: string, followerId: string, followingId: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 50);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type && fieldMap.payload) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.followerId === followerId && payload.followingId === followingId) {
          return payload;
        }
      }
    }
    return null;
  }

  // 1. Follow user → relationship exists, counters updated both sides
  it('Follow user -> relationship exists, counters updated both sides', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/users/${userB}/follow`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    const followDoc = await db.collection('follows').findOne({
      followerId: userA,
      followingId: userB,
    });
    expect(followDoc).toBeDefined();
    expect(followDoc?.followerId).toBe(userA);
    expect(followDoc?.followingId).toBe(userB);

    const profA = await db.collection('profiles').findOne({ userId: userA });
    const profB = await db.collection('profiles').findOne({ userId: userB });

    expect(profA?.followingCount).toBe(1);
    expect(profB?.followerCount).toBe(1);

    const event = await findFollowEvent('core.user.followed', userA, userB);
    expect(event).toBeDefined();
  });

  // 2. Self-follow → 400
  it('Self-follow -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/users/${userA}/follow`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('self_follow_not_allowed');
  });

  // 3. Follow twice → idempotent
  it('Follow twice -> idempotent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/users/${userB}/follow`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    const profA = await db.collection('profiles').findOne({ userId: userA });
    const profB = await db.collection('profiles').findOne({ userId: userB });

    expect(profA?.followingCount).toBe(1);
    expect(profB?.followerCount).toBe(1);
  });

  // 4. Unfollow → relationship removed, counters decremented
  it('Unfollow -> relationship removed, counters decremented', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${userB}/follow`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);

    const followDoc = await db.collection('follows').findOne({
      followerId: userA,
      followingId: userB,
    });
    expect(followDoc).toBeNull();

    const profA = await db.collection('profiles').findOne({ userId: userA });
    const profB = await db.collection('profiles').findOne({ userId: userB });

    expect(profA?.followingCount).toBe(0);
    expect(profB?.followerCount).toBe(0);

    const event = await findFollowEvent('core.user.unfollowed', userA, userB);
    expect(event).toBeDefined();
  });

  // 5. Unfollow not-followed → 204 no-op
  it('Unfollow not-followed -> 204 no-op', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${userB}/follow`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(204);
  });

  // 6. Follow blocked user → 403
  it('Follow blocked user -> 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/users/${userBlocked}/follow`,
      headers: {
        authorization: `Bearer ${tokenUserA}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('blocked');
  });

  // 7. Followers list pagination
  it('Followers list pagination', async () => {
    // Both userA and userC follow userB
    await app.inject({
      method: 'POST',
      url: `/users/${userB}/follow`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    const tokenUserC = await createMockAccessToken({ sub: userC, email: 'userc@nebron.io' });
    await app.inject({
      method: 'POST',
      url: `/users/${userB}/follow`,
      headers: { authorization: `Bearer ${tokenUserC}` },
    });

    const resPage1 = await app.inject({
      method: 'GET',
      url: `/users/${userB}/followers?limit=1`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(resPage1.statusCode).toBe(200);
    const page1 = resPage1.json();
    expect(page1.length).toBe(1);

    const resAll = await app.inject({
      method: 'GET',
      url: `/users/${userB}/followers?limit=10`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(resAll.statusCode).toBe(200);
    const all = resAll.json();
    expect(all.length).toBe(2);
    expect(all.map((u: any) => u.userId)).toContain(userA);
    expect(all.map((u: any) => u.userId)).toContain(userC);
  });

  // 8. Following list pagination
  it('Following list pagination', async () => {
    // userA follows userB and userC
    await app.inject({
      method: 'POST',
      url: `/users/${userC}/follow`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    const resPage1 = await app.inject({
      method: 'GET',
      url: `/users/${userA}/following?limit=1`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(resPage1.statusCode).toBe(200);
    const page1 = resPage1.json();
    expect(page1.length).toBe(1);

    const resAll = await app.inject({
      method: 'GET',
      url: `/users/${userA}/following?limit=10`,
      headers: { authorization: `Bearer ${tokenUserA}` },
    });

    expect(resAll.statusCode).toBe(200);
    const all = resAll.json();
    expect(all.length).toBe(2);
    expect(all.map((u: any) => u.userId)).toContain(userB);
    expect(all.map((u: any) => u.userId)).toContain(userC);
  });

  // 9. ObjectId (24-hex) userId support (auth-service format)
  it('Supports 24-hex ObjectId userId format from auth-service', async () => {
    const objIdA = '6b07c672dba0bcd5dac8e881';
    const objIdB = '6b07c672dba0bcd5dac8e882';
    const tokenObjA = await createMockAccessToken({ sub: objIdA, email: 'obja@nebron.io' });
    const now = new Date();

    await db.collection('profiles').insertMany([
      {
        userId: objIdA,
        username: 'obj_alice',
        name: 'Obj Alice',
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
        userId: objIdB,
        username: 'obj_bob',
        name: 'Obj Bob',
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

    const resFollow = await app.inject({
      method: 'POST',
      url: `/users/${objIdB}/follow`,
      headers: { authorization: `Bearer ${tokenObjA}` },
    });
    expect(resFollow.statusCode).toBe(204);

    const resPosts = await app.inject({
      method: 'GET',
      url: `/users/${objIdB}/posts`,
      headers: { authorization: `Bearer ${tokenObjA}` },
    });
    expect(resPosts.statusCode).toBe(200);
  });
});
