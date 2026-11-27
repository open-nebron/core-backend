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
import {
  REEL_VIEWS_BUFFER_KEY,
  cleanupDeletedReels,
  flushBufferedReelViews,
} from '../../src/jobs/reel-jobs.js';
import { env } from '../../src/config/env.js';

describe('Social - Reels Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  // Mix 24-hex ObjectId userIds (real auth-service format) and UUIDs
  const userA = new ObjectId().toHexString();
  const userB = crypto.randomUUID();
  const userC = new ObjectId().toHexString();
  const userBlocked = new ObjectId().toHexString();
  const userBanned = new ObjectId().toHexString();

  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenBlocked: string;
  let tokenBanned: string;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_social_reels_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: userA, email: 'alice_reels@nebron.io' });
    tokenB = await createMockAccessToken({ sub: userB, email: 'bob_reels@nebron.io' });
    tokenC = await createMockAccessToken({ sub: userC, email: 'carol_reels@nebron.io' });
    tokenBlocked = await createMockAccessToken({ sub: userBlocked, email: 'blocked_reels@nebron.io' });
    tokenBanned = await createMockAccessToken({ sub: userBanned, email: 'banned_reels@nebron.io' });

    const profiles = db.collection('profiles');
    const now = new Date();
    await profiles.insertMany([
      {
        userId: userA,
        username: 'alice_reels',
        name: 'Alice Reels',
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
        username: 'bob_reels',
        name: 'Bob Reels',
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
        username: 'carol_reels',
        name: 'Carol Reels',
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
        username: 'blocked_reels',
        name: 'Blocked User',
        language: 'en',
        theme: 'light',
        avatarKey: null,
        bannerKey: null,
        isBanned: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: userBanned,
        username: 'banned_reels',
        name: 'Banned User',
        language: 'en',
        theme: 'light',
        avatarKey: null,
        bannerKey: null,
        isBanned: true,
        bannedAt: now,
        bannedReason: 'Policy violation',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // User A follows User B, User Blocked, and User Banned (does NOT follow User C)
    await db.collection('follows').insertMany([
      { followerId: userA, followingId: userB, createdAt: now },
      { followerId: userA, followingId: userBlocked, createdAt: now },
      { followerId: userA, followingId: userBanned, createdAt: now },
      { followerId: userB, followingId: userA, createdAt: now },
    ]);

    // User A blocks userBlocked
    await db.collection('relationships').insertOne({
      fromUserId: userA,
      toUserId: userBlocked,
      blocked: true,
      updatedAt: now,
    });

    await redis.del(REEL_VIEWS_BUFFER_KEY);

    app = await buildApp();
    await app.ready();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const uid of [userA, userB, userC, userBlocked, userBanned]) {
      await redis.del(
        `ratelimit:reels_create:${uid}`,
        `ratelimit:reel_upload_url:${uid}`,
        `ratelimit:confirm_upload:${uid}`,
        `ban_cache:${uid}`
      );
    }
    await redis.del(REEL_VIEWS_BUFFER_KEY);
    if (app) await app.close();
    if (db) await db.dropDatabase();
    await mongoDb.closeMongo();
    await closeRedis();
  });

  async function findReelEvent(type: string, reelId: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 60);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type && fieldMap.payload) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.reelId === reelId) {
          return payload;
        }
      }
    }
    return null;
  }

  async function findCommentEvent(type: string, commentId: string) {
    const events = await redis.xrevrange('nebron.events', '+', '-', 'COUNT', 60);
    for (const [, fields] of events) {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      if (fieldMap.type === type && fieldMap.payload) {
        const payload = JSON.parse(fieldMap.payload);
        if (payload.commentId === commentId) {
          return payload;
        }
      }
    }
    return null;
  }

  it('1. Upload URL generates key with reels/{userId}/ prefix and enforces 50MB limit', async () => {
    const resVid = await app.inject({
      method: 'POST',
      url: '/reels/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'video/mp4',
        contentLength: 25 * 1024 * 1024,
      },
    });
    expect(resVid.statusCode).toBe(200);
    const bodyVid = resVid.json();
    expect(bodyVid.objectKey).toMatch(new RegExp(`^reels/${userA}/[a-f0-9-]+\\.mp4$`));
    expect(bodyVid.uploadUrl).toBeDefined();
    expect(bodyVid.fields).toBeDefined();
    expect(bodyVid.maxBytes).toBe(50 * 1024 * 1024);

    // Oversized > 50MB rejected
    const resOver = await app.inject({
      method: 'POST',
      url: '/reels/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'video/mp4',
        contentLength: 55 * 1024 * 1024,
      },
    });
    expect(resOver.statusCode).toBe(400);

    // Non-mp4 rejected on video upload-url
    const resBadMime = await app.inject({
      method: 'POST',
      url: '/reels/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'image/jpeg',
        contentLength: 1024,
      },
    });
    expect(resBadMime.statusCode).toBe(400);

    // Thumbnail upload URL works cleanly for jpeg/png/webp
    const resThumb = await app.inject({
      method: 'POST',
      url: '/reels/thumbnail/upload-url',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        contentType: 'image/png',
        contentLength: 250 * 1024,
      },
    });
    expect(resThumb.statusCode).toBe(200);
    expect(resThumb.json().objectKey).toMatch(new RegExp(`^reels/${userA}/[a-f0-9-]+\\.png$`));
  });

  it('2. Confirm reel creates document, computes URLs, and emits core.reel.created event', async () => {
    const videoKey = `reels/${userA}/${crypto.randomUUID()}.mp4`;
    vi.spyOn(r2Module, 'headObject').mockResolvedValue({
      contentLength: 4 * 1024 * 1024,
      contentType: 'video/mp4',
      lastModified: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        videoKey,
        caption: 'First sunset reel',
        duration: 18.5,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.authorId).toBe(userA);
    expect(body.caption).toBe('First sunset reel');
    expect(body.videoUrl).toBe(`${env.R2_PUBLIC_BASE_URL}/${videoKey}`);
    expect(body.thumbnailUrl).toBeNull();
    expect(body.duration).toBe(18.5);
    expect(body.viewCount).toBe(0);
    expect(body.likeCount).toBe(0);
    expect(body.commentCount).toBe(0);
    expect(body.likedByMe).toBe(false);
    expect(body.author.username).toBe('alice_reels');

    const evt = await findReelEvent('core.reel.created', body.id);
    expect(evt).toBeTruthy();
    expect(evt.authorId).toBe(userA);
    expect(evt.duration).toBe(18.5);
  });

  it('3. Confirm reel supports optional thumbnailKey and validates R2 object presence and mime type', async () => {
    const videoKey = `reels/${userB}/${crypto.randomUUID()}.mp4`;
    const thumbnailKey = `reels/${userB}/${crypto.randomUUID()}.jpg`;

    vi.spyOn(r2Module, 'headObject').mockImplementation(async (key: string) => {
      if (key === videoKey) {
        return { contentLength: 2 * 1024 * 1024, contentType: 'video/mp4', lastModified: new Date() };
      }
      if (key === thumbnailKey) {
        return { contentLength: 120 * 1024, contentType: 'image/jpeg', lastModified: new Date() };
      }
      return null;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        videoKey,
        thumbnailKey,
        caption: 'Bob reel with thumb',
        duration: 12,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().thumbnailUrl).toBe(`${env.R2_PUBLIC_BASE_URL}/${thumbnailKey}`);

    // Missing R2 object rejected
    const missingRes = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        videoKey: `reels/${userB}/missing.mp4`,
        duration: 10,
      },
    });
    expect(missingRes.statusCode).toBe(400);
    expect(missingRes.json().error.code).toBe('media_not_found');

    // Non-mp4 object in R2 rejected
    vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce({
      contentLength: 1024,
      contentType: 'image/png',
      lastModified: new Date(),
    });
    const badMimeRes = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        videoKey: `reels/${userB}/wrongtype.mp4`,
        duration: 10,
      },
    });
    expect(badMimeRes.statusCode).toBe(400);
    expect(badMimeRes.json().error.code).toBe('invalid_media_type');
  });

  it('4. Confirm reel rejects duration < 5s or > 60s, caption > 300 chars, or mismatched user prefix', async () => {
    const validKey = `reels/${userA}/${crypto.randomUUID()}.mp4`;

    const tooShort = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { videoKey: validKey, duration: 4 },
    });
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { videoKey: validKey, duration: 61 },
    });
    expect(tooLong.statusCode).toBe(400);

    const longCaption = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { videoKey: validKey, duration: 10, caption: 'x'.repeat(301) },
    });
    expect(longCaption.statusCode).toBe(400);

    const wrongPrefix = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { videoKey: `reels/${userB}/stolen.mp4`, duration: 10 },
    });
    expect(wrongPrefix.statusCode).toBe(400);
    expect(wrongPrefix.json().error.code).toBe('invalid_object_key');
  });

  it('5. GET /reels returns followed users + own reels sorted DESC, excludes blocked and banned users', async () => {
    // Seed reels for userC (not followed), userBlocked (blocked), userBanned (banned)
    const now = new Date();
    const reelsCol = db.collection('reels');
    const cId = new ObjectId();
    const blkId = new ObjectId();
    const banId = new ObjectId();

    await reelsCol.insertMany([
      {
        _id: cId,
        authorId: userC,
        caption: 'Unfollowed Carol reel',
        videoKey: `reels/${userC}/c1.mp4`,
        videoUrl: `${env.R2_PUBLIC_BASE_URL}/reels/${userC}/c1.mp4`,
        thumbnailKey: null,
        thumbnailUrl: null,
        duration: 15,
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(now.getTime() + 1000),
        updatedAt: now,
      },
      {
        _id: blkId,
        authorId: userBlocked,
        caption: 'Blocked user reel',
        videoKey: `reels/${userBlocked}/blk.mp4`,
        videoUrl: `${env.R2_PUBLIC_BASE_URL}/reels/${userBlocked}/blk.mp4`,
        thumbnailKey: null,
        thumbnailUrl: null,
        duration: 15,
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(now.getTime() + 2000),
        updatedAt: now,
      },
      {
        _id: banId,
        authorId: userBanned,
        caption: 'Banned user reel',
        videoKey: `reels/${userBanned}/ban.mp4`,
        videoUrl: `${env.R2_PUBLIC_BASE_URL}/reels/${userBanned}/ban.mp4`,
        thumbnailKey: null,
        thumbnailUrl: null,
        duration: 15,
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(now.getTime() + 3000),
        updatedAt: now,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/reels?limit=20',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    const authors = items.map((r: any) => r.authorId);

    // Should contain userA (own) and userB (followed)
    expect(authors).toContain(userA);
    expect(authors).toContain(userB);
    // Must exclude unfollowed C, blocked, banned
    expect(authors).not.toContain(userC);
    expect(authors).not.toContain(userBlocked);
    expect(authors).not.toContain(userBanned);

    // Sorted DESC by createdAt
    for (let i = 1; i < items.length; i++) {
      expect(new Date(items[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(items[i].createdAt).getTime()
      );
    }

    // Bob's item in Alice's feed should report isFollowing=true
    const bobReel = items.find((r: any) => r.authorId === userB);
    expect(bobReel.author.isFollowing).toBe(true);
  });

  it('6. GET /reels cursor pagination returns disjoint pages cleanly without duplicates or skips', async () => {
    const baseTime = Date.now() - 100000;
    const insertedIds: string[] = [];
    const reelsCol = db.collection('reels');

    // Insert 4 reels for userC to paginate cleanly on C's feed
    for (let i = 0; i < 4; i++) {
      const id = new ObjectId();
      insertedIds.push(id.toString());
      await reelsCol.insertOne({
        _id: id,
        authorId: userC,
        caption: `Page item ${i}`,
        videoKey: `reels/${userC}/p${i}.mp4`,
        videoUrl: `${env.R2_PUBLIC_BASE_URL}/reels/${userC}/p${i}.mp4`,
        thumbnailKey: null,
        thumbnailUrl: null,
        duration: 10,
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(baseTime + i * 1000),
        updatedAt: new Date(baseTime + i * 1000),
      });
    }

    const page1Res = await app.inject({
      method: 'GET',
      url: '/reels?limit=2',
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json();
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await app.inject({
      method: 'GET',
      url: `/reels?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json();
    expect(page2.items.length).toBe(2);

    const p1Ids = page1.items.map((r: any) => r.id);
    const p2Ids = page2.items.map((r: any) => r.id);
    expect(new Set([...p1Ids, ...p2Ids]).size).toBe(4);
  });

  it('7. GET /reels/:id returns single reel and enforces block and not-found checks', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const reelId = feedRes.json().items.find((r: any) => r.authorId === userA).id;

    const singleRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(singleRes.statusCode).toBe(200);
    expect(singleRes.json().id).toBe(reelId);

    // Blocked user cannot view Alice's reel -> 403
    const blockedRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenBlocked}` },
    });
    expect(blockedRes.statusCode).toBe(403);

    // Invalid ID -> 404
    const notFound = await app.inject({
      method: 'GET',
      url: `/reels/${new ObjectId().toHexString()}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('8. POST /reels/:id/view buffers counts in Redis hash and includes them in reel viewCount', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const reelId = feedRes.json().items.find((r: any) => r.authorId === userA).id;

    await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/view`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/view`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const buffered = await redis.hget(REEL_VIEWS_BUFFER_KEY, reelId);
    expect(buffered).toBe('2');

    const getRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(getRes.json().viewCount).toBeGreaterThanOrEqual(2);
  });

  it('9. Flush buffered reel views job drains Redis hash, persists viewCount, and emits core.reel.viewed', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const reelId = feedRes.json().items.find((r: any) => r.authorId === userA).id;

    await redis.hincrby(REEL_VIEWS_BUFFER_KEY, reelId, 3);
    const flushRes = await flushBufferedReelViews(db, redis);

    expect(flushRes.errors).toEqual([]);
    expect(flushRes.flushedReels).toBeGreaterThanOrEqual(1);
    expect(flushRes.totalViewsFlushed).toBeGreaterThanOrEqual(3);

    const afterBuffer = await redis.hget(REEL_VIEWS_BUFFER_KEY, reelId);
    expect(afterBuffer).toBeNull();

    const doc = await db.collection('reels').findOne({ _id: new ObjectId(reelId) });
    expect(doc?.viewCount).toBeGreaterThanOrEqual(5);

    const evt = await findReelEvent('core.reel.viewed', reelId);
    expect(evt).toBeTruthy();
    expect(evt.totalViews).toBe(doc?.viewCount);
  });

  it('10. POST/DELETE /reels/:id/like is idempotent, updates likeCount, emits events, and lists likers', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const reelId = feedRes.json().items.find((r: any) => r.authorId === userA).id;

    // Like twice (idempotent)
    const l1 = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(l1.statusCode).toBe(200);
    expect(l1.json()).toEqual({ liked: true, likeCount: 1 });

    const l2 = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(l2.statusCode).toBe(200);
    expect(l2.json()).toEqual({ liked: true, likeCount: 1 });

    const evtLiked = await findReelEvent('core.reel.liked', reelId);
    expect(evtLiked).toBeTruthy();
    expect(evtLiked.userId).toBe(userB);

    // Likers list
    const likersRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}/likes`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(likersRes.statusCode).toBe(200);
    expect(likersRes.json()).toHaveLength(1);
    expect(likersRes.json()[0].userId).toBe(userB);

    // Unlike twice (idempotent)
    const u1 = await app.inject({
      method: 'DELETE',
      url: `/reels/${reelId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(u1.statusCode).toBe(200);
    expect(u1.json()).toEqual({ liked: false, likeCount: 0 });

    const u2 = await app.inject({
      method: 'DELETE',
      url: `/reels/${reelId}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(u2.statusCode).toBe(200);
    expect(u2.json()).toEqual({ liked: false, likeCount: 0 });

    const evtUnliked = await findReelEvent('core.reel.unliked', reelId);
    expect(evtUnliked).toBeTruthy();
    expect(evtUnliked.userId).toBe(userB);
  });

  it('11. POST/GET /reels/:id/comments creates reel comment, updates commentCount, and filters blocked commenters', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const bobReel = feedRes.json().items.find((r: any) => r.authorId === userB);
    const reelId = bobReel.id;

    const cRes = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Awesome reel!' },
    });
    expect(cRes.statusCode).toBe(201);
    const created = cRes.json();
    expect(created.targetType).toBe('reel');
    expect(created.reelId).toBe(reelId);
    expect(created.body).toBe('Awesome reel!');

    // Blocked user also comments on Bob's reel (Bob hasn't blocked userBlocked)
    const cBlkRes = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenBlocked}` },
      payload: { body: 'Comment from blocked user' },
    });
    expect(cBlkRes.statusCode).toBe(201);

    const evt = await findCommentEvent('core.comment.created', created.id);
    expect(evt).toBeTruthy();
    expect(evt.postId).toBe(reelId);

    // Alice views comments -> blocked commenter excluded
    const listRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.some((c: any) => c.id === created.id)).toBe(true);
    expect(list.some((c: any) => c.author.userId === userBlocked)).toBe(false);

    const updatedReel = await db.collection('reels').findOne({ _id: new ObjectId(reelId) });
    expect(updatedReel?.commentCount).toBe(2);
  });

  it('12. DELETE /comments/:id handles polymorphic reel comments with permission checks', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const bobReel = feedRes.json().items.find((r: any) => r.authorId === userB);
    const reelId = bobReel.id;

    const cRes = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Temp reel comment' },
    });
    const commentId = cRes.json().id;

    // Non-author (Carol) cannot delete Alice's comment on Bob's reel -> 403
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(forbidden.statusCode).toBe(403);

    // Reel owner (Bob) CAN delete Alice's comment -> 204
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/comments/${commentId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(delRes.statusCode).toBe(204);

    const evt = await findCommentEvent('core.comment.deleted', commentId);
    expect(evt).toBeTruthy();
  });

  it('13. DELETE /reels/:id soft deletes reel (owner only) and hides it from feeds and single GET', async () => {
    const videoKey = `reels/${userA}/${crypto.randomUUID()}.mp4`;
    const thumbnailKey = `reels/${userA}/${crypto.randomUUID()}.jpg`;
    vi.spyOn(r2Module, 'headObject').mockImplementation(async (key: string) => ({
      contentLength: 1024 * 1024,
      contentType: key.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4',
      lastModified: new Date(),
    }));

    const createdRes = await app.inject({
      method: 'POST',
      url: '/reels/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { videoKey, thumbnailKey, duration: 15, caption: 'To delete' },
    });
    const reelId = createdRes.json().id;

    // Bob cannot delete Alice's reel
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(forbidden.statusCode).toBe(403);

    // Owner soft deletes
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(delRes.statusCode).toBe(204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it('14. R2 cleanup job deletes videoKey and thumbnailKey from R2 and marks r2DeletedAt', async () => {
    const deleteSpy = vi.spyOn(r2Module, 'deleteObject').mockResolvedValue();

    const result = await cleanupDeletedReels(100, db);
    expect(result.errors).toEqual([]);
    expect(result.cleanedCount).toBeGreaterThanOrEqual(1);
    expect(deleteSpy).toHaveBeenCalledTimes(2);

    const uncleanedRemaining = await db
      .collection('reels')
      .countDocuments({ deleted: true, r2DeletedAt: null });
    expect(uncleanedRemaining).toBe(0);
  });

  it('15. GET /users/:userId/reels and /users/me/reels support 24-hex & UUID IDs and enforce blocks', async () => {
    const meRes = await app.inject({
      method: 'GET',
      url: '/users/me/reels',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().items.length).toBeGreaterThanOrEqual(1);

    const profileRes = await app.inject({
      method: 'GET',
      url: `/users/${userA}/reels`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(profileRes.statusCode).toBe(200);
    expect(profileRes.json().items.every((r: any) => r.authorId === userA)).toBe(true);

    // Blocked user rejected 403
    const blkProfileRes = await app.inject({
      method: 'GET',
      url: `/users/${userA}/reels`,
      headers: { authorization: `Bearer ${tokenBlocked}` },
    });
    expect(blkProfileRes.statusCode).toBe(403);
  });

  it('16. Banned user receives 403 account_banned on reels endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenBanned}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_banned');
  });

  it('17. Threaded reel comments support replies, flattening, likes, and sort=top|new', async () => {
    const feedRes = await app.inject({
      method: 'GET',
      url: '/reels',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const bobReel = feedRes.json().items.find((r: any) => r.authorId === userB);
    const reelId = bobReel.id;

    const rootRes = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Reel root comment' },
    });
    expect(rootRes.statusCode).toBe(201);
    const rootId = rootRes.json().id;

    const reply1Res = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { body: 'Reply on reel root', parentCommentId: rootId },
    });
    expect(reply1Res.statusCode).toBe(201);
    expect(reply1Res.json().parentCommentId).toBe(rootId);

    const reply2Res = await app.inject({
      method: 'POST',
      url: `/reels/${reelId}/comments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { body: 'Reply to Carol on reel', parentCommentId: reply1Res.json().id },
    });
    expect(reply2Res.statusCode).toBe(201);
    expect(reply2Res.json().parentCommentId).toBe(rootId);
    expect(reply2Res.json().replyToUser).toEqual({ userId: userC, username: 'carol_reels' });

    // Like root comment
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/comments/${rootId}/like`,
          headers: { authorization: `Bearer ${tokenB}` },
        })
      ).statusCode
    ).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: `/reels/${reelId}/comments?sort=top`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listRes.statusCode).toBe(200);
    const rootItem = listRes.json().find((c: any) => c.id === rootId);
    expect(rootItem.likeCount).toBe(1);
    expect(rootItem.likedByViewer).toBe(true);
    expect(rootItem.replyCount).toBe(2);
    expect(rootItem.topReplies.length).toBe(2);
  });
});
