import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';
import { runAnalyticsRollup } from '../../src/jobs/analytics-rollup.js';

describe('Analytics Infrastructure (Stage V4-4)', () => {
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
  let tokenC: string;
  let tokenD: string;

  async function clearAnalyticsRedis() {
    if (!redis) return;
    for (const uid of [creatorA, viewerB, viewerC, viewerD]) {
      const rateKeys = await redis.keys(`ratelimit:*:${uid}:*`);
      const impKeys = await redis.keys(`impression:*:${uid}`);
      const visitKeys = await redis.keys(`profile_visit:*:${uid}`);
      const visitTargets = await redis.keys(`profile_visit:${uid}:*`);
      const dedupShare = await redis.keys(`share:dedup:${uid}:*`);
      const all = [...rateKeys, ...impKeys, ...visitKeys, ...visitTargets, ...dedupShare, `rel:blocked:${uid}`];
      if (all.length > 0) await redis.del(...all);
    }
  }

  async function createPost(token: string, body: string): Promise<any> {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function insertReel(authorId: string, caption: string, createdAt: Date = new Date()): Promise<string> {
    const res = await db.collection('reels').insertOne({
      authorId,
      caption,
      videoKey: `users/${authorId}/reels/${Date.now()}-${Math.random()}.mp4`,
      videoUrl: 'https://cdn.example.com/reel.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 20,
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
      mediaType: 'image',
      mediaKey: `users/${authorId}/stories/${Date.now()}.jpg`,
      mediaUrl: 'https://cdn.example.com/story.jpg',
      thumbnailKey: null,
      duration: 5,
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
    dbName = `test_analytics_v4_4_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenA = await createMockAccessToken({ sub: creatorA, email: 'v44a@nebron.io' });
    tokenB = await createMockAccessToken({ sub: viewerB, email: 'v44b@nebron.io' });
    tokenC = await createMockAccessToken({ sub: viewerC, email: 'v44c@nebron.io' });
    tokenD = await createMockAccessToken({ sub: viewerD, email: 'v44d@nebron.io' });

    const now = new Date();
    await db.collection('profiles').insertMany([
      {
        userId: creatorA,
        username: 'creator_v44',
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
        username: 'viewer_b_v44',
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
      {
        userId: viewerC,
        username: 'viewer_c_v44',
        name: 'Viewer C',
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
        userId: viewerD,
        username: 'viewer_d_v44',
        name: 'Viewer D',
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

  beforeEach(async () => {
    await clearAnalyticsRedis();
  });

  afterAll(async () => {
    await clearAnalyticsRedis();
    if (app) await app.close();
    if (client) {
      await db.dropDatabase();
      await mongoDb.closeMongo();
    }
  });

  // === BEACON ENDPOINTS ===

  it('1. POST /analytics/impression inserts once and dedups within 24h per user/content', async () => {
    const post = await createPost(tokenA, 'Impression post');

    const res1 = await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id, source: 'feed' },
    });
    expect(res1.statusCode).toBe(204);

    // Same user within 24h -> deduped
    const res2 = await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id, source: 'explore' },
    });
    expect(res2.statusCode).toBe(204);

    // Distinct user -> inserted
    const res3 = await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { contentType: 'post', contentId: post.id, source: 'hashtag' },
    });
    expect(res3.statusCode).toBe(204);

    const rows = await db.collection('impressions').find({ contentId: post.id }).toArray();
    expect(rows.length).toBe(2);
    const ttl = await redis.ttl(`impression:${post.id}:${viewerB}`);
    expect(ttl).toBeGreaterThan(80_000);
  });

  it('2. POST /analytics/view-start creates content_views row and returns viewId', async () => {
    const reelId = await insertReel(creatorA, 'View start reel');

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reelId, source: 'feed' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(ObjectId.isValid(body.viewId)).toBe(true);

    const row = await db.collection('content_views').findOne({ _id: new ObjectId(body.viewId) });
    expect(row).toBeTruthy();
    expect(row?.userId).toBe(viewerB);
    expect(row?.completed).toBe(false);
    expect(row?.endedAt).toBeNull();
  });

  it('3. POST /analytics/view-heartbeat updates watchedSeconds and endedAt (and blocks foreign viewId)', async () => {
    const reelId = await insertReel(creatorA, 'Heartbeat reel');
    const startRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reelId, source: 'feed' },
    });
    const { viewId } = startRes.json();

    const hbRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-heartbeat',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId, watchedSeconds: 12.5, currentPosition: 12.5 },
    });
    expect(hbRes.statusCode).toBe(204);

    const row = await db.collection('content_views').findOne({ _id: new ObjectId(viewId) });
    expect(row?.watchedSeconds).toBe(12.5);
    expect(row?.endedAt).toBeTruthy();

    const foreignRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-heartbeat',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { viewId, watchedSeconds: 99 },
    });
    expect(foreignRes.statusCode).toBe(403);
  });

  it('4. POST /analytics/view-end marks completed and records taps/exits', async () => {
    const storyId = await insertStory(creatorA, 'View end story');
    const startRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'story', contentId: storyId, source: 'feed' },
    });
    const { viewId } = startRes.json();

    const endRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        viewId,
        watchedSeconds: 5,
        completed: true,
        tapsForward: 2,
        tapsBack: 1,
        exited: false,
      },
    });
    expect(endRes.statusCode).toBe(204);

    const row = await db.collection('content_views').findOne({ _id: new ObjectId(viewId) });
    expect(row?.watchedSeconds).toBe(5);
    expect(row?.completed).toBe(true);
    expect(row?.tapsForward).toBe(2);
    expect(row?.tapsBack).toBe(1);
    expect(row?.exited).toBe(false);
  });

  it('5. POST /analytics/profile-visit records visit, dedups within 6h, and skips self-visit', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/analytics/profile-visit',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { visitedUserId: creatorA },
    });
    expect(res1.statusCode).toBe(204);

    const res2 = await app.inject({
      method: 'POST',
      url: '/analytics/profile-visit',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { visitedUserId: creatorA },
    });
    expect(res2.statusCode).toBe(204);

    const selfRes = await app.inject({
      method: 'POST',
      url: '/analytics/profile-visit',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { visitedUserId: creatorA },
    });
    expect(selfRes.statusCode).toBe(204);

    const visits = await db.collection('profile_visits').find({ visitedUserId: creatorA, visitorId: viewerB }).toArray();
    expect(visits.length).toBe(1);

    const selfVisits = await db.collection('profile_visits').find({ visitedUserId: creatorA, visitorId: creatorA }).toArray();
    expect(selfVisits.length).toBe(0);
  });

  it('6. GET /users/:userId records profile visit non-blocking and shares 6h dedup', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${creatorA}`,
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(res.statusCode).toBe(200);

    // Subsequent POST /analytics/profile-visit from C within 6h is deduped
    await app.inject({
      method: 'POST',
      url: '/analytics/profile-visit',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { visitedUserId: creatorA },
    });

    const visits = await db
      .collection('profile_visits')
      .find({ visitedUserId: creatorA, visitorId: viewerC })
      .toArray();
    expect(visits.length).toBe(1);
  });

  it('7. Beacon endpoints enforce 300/min rate limit per user', async () => {
    const post = await createPost(tokenA, 'Rate limit target');
    const nowWindow = Math.floor(Date.now() / 60000);
    await redis.set(`ratelimit:analytics_beacon:${viewerD}:${nowWindow}`, '300', 'EX', 60);

    const limitedRes = await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenD}` },
      payload: { contentType: 'post', contentId: post.id, source: 'feed' },
    });
    expect(limitedRes.statusCode).toBe(429);
    expect(limitedRes.json().error.code).toBe('rate_limit_exceeded');
  });

  // === ROLLUP JOB ===

  it('8. Rollup job aggregates yesterday impressions, reach, views, likes, comments, saves cleanly', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    const yMid = new Date(`${yesterdayKey}T12:00:00.000Z`);

    const postId = new ObjectId();
    await db.collection('posts').insertOne({
      _id: postId,
      authorId: creatorA,
      body: 'Yesterday rolled post',
      likeCount: 1,
      commentCount: 1,
      saveCount: 1,
      shareCount: 1,
      deleted: false,
      createdAt: yMid,
      updatedAt: yMid,
    });
    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: postId.toString(), source: 'feed', seenAt: yMid },
      { userId: viewerC, contentType: 'post', contentId: postId.toString(), source: 'explore', seenAt: yMid },
    ]);
    await db.collection('post_likes').insertOne({ postId, userId: viewerB, createdAt: yMid });
    await db.collection('comments').insertOne({
      postId,
      authorId: viewerB,
      body: 'Great yesterday!',
      deleted: false,
      createdAt: yMid,
    });
    await db.collection('saved_posts').insertOne({ userId: viewerB, postId, savedAt: yMid });
    await db.collection('share_events').insertOne({
      contentType: 'post',
      contentId: postId.toString(),
      byUserId: viewerC,
      at: yMid,
    });

    const result = await runAnalyticsRollup(yesterday, db);
    expect(result.errors).toEqual([]);
    expect(result.contentUpdated).toBeGreaterThanOrEqual(1);

    const daily = await db.collection('analytics_daily').findOne({
      contentType: 'post',
      contentId: postId.toString(),
      date: yesterdayKey,
    });
    expect(daily).toBeTruthy();
    expect(daily?.impressions).toBe(2);
    expect(daily?.reach).toBe(2);
    expect(daily?.views).toBe(2);
    expect(daily?.likes).toBe(1);
    expect(daily?.comments).toBe(1);
    expect(daily?.saves).toBe(1);
    expect(daily?.shares).toBe(1);
  });

  it('9. Rollup job is idempotent on repeated runs', async () => {
    const dayAgo = new Date(Date.now() - 2 * 86_400_000);
    const dayKey = dayAgo.toISOString().slice(0, 10);
    const mid = new Date(`${dayKey}T10:00:00.000Z`);

    const reelId = await insertReel(creatorA, 'Idempotent rollup reel', mid);
    await db.collection('content_views').insertOne({
      userId: viewerB,
      contentType: 'reel',
      contentId: reelId,
      sessionId: 's1',
      startedAt: mid,
      endedAt: mid,
      watchedSeconds: 15,
      totalSeconds: 20,
      completed: true,
      source: 'feed',
    });

    await runAnalyticsRollup(dayAgo, db);
    await runAnalyticsRollup(dayAgo, db);

    const rows = await db
      .collection('analytics_daily')
      .find({ contentType: 'reel', contentId: reelId, date: dayKey })
      .toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].views).toBe(1);
    expect(rows[0].watchSeconds).toBe(15);
    expect(rows[0].completions).toBe(1);
  });

  it('10. Rollup handles missing/deleted content gracefully without errors', async () => {
    const emptyDay = new Date('2020-01-15T12:00:00.000Z');
    await db.collection('impressions').insertOne({
      userId: viewerB,
      contentType: 'post',
      contentId: new ObjectId().toString(), // non-existent post
      source: 'feed',
      seenAt: emptyDay,
    });

    const res = await runAnalyticsRollup(emptyDay, db);
    expect(res.errors).toEqual([]);
    expect(res.date).toBe('2020-01-15');
  });

  it('11. creator_daily_stats sums correctly across content items', async () => {
    const day = new Date(Date.now() - 3 * 86_400_000);
    const dateKey = day.toISOString().slice(0, 10);
    const t = new Date(`${dateKey}T15:00:00.000Z`);

    const p1 = new ObjectId();
    const p2 = new ObjectId();
    await db.collection('posts').insertMany([
      { _id: p1, authorId: creatorA, body: 'Sum P1', likeCount: 0, commentCount: 0, deleted: false, createdAt: t, updatedAt: t },
      { _id: p2, authorId: creatorA, body: 'Sum P2', likeCount: 0, commentCount: 0, deleted: false, createdAt: t, updatedAt: t },
    ]);
    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: p1.toString(), source: 'feed', seenAt: t },
      { userId: viewerB, contentType: 'post', contentId: p2.toString(), source: 'feed', seenAt: t },
    ]);
    await db.collection('post_likes').insertMany([
      { postId: p1, userId: viewerB, createdAt: t },
      { postId: p2, userId: viewerC, createdAt: t },
    ]);
    await db.collection('follows').insertOne({ followerId: viewerB, followingId: creatorA, createdAt: t });

    await runAnalyticsRollup(day, db);
    const stats = await db.collection('creator_daily_stats').findOne({ userId: creatorA, date: dateKey });
    expect(stats).toBeTruthy();
    expect(stats?.postsCreated).toBe(2);
    expect(stats?.totalImpressions).toBe(2);
    expect(stats?.totalLikesReceived).toBe(2);
    expect(stats?.followersGained).toBe(1);
  });

  it('12. Raw analytics collections have 90-day TTL indexes configured', async () => {
    const expectedTtl = 90 * 24 * 60 * 60;
    const impIdx = await db.collection('impressions').indexes();
    const viewIdx = await db.collection('content_views').indexes();
    const visitIdx = await db.collection('profile_visits').indexes();

    expect(impIdx.find((i) => i.expireAfterSeconds === expectedTtl)).toBeTruthy();
    expect(viewIdx.find((i) => i.expireAfterSeconds === expectedTtl)).toBeTruthy();
    expect(visitIdx.find((i) => i.expireAfterSeconds === expectedTtl)).toBeTruthy();
  });

  // === QUERY ENDPOINTS ===

  it('13. GET /analytics/me/overview returns accurate period totals, topContent, and bestPerformingDay', async () => {
    const freshCreator = crypto.randomUUID();
    const freshToken = await createMockAccessToken({ sub: freshCreator, email: 'fresh_ov@nebron.io' });
    const now = new Date();
    await db.collection('profiles').insertOne({
      userId: freshCreator,
      username: 'fresh_ov_v44',
      name: 'Fresh',
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 10,
      followingCount: 0,
      postCount: 2,
      createdAt: now,
      updatedAt: now,
    });

    const p1 = await createPost(freshToken, 'Top performing post');
    const reelId = await insertReel(freshCreator, 'Active reel');

    await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: p1.id, source: 'feed' },
    });
    await app.inject({
      method: 'POST',
      url: `/posts/${p1.id}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    await app.inject({
      method: 'POST',
      url: `/posts/${p1.id}/save`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/overview?period=7d',
      headers: { authorization: `Bearer ${freshToken}` },
    });
    expect(res.statusCode).toBe(200);
    const overview = res.json();
    expect(overview.period).toBe('7d');
    expect(overview.followers.total).toBe(10);
    expect(overview.content.posts).toBe(1);
    expect(overview.content.reels).toBe(1);
    expect(overview.engagement.impressions).toBeGreaterThanOrEqual(1);
    expect(overview.engagement.reach).toBeGreaterThanOrEqual(1);
    expect(overview.engagement.likes).toBe(1);
    expect(overview.engagement.saves).toBe(1);
    expect(overview.topContent[0].contentId).toBe(p1.id);
    expect(overview.bestPerformingDay).toBe(now.toISOString().slice(0, 10));
  });

  it('14. GET /analytics/me/posts returns per-post metrics and supports limit/before pagination', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'pag_p@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'pag_posts_v44',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const p1 = await createPost(uTok, 'Paginated 1');
    await new Promise((r) => setTimeout(r, 15));
    const p2 = await createPost(uTok, 'Paginated 2');
    await new Promise((r) => setTimeout(r, 15));
    const p3 = await createPost(uTok, 'Paginated 3');

    await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: p3.id, source: 'feed' },
    });
    await app.inject({
      method: 'POST',
      url: `/posts/${p3.id}/like`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const page1Res = await app.inject({
      method: 'GET',
      url: '/analytics/me/posts?period=30d&limit=2',
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json();
    expect(page1.map((x: any) => x.postId)).toEqual([p3.id, p2.id]);
    expect(page1[0].impressions).toBe(1);
    expect(page1[0].likes).toBe(1);
    expect(page1[0].engagementRate).toBe(100);

    const page2Res = await app.inject({
      method: 'GET',
      url: `/analytics/me/posts?period=30d&limit=2&before=${encodeURIComponent(page1[1].createdAt)}`,
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(page2Res.json().map((x: any) => x.postId)).toEqual([p1.id]);
  });

  it('15. GET /analytics/me/reels calculates completionRate, avgWatchSeconds, and replays', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'reel_m@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'reel_m_v44',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const reelId = await insertReel(u, 'Metrics Reel');
    const s1 = (await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reelId, source: 'feed' },
    })).json().viewId;
    await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId: s1, watchedSeconds: 20, completed: true },
    });

    // Second play session by same user -> counts as replay
    const s2 = (await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reelId, source: 'feed', replayed: true },
    })).json().viewId;
    await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId: s2, watchedSeconds: 10, completed: false, replayed: true },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/reels?period=7d',
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json()[0];
    expect(row.reelId).toBe(reelId);
    expect(row.views).toBe(2);
    expect(row.uniqueViews).toBe(1);
    expect(row.watchSeconds).toBe(30);
    expect(row.avgWatchSeconds).toBe(15);
    expect(row.completionRate).toBe(50);
    expect(row.replays).toBe(1);
  });

  it('16. GET /analytics/me/stories includes tapsForward, tapsBack, exits from content_views', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'story_m@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'story_m_v44',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const storyId = await insertStory(u, 'Taps story');
    const v1 = (await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'story', contentId: storyId, source: 'feed' },
    })).json().viewId;
    await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId: v1, watchedSeconds: 4, completed: false, tapsForward: 2, tapsBack: 1, exited: true },
    });

    const v2 = (await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { contentType: 'story', contentId: storyId, source: 'feed' },
    })).json().viewId;
    await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { viewId: v2, watchedSeconds: 5, completed: true, tapsForward: 1, tapsBack: 0, exited: false },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/stories?period=7d',
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json()[0];
    expect(row.storyId).toBe(storyId);
    expect(row.uniqueViewers).toBe(2);
    expect(row.totalViews).toBe(2);
    expect(row.completionRate).toBe(50);
    expect(row.tapsForward).toBe(3);
    expect(row.tapsBack).toBe(1);
    expect(row.exits).toBe(1);
  });

  it('17. GET /analytics/me/content/:contentType/:contentId returns daily time series buckets', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'ts_c@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'ts_c_v44',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const twoDaysKey = twoDaysAgo.toISOString().slice(0, 10);
    const postId = new ObjectId();
    await db.collection('posts').insertOne({
      _id: postId,
      authorId: u,
      body: 'Time series post',
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
    });
    await db.collection('analytics_daily').insertOne({
      contentType: 'post',
      contentId: postId.toString(),
      authorId: u,
      preview: 'Time series post',
      date: twoDaysKey,
      impressions: 12,
      reach: 9,
      views: 12,
      uniqueViews: 9,
      watchSeconds: 0,
      completions: 0,
      tapsForward: 0,
      tapsBack: 0,
      exits: 0,
      replays: 0,
      likes: 4,
      comments: 2,
      replies: 0,
      shares: 1,
      saves: 3,
      profileVisits: 0,
      newFollowers: 0,
      updatedAt: new Date(),
    });

    // Live impression today
    await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: postId.toString(), source: 'feed' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${postId.toString()}?period=7d`,
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.series.length).toBe(7);

    const pastBucket = detail.series.find((b: any) => b.date === twoDaysKey);
    expect(pastBucket.impressions).toBe(12);
    expect(pastBucket.likes).toBe(4);

    const todayBucket = detail.series[detail.series.length - 1];
    expect(todayBucket.impressions).toBe(1);
    expect(detail.totals.impressions).toBe(13);
  });

  it('18. bestTimeToPost correctly buckets engagement events by UTC hour', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'best_hr@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'best_hr_v44',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const yesterdayKey = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const peakHourTime = new Date(`${yesterdayKey}T14:25:00.000Z`);
    const postId = new ObjectId();
    await db.collection('posts').insertOne({
      _id: postId,
      authorId: u,
      body: 'Peak hour post',
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: peakHourTime,
      updatedAt: peakHourTime,
    });
    await db.collection('impressions').insertMany([
      { userId: viewerB, contentType: 'post', contentId: postId.toString(), source: 'feed', seenAt: peakHourTime },
      { userId: viewerC, contentType: 'post', contentId: postId.toString(), source: 'feed', seenAt: peakHourTime },
    ]);
    await db.collection('post_likes').insertOne({ postId, userId: viewerB, createdAt: peakHourTime });

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/overview?period=7d',
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bestTimeToPost[0]).toBe(14);
  });

  it('19. GET /analytics/me/audience returns followerGrowth and activeHours without exposing userIds', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'aud@nebron.io' });
    const now = new Date();
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'aud_v44',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 2,
      followingCount: 0,
      postCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    await app.inject({
      method: 'POST',
      url: `/users/${u}/follow`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-follow-source': 'feed' },
    });
    await app.inject({
      method: 'POST',
      url: `/users/${u}/follow`,
      headers: { authorization: `Bearer ${tokenC}`, 'x-follow-source': 'reel' },
    });

    const someReel = await insertReel(creatorA, 'Some reel for follower activity');
    const activityHour = 9;
    const yesterdayKey = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.collection('content_views').insertMany([
      {
        userId: viewerB,
        contentType: 'reel',
        contentId: someReel,
        sessionId: 'a1',
        startedAt: new Date(`${yesterdayKey}T09:10:00.000Z`),
        endedAt: new Date(`${yesterdayKey}T09:10:10.000Z`),
        watchedSeconds: 10,
        totalSeconds: 20,
        completed: false,
        source: 'feed',
      },
      {
        userId: viewerC,
        contentType: 'reel',
        contentId: someReel,
        sessionId: 'a2',
        startedAt: new Date(`${yesterdayKey}T09:45:00.000Z`),
        endedAt: new Date(`${yesterdayKey}T09:45:10.000Z`),
        watchedSeconds: 10,
        totalSeconds: 20,
        completed: false,
        source: 'feed',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/analytics/me/audience?period=7d',
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.followerGrowth.length).toBe(7);
    expect(body.followerGrowth[body.followerGrowth.length - 1].count).toBe(2);
    expect(body.activeHours.length).toBe(24);
    expect(body.activeHours[activityHour]).toEqual({ hour: 9, followers: 2 });
    expect(JSON.stringify(body)).not.toContain(viewerB);
    expect(JSON.stringify(body)).not.toContain(viewerC);
  });

  // === FOLLOW SOURCE TRACKING ===

  it('20. POST /users/:userId/follow records X-Follow-Source header in follow_sources', async () => {
    const target = crypto.randomUUID();
    await db.collection('profiles').insertOne({
      userId: target,
      username: 'fs_target1',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/users/${target}/follow`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-follow-source': 'reel' },
    });
    expect(res.statusCode).toBe(204);

    // Duplicate follow does not duplicate follow_sources row
    await app.inject({
      method: 'POST',
      url: `/users/${target}/follow`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-follow-source': 'profile' },
    });

    const rows = await db.collection('follow_sources').find({ followerId: viewerB, followingId: target }).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('reel');
  });

  it('21. POST /users/:userId/follow defaults missing or invalid X-Follow-Source to other', async () => {
    const target = crypto.randomUUID();
    await db.collection('profiles').insertOne({
      userId: target,
      username: 'fs_target2',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res1 = await app.inject({
      method: 'POST',
      url: `/users/${target}/follow`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res1.statusCode).toBe(204);

    const res2 = await app.inject({
      method: 'POST',
      url: `/users/${target}/follow`,
      headers: { authorization: `Bearer ${tokenC}`, 'x-follow-source': 'unknown_custom' },
    });
    expect(res2.statusCode).toBe(204);

    const rowB = await db.collection('follow_sources').findOne({ followerId: viewerB, followingId: target });
    const rowC = await db.collection('follow_sources').findOne({ followerId: viewerC, followingId: target });
    expect(rowB?.source).toBe('other');
    expect(rowC?.source).toBe('other');
  });

  // === PRIVACY ===

  it('22. User cannot query /analytics/me/content for another creator content (403 forbidden)', async () => {
    const post = await createPost(tokenA, 'Private creator analytics post');

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/post/${post.id}?period=7d`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('23. Analytics query endpoints never leak viewer/visitor userIds or user lists', async () => {
    const post = await createPost(tokenA, 'Privacy check post');
    await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'post', contentId: post.id, source: 'feed' },
    });

    const [ov, postsRes, audRes] = await Promise.all([
      app.inject({ method: 'GET', url: `/analytics/me/overview?userId=${viewerB}`, headers: { authorization: `Bearer ${tokenA}` } }),
      app.inject({ method: 'GET', url: '/analytics/me/posts', headers: { authorization: `Bearer ${tokenA}` } }),
      app.inject({ method: 'GET', url: '/analytics/me/audience', headers: { authorization: `Bearer ${tokenA}` } }),
    ]);

    for (const r of [ov, postsRes, audRes]) {
      expect(r.statusCode).toBe(200);
      const raw = r.body;
      expect(raw).not.toContain(viewerB);
      expect(raw).not.toContain(viewerC);
      expect(raw).not.toContain('viewer_b_v44');
    }
  });

  it('24. V4-5 Overview and Reel deep-dive include dailyActivity, activityHeatmap, trafficSources, and watchThroughBuckets without PII', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'dash_u@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'dash_u_v45',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 2,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const reelId = await insertReel(u, 'Dashboard reel deep dive');
    const reel = { id: reelId };

    await app.inject({
      method: 'POST',
      url: '/analytics/profile-visit',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { visitedUserId: u },
    });
    await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reel.id, source: 'explore' },
    });
    const startRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'reel', contentId: reel.id, source: 'explore', totalSeconds: 20 },
    });
    const viewId = startRes.json().viewId;
    await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId, watchedSeconds: 11, completed: false },
    });

    const [ovRes, deepRes] = await Promise.all([
      app.inject({ method: 'GET', url: '/analytics/me/overview?period=7d', headers: { authorization: `Bearer ${uTok}` } }),
      app.inject({ method: 'GET', url: `/analytics/me/content/reel/${reel.id}?period=7d`, headers: { authorization: `Bearer ${uTok}` } }),
    ]);

    expect(ovRes.statusCode).toBe(200);
    const ov = ovRes.json();
    expect(ov.profileVisits).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(ov.dailyActivity)).toBe(true);
    expect(ov.dailyActivity.length).toBe(7);
    expect(Array.isArray(ov.activityHeatmap)).toBe(true);
    expect(ov.activityHeatmap.length).toBe(7);
    expect(ov.activityHeatmap[0].length).toBe(24);
    expect(ov.topByType?.reel?.contentId).toBe(reel.id);
    expect(ovRes.body).not.toContain(viewerB);

    expect(deepRes.statusCode).toBe(200);
    const deep = deepRes.json();
    expect(deep.trafficSources).toEqual(expect.arrayContaining([{ source: 'explore', count: 1 }]));
    expect(deep.watchThroughBuckets.length).toBe(10);
    expect(deep.watchThroughBuckets[0].percentage).toBe(100);
    expect(deep.watchThroughBuckets[5].percentage).toBe(100); // >= 50% (11/20 = 55%)
    expect(deep.watchThroughBuckets[9].percentage).toBe(0);   // < 90%
    expect(deepRes.body).not.toContain(viewerB);
  });

  it('25. V4-5 Story deep-dive returns funnel and 24 hourlyViews buckets without PII', async () => {
    const u = crypto.randomUUID();
    const uTok = await createMockAccessToken({ sub: u, email: 'story_dash@nebron.io' });
    await db.collection('profiles').insertOne({
      userId: u,
      username: 'story_dash_v45',
      name: null,
      language: 'en',
      theme: 'dark',
      avatarKey: null,
      bannerKey: null,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const storyId = new ObjectId();
    const createdAt = new Date(Date.now() - 2 * 3_600_000);
    await db.collection('stories').insertOne({
      _id: storyId,
      authorId: u,
      mediaType: 'image',
      mediaKey: `stories/${u}/s.jpg`,
      mediaUrl: 'https://cdn.test/s.jpg',
      thumbnailKey: null,
      duration: 5,
      caption: 'Funnel story',
      viewers: [{ userId: viewerB, viewedAt: createdAt }],
      viewerCount: 1,
      expiresAt: new Date(createdAt.getTime() + 24 * 3_600_000),
      createdAt,
    });

    await app.inject({
      method: 'POST',
      url: '/analytics/impression',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'story', contentId: storyId.toString(), source: 'feed' },
    });
    const stRes = await app.inject({
      method: 'POST',
      url: '/analytics/view-start',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { contentType: 'story', contentId: storyId.toString(), source: 'feed', totalSeconds: 5 },
    });
    await app.inject({
      method: 'POST',
      url: '/analytics/view-end',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { viewId: stRes.json().viewId, watchedSeconds: 5, completed: true },
    });

    const deepRes = await app.inject({
      method: 'GET',
      url: `/analytics/me/content/story/${storyId.toString()}?period=7d`,
      headers: { authorization: `Bearer ${uTok}` },
    });
    expect(deepRes.statusCode).toBe(200);
    const deep = deepRes.json();
    expect(deep.funnel).toMatchObject({ impressions: 1, views: 1, completed: 1, replied: 0 });
    expect(deep.hourlyViews.length).toBe(24);
    expect(deepRes.body).not.toContain(viewerB);
  });
});
