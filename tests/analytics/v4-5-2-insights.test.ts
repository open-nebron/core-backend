import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Enhanced Creator Analytics Insights (Stage V4.5-2)', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const creatorA = crypto.randomUUID();
  const viewerB = crypto.randomUUID();
  const viewerC = crypto.randomUUID();
  const viewerD = crypto.randomUUID();

  let tokenA: string;
  let tokenB: string;

  async function clearRedis() {
    if (!redis) return;
    for (const uid of [creatorA, viewerB, viewerC, viewerD]) {
      const rateKeys = await redis.keys(`ratelimit:*:${uid}:*`);
      const impKeys = await redis.keys(`impression:*:${uid}`);
      const all = [...rateKeys, ...impKeys, `rel:blocked:${uid}`];
      if (all.length > 0) await redis.del(...all);
    }
  }

  async function insertPost(
    authorId: string,
    body: string,
    opts: {
      createdAt?: Date;
      hashtags?: string[];
      likeCount?: number;
      commentCount?: number;
      shareCount?: number;
      saveCount?: number;
    } = {}
  ): Promise<string> {
    const now = opts.createdAt ?? new Date();
    const res = await db.collection('posts').insertOne({
      authorId,
      body,
      hashtags: opts.hashtags ?? [],
      mentions: [],
      likeCount: opts.likeCount ?? 0,
      commentCount: opts.commentCount ?? 0,
      shareCount: opts.shareCount ?? 0,
      saveCount: opts.saveCount ?? 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    return res.insertedId.toString();
  }

  async function insertReel(
    authorId: string,
    caption: string,
    createdAt: Date = new Date(),
    duration: number = 20
  ): Promise<string> {
    const res = await db.collection('reels').insertOne({
      authorId,
      caption,
      videoKey: `users/${authorId}/reels/${Date.now()}-${Math.random()}.mp4`,
      videoUrl: 'https://cdn.example.com/reel.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      deleted: false,
      createdAt,
      updatedAt: createdAt,
    });
    return res.insertedId.toString();
  }

  async function insertStory(authorId: string, caption: string, createdAt: Date = new Date()): Promise<string> {
    const res = await db.collection('stories').insertOne({
      authorId,
      mediaType: 'video',
      mediaKey: `users/${authorId}/stories/${Date.now()}.mp4`,
      mediaUrl: 'https://cdn.example.com/story.mp4',
      thumbnailKey: null,
      duration: 10,
      caption,
      viewers: [],
      viewerCount: 0,
      expiresAt: new Date(createdAt.getTime() + 86_400_000),
      createdAt,
    });
    return res.insertedId.toString();
  }

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_analytics_v4_5_2_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: creatorA, email: 'v452a@nebron.io' });
    tokenB = await createMockAccessToken({ sub: viewerB, email: 'v452b@nebron.io' });

    const now = new Date();
    await db.collection('profiles').insertMany([
      {
        userId: creatorA,
        username: 'creator_v452',
        name: 'Creator A',
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
        userId: viewerB,
        username: 'viewer_b_v452',
        name: 'Viewer B',
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

    app = await buildApp();
  });

  afterAll(async () => {
    await clearRedis();
    await app?.close();
    await db?.dropDatabase();
    await mongoDb.closeMongo();
    await client?.close();
  });

  beforeEach(async () => {
    await clearRedis();
    for (const colName of [
      'posts',
      'reels',
      'stories',
      'impressions',
      'content_views',
      'engagement_events',
      'analytics_daily',
      'creator_daily_stats',
      'follows',
      'follow_sources',
      'unfollow_events',
    ]) {
      await db.collection(colName).deleteMany({});
    }
    await db.collection('profiles').updateOne({ userId: creatorA }, { $set: { followerCount: 0 } });
  });

  // === Retention / Curves (3) ===

  it('1. Reel curve returns 10% decile buckets with monotonically decreasing viewers', async () => {
    const reelId = await insertReel(creatorA, 'Retention reel');
    const now = new Date();
    await db.collection('content_views').insertMany([
      { userId: viewerB, contentType: 'reel', contentId: reelId, sessionId: 's1', startedAt: now, endedAt: now, watchedSeconds: 2, totalSeconds: 20, completed: false, source: 'feed' },
      { userId: viewerC, contentType: 'reel', contentId: reelId, sessionId: 's2', startedAt: now, endedAt: now, watchedSeconds: 10, totalSeconds: 20, completed: false, source: 'feed' },
      { userId: viewerD, contentType: 'reel', contentId: reelId, sessionId: 's3', startedAt: now, endedAt: now, watchedSeconds: 20, totalSeconds: 20, completed: true, source: 'feed' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/reel/${reelId}/curve`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalViews).toBe(3);
    expect(body.curve).toHaveLength(11);
    expect(body.curve[0]).toEqual({ percent: 0, viewers: 3 });
    expect(body.curve[1]).toEqual({ percent: 10, viewers: 3 }); // 2/20 = 10%
    expect(body.curve[5]).toEqual({ percent: 50, viewers: 2 }); // 10/20 = 50%, 20/20 = 100%
    expect(body.curve[10]).toEqual({ percent: 100, viewers: 1 });
    for (let i = 0; i < body.curve.length - 1; i++) {
      expect(body.curve[i].viewers).toBeGreaterThanOrEqual(body.curve[i + 1].viewers);
    }
  });

  it('2. Post curve returns hourly buckets from 0..168 based on engagement_events', async () => {
    const postedAt = new Date(Date.now() - 48 * 3_600_000);
    const postId = await insertPost(creatorA, 'Hourly curve post', { createdAt: postedAt });

    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'like', at: new Date(postedAt.getTime() + 10 * 60_000) },
      { contentType: 'post', contentId: postId, userId: viewerC, event: 'comment', at: new Date(postedAt.getTime() + 20 * 60_000) },
      { contentType: 'post', contentId: postId, userId: viewerD, event: 'save', at: new Date(postedAt.getTime() + 5 * 3_600_000) },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/curve`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.timeline).toHaveLength(169);
    expect(body.timeline[0]).toEqual({ hoursAfter: 0, engagements: 2 });
    expect(body.timeline[5]).toEqual({ hoursAfter: 5, engagements: 1 });
    expect(body.timeline[168]).toEqual({ hoursAfter: 168, engagements: 0 });
  });

  it('3. Story curve computes completionRate, avgWatchedPercent, and avgWatchSeconds accurately', async () => {
    const storyId = await insertStory(creatorA, 'Completion story');
    const now = new Date();
    await db.collection('content_views').insertMany([
      { userId: viewerB, contentType: 'story', contentId: storyId, sessionId: 'ss1', startedAt: now, endedAt: now, watchedSeconds: 10, totalSeconds: 10, completed: true, tapsForward: 1, tapsBack: 0, exited: false, source: 'feed' },
      { userId: viewerC, contentType: 'story', contentId: storyId, sessionId: 'ss2', startedAt: now, endedAt: now, watchedSeconds: 5, totalSeconds: 10, completed: false, tapsForward: 0, tapsBack: 1, exited: true, source: 'feed' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/story/${storyId}/curve`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.completions).toBe(1);
    expect(body.completionRate).toBe(0.5);
    expect(body.avgWatchedPercent).toBe(75);
    expect(body.avgWatchSeconds).toBe(7.5);
    expect(body.tapsForward).toBe(1);
    expect(body.tapsBack).toBe(1);
    expect(body.exits).toBe(1);
  });

  // === Traffic Attribution (2) ===

  it('4. Traffic attribution aggregates impressions and engagements per source including recommendations', async () => {
    const postId = await insertPost(creatorA, 'Traffic post');
    const now = new Date();
    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: postId, source: 'explore', seenAt: now },
      { userId: viewerC, contentType: 'post', contentId: postId, source: 'explore', seenAt: now },
      { userId: viewerD, contentType: 'post', contentId: postId, source: 'recommendations', seenAt: now },
    ]);
    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'like', at: now },
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'save', at: now },
      { contentType: 'post', contentId: postId, userId: viewerD, event: 'like', at: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/traffic`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalImpressions).toBe(3);
    const exploreRow = body.sources.find((s: any) => s.source === 'explore');
    const recRow = body.sources.find((s: any) => s.source === 'recommendations');
    expect(exploreRow).toEqual({
      source: 'explore',
      impressions: 2,
      engagements: 2,
      engagementRate: 1,
    });
    expect(recRow).toEqual({
      source: 'recommendations',
      impressions: 1,
      engagements: 1,
      engagementRate: 1,
    });

    // POST /analytics/impression accepts 'recommendations' source
    const impRes = await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: postId, source: 'recommendations' },
    });
    expect(impRes.statusCode).toBe(204);
  });

  it('5. Traffic attribution selects topSource accurately and enforces ownership', async () => {
    const postId = await insertPost(creatorA, 'Top source post');
    const now = new Date();
    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: postId, source: 'hashtag', seenAt: now },
      { userId: viewerC, contentType: 'post', contentId: postId, source: 'hashtag', seenAt: now },
      { userId: viewerD, contentType: 'post', contentId: postId, source: 'feed', seenAt: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/traffic`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().topSource).toBe('hashtag');

    const forbidden = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/traffic`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  // === Cohort Comparison (2) ===

  it('6. Cohort comparison supports previous_post and 7d_ago windows', async () => {
    const now = Date.now();
    const post8dAgo = await insertPost(creatorA, 'Old 8d', {
      createdAt: new Date(now - 8 * 86_400_000),
      likeCount: 4,
    });
    const prevPost = await insertPost(creatorA, 'Yesterday post', {
      createdAt: new Date(now - 86_400_000),
      likeCount: 10,
    });
    const currentPost = await insertPost(creatorA, 'Today post', {
      createdAt: new Date(now),
      likeCount: 15,
    });

    const prevRes = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${currentPost}/compare?against=previous_post`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(prevRes.statusCode).toBe(200);
    expect(prevRes.json().comparison.contentId).toBe(prevPost);

    const weekRes = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${currentPost}/compare?against=7d_ago`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(weekRes.statusCode).toBe(200);
    expect(weekRes.json().comparison.contentId).toBe(post8dAgo);
  });

  it('7. Cohort comparison applies ±10% verdict thresholds accurately', async () => {
    const now = Date.now();
    await insertPost(creatorA, 'Baseline', { createdAt: new Date(now - 3_600_000), likeCount: 20 });
    const similarPost = await insertPost(creatorA, 'Similar', { createdAt: new Date(now - 1_800_000), likeCount: 21 });
    const betterPost = await insertPost(creatorA, 'Better', { createdAt: new Date(now - 900_000), likeCount: 30 });
    const worsePost = await insertPost(creatorA, 'Worse', { createdAt: new Date(now), likeCount: 5 });

    for (const [id, expected] of [
      [similarPost, 'similar'],
      [betterPost, 'better'],
      [worsePost, 'worse'],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/analytics/me/content/post/${id}/compare?against=previous_post`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().verdict).toBe(expected);
    }
  });

  // === Hashtag Performance (2) ===

  it('8. Hashtag analytics aggregates impressions, reach, avgLikes, avgComments across tagged posts', async () => {
    const now = new Date();
    const p1 = await insertPost(creatorA, 'Post 1 #tech #ai', {
      createdAt: now,
      hashtags: ['tech', 'ai'],
      likeCount: 6,
      commentCount: 2,
    });
    const p2 = await insertPost(creatorA, 'Post 2 #tech', {
      createdAt: now,
      hashtags: ['tech'],
      likeCount: 2,
      commentCount: 0,
    });
    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: p1, source: 'feed', seenAt: now },
      { userId: viewerC, contentType: 'post', contentId: p1, source: 'feed', seenAt: now },
      { userId: viewerD, contentType: 'post', contentId: p2, source: 'explore', seenAt: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/hashtags?period=30d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().hashtags;
    const tech = rows.find((h: any) => h.tag === 'tech');
    expect(tech.posts).toBe(2);
    expect(tech.impressions).toBe(3);
    expect(tech.avgLikes).toBe(4);
    expect(tech.avgComments).toBe(1);
  });

  it('9. Hashtag verdict is evaluated relative to creator post engagement rate baseline', async () => {
    const now = new Date();
    const pHigh = await insertPost(creatorA, '#winner', {
      createdAt: now,
      hashtags: ['winner'],
      likeCount: 10,
    });
    const pMid = await insertPost(creatorA, '#avg', {
      createdAt: now,
      hashtags: ['avg'],
      likeCount: 5,
    });
    const pLow = await insertPost(creatorA, '#loser', {
      createdAt: now,
      hashtags: ['loser'],
      likeCount: 1,
    });

    const impressions: any[] = [];
    for (const pid of [pHigh, pMid, pLow]) {
      for (const uid of [viewerB, viewerC, viewerD, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]) {
        impressions.push({ userId: uid, contentType: 'post', contentId: pid, source: 'feed', seenAt: now });
      }
    }
    await db.collection('impressions').insertMany(impressions);

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/hashtags?period=30d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const byTag = new Map<string, any>(res.json().hashtags.map((h: any) => [h.tag, h]));
    expect(byTag.get('winner').verdict).toBe('high');
    expect(byTag.get('avg').verdict).toBe('medium');
    expect(byTag.get('loser').verdict).toBe('low');
  });

  // === Speed (2) ===

  it('10. Speed endpoint classifies viral engagement (<5min) and computes halfLifeHours', async () => {
    const postedAt = new Date(Date.now() - 4 * 3_600_000);
    const postId = await insertPost(creatorA, 'Fast post', { createdAt: postedAt });
    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'like', at: new Date(postedAt.getTime() + 90_000) },
      { contentType: 'post', contentId: postId, userId: viewerC, event: 'comment', at: new Date(postedAt.getTime() + 2 * 3_600_000) },
      { contentType: 'post', contentId: postId, userId: viewerD, event: 'save', at: new Date(postedAt.getTime() + 3 * 3_600_000) },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/speed`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.speedRating).toBe('viral');
    expect(body.timeToFirstEngagement).toBe(90);
    expect(body.firstEngagementType).toBe('like');
    expect(body.halfLifeHours).toBe(2);
  });

  it('11. Speed endpoint handles zero engagement with null metrics and no_engagement rating', async () => {
    const postId = await insertPost(creatorA, 'Quiet post', { createdAt: new Date(Date.now() - 48 * 3_600_000) });

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/speed`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.speedRating).toBe('no_engagement');
    expect(body.firstEngagementAt).toBeNull();
    expect(body.timeToFirstEngagement).toBeNull();
    expect(body.firstEngagementType).toBeNull();
    expect(body.halfEngagementsAt).toBeNull();
    expect(body.halfLifeHours).toBeNull();
  });

  // === Decay Curve (2) ===

  it('12. Decay endpoint buckets engagements by ageHours and computes rateVsPeak', async () => {
    const postedAt = new Date(Date.now() - 72 * 3_600_000);
    const postId = await insertPost(creatorA, 'Decay post', { createdAt: postedAt });
    const h = 3_600_000;
    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'like', at: new Date(postedAt.getTime() + 1 * h) },
      { contentType: 'post', contentId: postId, userId: viewerC, event: 'like', at: new Date(postedAt.getTime() + 2 * h) },
      { contentType: 'post', contentId: postId, userId: viewerD, event: 'comment', at: new Date(postedAt.getTime() + 3 * h) },
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'save', at: new Date(postedAt.getTime() + 4 * h) },
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'share', at: new Date(postedAt.getTime() + 8 * h) },
      { contentType: 'post', contentId: postId, userId: viewerC, event: 'share', at: new Date(postedAt.getTime() + 9 * h) },
      { contentType: 'post', contentId: postId, userId: viewerC, event: 'like', at: new Date(postedAt.getTime() + 15 * h) },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/decay`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.peakBucket).toBe('0-6');
    expect(body.buckets).toEqual([
      { ageHours: '0-6', engagements: 4, rateVsPeak: 1 },
      { ageHours: '6-12', engagements: 2, rateVsPeak: 0.5 },
      { ageHours: '12-24', engagements: 1, rateVsPeak: 0.25 },
      { ageHours: '24-48', engagements: 0, rateVsPeak: 0 },
      { ageHours: '48-168', engagements: 0, rateVsPeak: 0 },
    ]);
  });

  it('13. Decay endpoint computes halfLifeHours accurately from peak bucket', async () => {
    const postedAt = new Date(Date.now() - 72 * 3_600_000);
    const postId = await insertPost(creatorA, 'Peak half life post', { createdAt: postedAt });
    const h = 3_600_000;
    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: postId, userId: viewerB, event: 'like', at: new Date(postedAt.getTime() + 1 * h) },
      { contentType: 'post', contentId: postId, userId: viewerC, event: 'like', at: new Date(postedAt.getTime() + 2 * h) },
      { contentType: 'post', contentId: postId, userId: viewerD, event: 'save', at: new Date(postedAt.getTime() + 8 * h) },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId}/decay`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.peakBucket).toBe('0-6');
    // Peak midpoint = 3h (rate 1.0), 6-12 midpoint = 9h (rate 0.5) -> half-life from peak = 6h
    expect(body.halfLifeHours).toBe(6);
  });

  // === Best Time (1) ===

  it('14. Best time endpoint sorts top3Hours by engagement rate descending and filters by contentType', async () => {
    const now = new Date();
    const hour14 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 14, 0, 0));
    const hour09 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 9, 0, 0));
    const hour20 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 20, 0, 0));

    const p14 = await insertPost(creatorA, 'At 14', { createdAt: hour14, likeCount: 8 });
    const p09 = await insertPost(creatorA, 'At 09', { createdAt: hour09, likeCount: 4 });
    const p20 = await insertPost(creatorA, 'At 20', { createdAt: hour20, likeCount: 2 });
    await insertReel(creatorA, 'Reel only', hour20);

    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: p14, source: 'feed', seenAt: hour14 },
      { userId: viewerB, contentType: 'post', contentId: p09, source: 'feed', seenAt: hour09 },
      { userId: viewerB, contentType: 'post', contentId: p20, source: 'feed', seenAt: hour20 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/best-time?contentType=post&period=30d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hours).toHaveLength(24);
    expect(body.top3Hours).toEqual([14, 9, 20]);
    expect(body.recommendation).toContain('14:00 UTC');
  });

  // === Audience Activity & Growth (2) ===

  it('15. Audience activity & growth rollups group daily, weekly, and monthly metrics properly', async () => {
    const d5Ago = new Date(Date.now() - 5 * 86_400_000);
    const d1Ago = new Date(Date.now() - 1 * 86_400_000);
    const activityAt = new Date(Date.UTC(d1Ago.getUTCFullYear(), d1Ago.getUTCMonth(), d1Ago.getUTCDate(), 18, 30, 0));

    await db.collection('profiles').updateOne({ userId: creatorA }, { $set: { followerCount: 2 } });
    await db.collection('follows').insertMany([
      { followerId: viewerB, followingId: creatorA, createdAt: d5Ago },
      { followerId: viewerC, followingId: creatorA, createdAt: d1Ago },
    ]);
    await db.collection('engagement_events').insertOne({
      contentType: 'post',
      contentId: new (await import('mongodb')).ObjectId().toString(),
      userId: viewerB,
      event: 'like',
      at: activityAt,
    });

    const actRes = await app.inject({
      method: 'GET',
      url: '/analytics/me/audience/activity',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(actRes.statusCode).toBe(200);
    const act = actRes.json();
    expect(act.byHour[18].activeFollowers).toBe(1);
    expect(act.peakWindow.totalActive).toBe(1);

    const growthRes = await app.inject({
      method: 'GET',
      url: '/analytics/me/audience/growth?period=30d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(growthRes.statusCode).toBe(200);
    const growth = growthRes.json();
    expect(growth.daily).toHaveLength(30);
    expect(growth.daily[29].totalFollowers).toBe(2);
    expect(growth.weekly.length).toBeGreaterThanOrEqual(4);
    expect(growth.monthly.length).toBeGreaterThanOrEqual(1);
  });

  it('16. Audience growth computes churnRate and 30-day retentionRate from unfollow_events', async () => {
    const oldFollowAt = new Date(Date.now() - 40 * 86_400_000);
    const recentUnfollowAt = new Date(Date.now() - 2 * 86_400_000);

    // 4 followers gained 40d ago; 3 remain, 1 unfollowed recently
    const retainedIds = [viewerB, viewerC, viewerD];
    const lostId = crypto.randomUUID();

    await db.collection('profiles').updateOne({ userId: creatorA }, { $set: { followerCount: 3 } });
    await db.collection('follows').insertMany(
      retainedIds.map((fid) => ({ followerId: fid, followingId: creatorA, createdAt: oldFollowAt }))
    );
    await db.collection('follow_sources').insertOne({
      followerId: lostId,
      followingId: creatorA,
      source: 'profile',
      at: oldFollowAt,
    });
    await db.collection('unfollow_events').insertOne({
      followerId: lostId,
      followingId: creatorA,
      at: recentUnfollowAt,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/audience/growth?period=7d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 1 lost over 1 week / 3.14 avg followers -> churnRate > 0
    expect(body.churnRate).toBeGreaterThan(0);
    expect(body.churnRate).toBeCloseTo(1 / 3, 0);
    // 4 gained >=30d ago; 3 remain active today -> retentionRate = 3 / 4 = 0.75
    expect(body.retentionRate).toBe(0.75);

    // Insert another follower gained >=30d ago who left within 10 days
    const earlyLost = crypto.randomUUID();
    await db.collection('follow_sources').insertOne({
      followerId: earlyLost,
      followingId: creatorA,
      source: 'feed',
      at: oldFollowAt,
    });
    await db.collection('unfollow_events').insertOne({
      followerId: earlyLost,
      followingId: creatorA,
      at: new Date(oldFollowAt.getTime() + 10 * 86_400_000),
    });

    const res2 = await app.inject({
      method: 'GET',
      url: '/analytics/me/audience/growth?period=7d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res2.statusCode).toBe(200);
    // 3 of 5 retained after 30+ days = 0.6
    expect(res2.json().retentionRate).toBe(0.6);
  });

  // === Follower Sources (1) ===

  it('17. Follower growth attribution aggregates follow_sources counts and stacked daily trend', async () => {
    const now = new Date();
    await db.collection('follow_sources').insertMany([
      { followerId: viewerB, followingId: creatorA, source: 'reel', at: now },
      { followerId: viewerC, followingId: creatorA, source: 'reel', at: now },
      { followerId: viewerD, followingId: creatorA, source: 'profile', at: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/audience/sources?period=30d',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.topSource).toBe('reel');
    expect(body.sources.find((s: any) => s.source === 'reel').newFollowers).toBe(2);
    expect(body.sources.find((s: any) => s.source === 'profile').newFollowers).toBe(1);
    expect(body.trend.length).toBeGreaterThanOrEqual(2);
  });

  // === Cross-Content Compare (1) ===

  it('18. Cross-content comparison picks winner by engagementRate then reach then saves', async () => {
    const now = new Date();
    const p1 = await insertPost(creatorA, 'Post 1', { createdAt: now, likeCount: 2, saveCount: 1 });
    const p2 = await insertPost(creatorA, 'Post 2 Winner', { createdAt: now, likeCount: 8, saveCount: 3 });

    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: p1, source: 'feed', seenAt: now },
      { userId: viewerC, contentType: 'post', contentId: p1, source: 'feed', seenAt: now },
      { userId: viewerB, contentType: 'post', contentId: p2, source: 'feed', seenAt: now },
      { userId: viewerC, contentType: 'post', contentId: p2, source: 'feed', seenAt: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/compare?contentType=post&contentIds=${p1},${p2}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.winner).toEqual({
      contentId: p2,
      why: 'highest_engagement_rate',
    });

    // Rejects >5 IDs with 400
    const badRes = await app.inject({
      method: 'GET',
      url: `/analytics/me/compare?contentType=post&contentIds=${[
        new (await import('mongodb')).ObjectId().toString(),
        new (await import('mongodb')).ObjectId().toString(),
        new (await import('mongodb')).ObjectId().toString(),
        new (await import('mongodb')).ObjectId().toString(),
        new (await import('mongodb')).ObjectId().toString(),
        new (await import('mongodb')).ObjectId().toString(),
      ].join(',')}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(badRes.statusCode).toBe(400);
  });
});
