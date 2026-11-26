import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient, closeRedis } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';
import * as r2Module from '../../src/lib/r2.js';
import { cleanupExpiredStories } from '../../src/jobs/story-cleanup.js';
import { env } from '../../src/config/env.js';

describe('Social - Stories Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();
  const userBlocked = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenBlocked: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_stories_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'alice_stories@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'bob_stories@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'carol_stories@nebron.io' });
    tokenBlocked = await createMockAccessToken({ sub: userBlocked, email: 'blocked_stories@nebron.io' });

    const profiles = db.collection('profiles');
    const now = new Date();
    await profiles.insertMany([
      {
        userId: userA,
        username: 'alice_st',
        name: 'Alice',
        language: 'en',
        theme: 'dark',
        avatarKey: null,
        bannerKey: null,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userB,
        username: 'bob_st',
        name: 'Bob',
        language: 'en',
        theme: 'light',
        avatarKey: null,
        bannerKey: null,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userC,
        username: 'carol_st',
        name: 'Carol',
        language: 'en',
        theme: 'system',
        avatarKey: null,
        bannerKey: null,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userBlocked,
        username: 'blocked_st',
        name: 'Blocked User',
        language: 'en',
        theme: 'light',
        avatarKey: null,
        bannerKey: null,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // User A follows User B, User C, and User Blocked
    await db.collection('follows').insertMany([
      { followerId: userA, followingId: userB, createdAt: now },
      { followerId: userA, followingId: userC, createdAt: now },
      { followerId: userA, followingId: userBlocked, createdAt: now },
      { followerId: userB, followingId: userA, createdAt: now },
    ]);

    // User A blocks userBlocked
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userBlocked,
      blocked: true,
      updatedAt: now,
    });

    app = await buildApp();
    await app.ready();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  async function findStoryEvent(type: string, storyId: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 50);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type && fieldMap.payload) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.storyId === storyId) {
          return payload;
        }
      }
    }
    return null;
  }

  it('1. Upload URL generates key with stories/{userId}/ prefix and enforces size limits', async () => {
    const resImg = await app.inject({
      method: 'POST',
      url: '/stories/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'image/jpeg',
        contentLength: 1024 * 500,
      },
    });
    expect(resImg.statusCode).toBe(200);
    const bodyImg = resImg.json();
    expect(bodyImg.objectKey).toMatch(new RegExp(`^stories/${userA}/[a-f0-9-]+\\.jpg$`));
    expect(bodyImg.uploadUrl).toBeDefined();
    expect(bodyImg.fields).toBeDefined();
    expect(bodyImg.maxBytes).toBe(10 * 1024 * 1024);

    const resVid = await app.inject({
      method: 'POST',
      url: '/stories/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'video/mp4',
        contentLength: 20 * 1024 * 1024,
      },
    });
    expect(resVid.statusCode).toBe(200);
    const bodyVid = resVid.json();
    expect(bodyVid.objectKey).toMatch(new RegExp(`^stories/${userA}/[a-f0-9-]+\\.mp4$`));
    expect(bodyVid.maxBytes).toBe(50 * 1024 * 1024);

    // Oversized image rejected
    const resOversizeImg = await app.inject({
      method: 'POST',
      url: '/stories/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'image/png',
        contentLength: 15 * 1024 * 1024,
      },
    });
    expect(resOversizeImg.statusCode).toBe(400);

    // Oversized video rejected
    const resOversizeVid = await app.inject({
      method: 'POST',
      url: '/stories/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'video/mp4',
        contentLength: 60 * 1024 * 1024,
      },
    });
    expect(resOversizeVid.statusCode).toBe(400);
  });

  let storyAId: string;
  let storyBId: string;
  let storyCId: string;

  it('2. Confirm creates story with 24h expiresAt and publishes core.story.created', async () => {
    const objectKeyA = `stories/${userA}/${crypto.randomUUID()}.jpg`;
    vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce({
      contentLength: 200000,
      contentType: 'image/jpeg',
    });

    const beforeMs = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/stories/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        objectKey: objectKeyA,
        mediaType: 'image',
        duration: 7,
        caption: 'Hello from stories!',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    storyAId = body.id;
    expect(body.authorId).toBe(userA);
    expect(body.mediaType).toBe('image');
    expect(body.duration).toBe(7);
    expect(body.caption).toBe('Hello from stories!');
    expect(body.mediaUrl).toContain(objectKeyA);

    const expiresMs = new Date(body.expiresAt).getTime();
    const expected24hMs = beforeMs + 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expected24hMs)).toBeLessThan(10000);

    const event = await findStoryEvent('core.story.created', storyAId);
    expect(event).toBeTruthy();
    expect(event?.authorId).toBe(userA);
    expect(event?.mediaType).toBe('image');
  });

  it('3. Confirm rejects foreign objectKey (403) and missing object (400)', async () => {
    const resForeign = await app.inject({
      method: 'POST',
      url: '/stories/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        objectKey: `stories/${userA}/stolen.jpg`,
        mediaType: 'image',
      },
    });
    expect(resForeign.statusCode).toBe(403);

    vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce(null);
    const resMissing = await app.inject({
      method: 'POST',
      url: '/stories/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        objectKey: `stories/${userB}/missing.mp4`,
        mediaType: 'video',
        duration: 10,
      },
    });
    expect(resMissing.statusCode).toBe(400);
  });

  it('4. GET /stories returns groups sorted (mine first, unviewed before viewed, most recent) and excludes blocked', async () => {
    const storiesCol = db.collection('stories');
    const now = Date.now();

    // Seed Bob (earlier), Carol (more recent), and Blocked user stories
    const resB = await storiesCol.insertOne({
      authorId: userB,
      mediaType: 'video',
      mediaKey: `stories/${userB}/b1.mp4`,
      mediaUrl: `http://localhost:9000/nebron-media/stories/${userB}/b1.mp4`,
      thumbnailKey: null,
      duration: 12,
      caption: 'Bob video story',
      viewers: [],
      viewerCount: 0,
      expiresAt: new Date(now + 20 * 60 * 60 * 1000),
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
    });
    storyBId = resB.insertedId.toString();

    const resC = await storiesCol.insertOne({
      authorId: userC,
      mediaType: 'image',
      mediaKey: `stories/${userC}/c1.jpg`,
      mediaUrl: `http://localhost:9000/nebron-media/stories/${userC}/c1.jpg`,
      thumbnailKey: null,
      duration: 5,
      caption: 'Carol story',
      viewers: [],
      viewerCount: 0,
      expiresAt: new Date(now + 23 * 60 * 60 * 1000),
      createdAt: new Date(now - 30 * 60 * 1000),
    });
    storyCId = resC.insertedId.toString();

    // Blocked user story (should NOT appear for userA even though userA follows userBlocked)
    await storiesCol.insertOne({
      authorId: userBlocked,
      mediaType: 'image',
      mediaKey: `stories/${userBlocked}/blk.jpg`,
      mediaUrl: `http://localhost:9000/nebron-media/stories/${userBlocked}/blk.jpg`,
      thumbnailKey: null,
      duration: 5,
      caption: 'Blocked story',
      viewers: [],
      viewerCount: 0,
      expiresAt: new Date(now + 23 * 60 * 60 * 1000),
      createdAt: new Date(now - 10 * 60 * 1000),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/stories',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const { groups } = res.json();

    // Blocked excluded
    expect(groups.some((g: any) => g.userId === userBlocked)).toBe(false);
    expect(groups).toHaveLength(3);

    // Order: mine (userA) -> Carol (most recent unviewed) -> Bob (older unviewed)
    expect(groups[0].userId).toBe(userA);
    expect(groups[0].isMine).toBe(true);
    expect(groups[1].userId).toBe(userC);
    expect(groups[1].hasUnviewed).toBe(true);
    expect(groups[2].userId).toBe(userB);
    expect(groups[2].hasUnviewed).toBe(true);
  });

  it('5. GET /stories/:userId returns 403 for blocked user and story group for unblocked user', async () => {
    const resBlocked = await app.inject({
      method: 'GET',
      url: `/stories/${userBlocked}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resBlocked.statusCode).toBe(403);

    const resAllowed = await app.inject({
      method: 'GET',
      url: `/stories/${userB}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resAllowed.statusCode).toBe(200);
    const group = resAllowed.json();
    expect(group.userId).toBe(userB);
    expect(group.stories).toHaveLength(1);
    expect(group.stories[0].viewedByMe).toBe(false);
  });

  it('6. POST /stories/:id/view is idempotent, updates viewerCount and viewedByMe', async () => {
    // User B views User A's story twice
    const res1 = await app.inject({
      method: 'POST',
      url: `/stories/${storyAId}/view`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res1.statusCode).toBe(204);

    const res2 = await app.inject({
      method: 'POST',
      url: `/stories/${storyAId}/view`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res2.statusCode).toBe(204);

    // User A views Carol's story so Carol becomes viewed while Bob remains unviewed
    const resViewCarol = await app.inject({
      method: 'POST',
      url: `/stories/${storyCId}/view`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resViewCarol.statusCode).toBe(204);

    // Now GET /stories for userA: mine (A), unviewed (Bob), viewed (Carol)
    const feedRes = await app.inject({
      method: 'GET',
      url: '/stories',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const { groups } = feedRes.json();
    expect(groups[0].userId).toBe(userA);
    expect(groups[1].userId).toBe(userB);
    expect(groups[1].hasUnviewed).toBe(true);
    expect(groups[2].userId).toBe(userC);
    expect(groups[2].hasUnviewed).toBe(false);
    expect(groups[2].stories[0].viewedByMe).toBe(true);

    // Feed for User B shows viewedByMe = true on User A's story
    const feedBRes = await app.inject({
      method: 'GET',
      url: '/stories',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const groupAInB = feedBRes.json().groups.find((g: any) => g.userId === userA);
    expect(groupAInB.hasUnviewed).toBe(false);
    expect(groupAInB.stories[0].viewedByMe).toBe(true);
  });

  it('7. GET /stories/:id/viewers is author-only and returns accurate viewerCount and user profiles', async () => {
    // Non-author gets 403
    const resForbidden = await app.inject({
      method: 'GET',
      url: `/stories/${storyAId}/viewers`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resForbidden.statusCode).toBe(403);

    // Author gets viewers list with Bob (count = 1 even though Bob viewed twice)
    const resAuthor = await app.inject({
      method: 'GET',
      url: `/stories/${storyAId}/viewers`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resAuthor.statusCode).toBe(200);
    const data = resAuthor.json();
    expect(data.viewerCount).toBe(1);
    expect(data.viewers).toHaveLength(1);
    expect(data.viewers[0].userId).toBe(userB);
    expect(data.viewers[0].username).toBe('bob_st');
    expect(data.viewers[0].viewedAt).toBeDefined();
  });

  it('8. DELETE /stories/:id allows author (deleting R2 + Mongo + publishing event) and blocks others (403)', async () => {
    const resForbidden = await app.inject({
      method: 'DELETE',
      url: `/stories/${storyAId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resForbidden.statusCode).toBe(403);

    const deleteSpy = vi.spyOn(r2Module, 'deleteObject').mockResolvedValue();

    const resOk = await app.inject({
      method: 'DELETE',
      url: `/stories/${storyAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resOk.statusCode).toBe(204);
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    const deletedDoc = await db.collection('stories').findOne({ _id: new ObjectId(storyAId) });
    expect(deletedDoc).toBeNull();

    const event = await findStoryEvent('core.story.deleted', storyAId);
    expect(event).toBeTruthy();
    expect(event?.authorId).toBe(userA);
  });

  it('9. Cleanup job deletes expired stories and R2 objects while leaving active stories intact', async () => {
    const storiesCol = db.collection('stories');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 10 * 60 * 60 * 1000);

    const expKey1 = `stories/${userB}/expired1.jpg`;
    const expKey2 = `stories/${userC}/expired2.mp4`;
    const activeKey = `stories/${userC}/active.jpg`;

    await storiesCol.insertMany([
      {
        authorId: userB,
        mediaType: 'image',
        mediaKey: expKey1,
        mediaUrl: `http://localhost:9000/nebron-media/${expKey1}`,
        thumbnailKey: null,
        duration: 5,
        caption: null,
        viewers: [],
        viewerCount: 0,
        expiresAt: past,
        createdAt: new Date(past.getTime() - 24 * 60 * 60 * 1000),
      },
      {
        authorId: userC,
        mediaType: 'video',
        mediaKey: expKey2,
        mediaUrl: `http://localhost:9000/nebron-media/${expKey2}`,
        thumbnailKey: null,
        duration: 10,
        caption: null,
        viewers: [],
        viewerCount: 0,
        expiresAt: past,
        createdAt: new Date(past.getTime() - 24 * 60 * 60 * 1000),
      },
      {
        authorId: userC,
        mediaType: 'image',
        mediaKey: activeKey,
        mediaUrl: `http://localhost:9000/nebron-media/${activeKey}`,
        thumbnailKey: null,
        duration: 5,
        caption: null,
        viewers: [],
        viewerCount: 0,
        expiresAt: future,
        createdAt: new Date(),
      },
    ]);

    const deleteSpy = vi.spyOn(r2Module, 'deleteObject').mockResolvedValue();
    const res = await cleanupExpiredStories(100, db);

    expect(res.deletedCount).toBe(2);
    expect(res.errors).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledWith(expKey1);
    expect(deleteSpy).toHaveBeenCalledWith(expKey2);

    const remainingExpired = await storiesCol.countDocuments({ expiresAt: { $lt: new Date() } });
    expect(remainingExpired).toBe(0);

    const activeDoc = await storiesCol.findOne({ mediaKey: activeKey });
    expect(activeDoc).toBeTruthy();

    // Also test internal endpoint /internal/cleanup-stories requires INTERNAL_TOKEN
    const unauthClean = await app.inject({
      method: 'POST',
      url: '/internal/cleanup-stories',
    });
    expect(unauthClean.statusCode).toBe(401);

    const authClean = await app.inject({
      method: 'POST',
      url: '/internal/cleanup-stories',
      headers: { 'x-internal-token': env.INTERNAL_TOKEN },
    });
    expect(authClean.statusCode).toBe(200);
  });

  it('10. Self-view sets viewedByMe without inflating viewerCount and blocked users cannot view story', async () => {
    const objectKey = `stories/${userA}/${crypto.randomUUID()}.jpg`;
    vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce({
      contentLength: 120000,
      contentType: 'image/jpeg',
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/stories/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        objectKey,
        mediaType: 'image',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdId = createRes.json().id;

    // Author views own story -> viewedByMe becomes true, viewerCount remains 0
    const selfViewRes = await app.inject({
      method: 'POST',
      url: `/stories/${createdId}/view`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(selfViewRes.statusCode).toBe(204);

    const ownGroupRes = await app.inject({
      method: 'GET',
      url: `/stories/${userA}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(ownGroupRes.statusCode).toBe(200);
    const ownStory = ownGroupRes.json().stories.find((s: any) => s.id === createdId);
    expect(ownStory.viewedByMe).toBe(true);
    expect(ownStory.viewerCount).toBe(0);

    // Blocked user cannot view story
    const blockedViewRes = await app.inject({
      method: 'POST',
      url: `/stories/${createdId}/view`,
      headers: { authorization: `Bearer ${tokenBlocked}` },
    });
    expect(blockedViewRes.statusCode).toBe(403);
  });
});
