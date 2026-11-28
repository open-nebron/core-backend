import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import { ObjectId } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { runPlatformRollup } from '../../src/jobs/platform-rollup.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';

describe('Platform-Wide Admin Analytics (Stage V4.5-3)', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  let mockServer: http.Server;
  let mockUrl: string;
  let mockChatFail = false;
  let mockRequests: Array<{ url: string; token: string | undefined }> = [];

  const origChatUrl = env.CHAT_SERVICE_URL;
  const origVoiceUrl = env.VOICE_SERVICE_URL;
  const origSpacesUrl = env.SPACES_SERVICE_URL;

  const adminId = crypto.randomUUID();
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

  let tokenAdmin: string;
  let tokenUserA: string;

  async function clearRedis() {
    if (!redis) return;
    const keys = [
      'live:online_users',
      'live:active_calls',
      'live:active_conversations',
      'live:messages_last_minute',
      'live:signups_last_hour',
    ];
    for (const uid of [adminId, userA, userB, userC]) {
      const rateKeys = await redis.keys(`ratelimit:*:${uid}:*`);
      keys.push(...rateKeys, `rel:blocked:${uid}`);
    }
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_admin_analytics_v4_5_3_${crypto.randomUUID().replace(/-/g, '')}`;
    const conn = await mongoDb.connectMongo(`mongodb://localhost:27017/${dbName}`);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenAdmin = await createMockAccessToken({ sub: adminId, email: 'admin@nebron.io' });
    tokenUserA = await createMockAccessToken({ sub: userA, email: 'usera@nebron.io' });

    // Start local mock server simulating chat-service, voice-service, and spaces-service internal routes
    mockServer = http.createServer((req, res) => {
      const reqUrl = req.url || '/';
      mockRequests.push({
        url: reqUrl,
        token: req.headers['x-internal-token'] as string | undefined,
      });

      if (mockChatFail && reqUrl.startsWith('/internal/analytics/messages')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'service_unavailable' }));
        return;
      }

      if (req.headers['x-internal-token'] !== env.INTERNAL_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (reqUrl.startsWith('/internal/analytics/messages')) {
        const parsed = new URL(reqUrl, 'http://localhost');
        const sinceStr = parsed.searchParams.get('since');
        const untilStr = parsed.searchParams.get('until');
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const isPrev = sinceStr && untilStr && new Date(untilStr).getTime() < Date.now() - 5 * 86_400_000;
        res.end(
          JSON.stringify({
            totalMessages: isPrev ? 40 : 125,
            totalConversations: 15,
            activeConversations: isPrev ? 4 : 9,
            daily: [
              { date: yesterday, messages: 45, activeConversations: 5 },
              { date: today, messages: 80, activeConversations: 9 },
            ],
            groups: { totalGroups: 6, activeGroups: 4 },
          })
        );
        return;
      }

      if (reqUrl.startsWith('/internal/analytics/calls')) {
        const parsed = new URL(reqUrl, 'http://localhost');
        const untilStr = parsed.searchParams.get('until');
        const isPrev = untilStr && new Date(untilStr).getTime() < Date.now() - 5 * 86_400_000;
        res.end(
          JSON.stringify({
            totalCalls: isPrev ? 10 : 28,
            completedCalls: 24,
            avgDurationSeconds: 185.5,
            totalMinutes: 86.5,
            byType: { audio: 18, video: 10 },
            uniqueUsersCount: 6,
            daily: [],
            durationHistogram: [
              { bucket: '<1m', count: 5 },
              { bucket: '1-5m', count: 14 },
              { bucket: '5-15m', count: 6 },
              { bucket: '15-30m', count: 2 },
              { bucket: '30m+', count: 1 },
            ],
          })
        );
        return;
      }

      if (reqUrl.startsWith('/internal/analytics/spaces')) {
        res.end(
          JSON.stringify({
            spaces: 5,
            activeSpaces: 3,
            members: 14,
          })
        );
        return;
      }

      res.end('{}');
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        if (addr && typeof addr !== 'string') {
          mockUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    (env as any).CHAT_SERVICE_URL = mockUrl;
    (env as any).VOICE_SERVICE_URL = mockUrl;
    (env as any).SPACES_SERVICE_URL = mockUrl;

    app = await buildApp();
  });

  afterAll(async () => {
    (env as any).CHAT_SERVICE_URL = origChatUrl;
    (env as any).VOICE_SERVICE_URL = origVoiceUrl;
    (env as any).SPACES_SERVICE_URL = origSpacesUrl;

    await clearRedis();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    await app?.close();
    await db?.dropDatabase();
    await mongoDb.closeMongo();
    await client?.close();
  });

  beforeEach(async () => {
    mockChatFail = false;
    mockRequests = [];
    await clearRedis();
    for (const col of [
      'profiles',
      'posts',
      'post_likes',
      'comments',
      'comment_likes',
      'comment_reactions',
      'reels',
      'reel_likes',
      'stories',
      'saved_posts',
      'saved_reels',
      'saved_comments',
      'share_events',
      'impressions',
      'content_views',
      'engagement_events',
      'reports',
      'admin_actions',
      'platform_daily_stats',
      'follow_sources',
      'unfollow_events',
      'blocks',
    ]) {
      await db.collection(col).deleteMany({});
    }

    const now = new Date();
    const days40Ago = new Date(now.getTime() - 40 * 86_400_000);
    await db.collection('profiles').insertMany([
      {
        userId: adminId,
        username: 'platform_admin',
        name: 'Platform Admin',
        dateOfBirth: new Date('1992-04-10T00:00:00Z'),
        isAdmin: true,
        isVerified: true,
        isPrivate: false,
        signupSource: 'organic',
        lastSeenAt: now,
        createdAt: days40Ago,
        updatedAt: now,
      },
      {
        userId: userA,
        username: 'alice_creator',
        name: 'Alice',
        dateOfBirth: new Date('2002-06-15T00:00:00Z'), // 18-24
        isAdmin: false,
        isVerified: true,
        isPrivate: false,
        signupSource: 'referral',
        lastSeenAt: now,
        createdAt: days40Ago,
        updatedAt: now,
      },
      {
        userId: userB,
        username: 'bob_viewer',
        name: 'Bob',
        dateOfBirth: new Date('1988-01-20T00:00:00Z'), // 35-44
        isAdmin: false,
        isVerified: false,
        isPrivate: true,
        signupSource: 'direct',
        lastSeenAt: new Date(now.getTime() - 5 * 86_400_000),
        createdAt: new Date(now.getTime() - 10 * 86_400_000),
        updatedAt: now,
      },
      {
        userId: userC,
        username: 'carol_banned',
        name: 'Carol',
        dateOfBirth: null, // unknown
        isAdmin: false,
        isBanned: true,
        bannedAt: new Date(now.getTime() - 86_400_000),
        signupSource: 'direct',
        lastSeenAt: new Date(now.getTime() - 2 * 86_400_000),
        createdAt: new Date(now.getTime() - 2 * 86_400_000),
        updatedAt: now,
      },
    ]);
  });

  // === Auth / Permissions (2) ===

  it('1. Rejects non-admin user with 403 across all /admin/analytics/* endpoints', async () => {
    const routes = [
      '/admin/analytics/overview',
      '/admin/analytics/users',
      '/admin/analytics/content',
      '/admin/analytics/chat',
      '/admin/analytics/moderation',
      '/admin/analytics/features',
      '/admin/analytics/growth',
      '/admin/analytics/live',
    ];
    for (const url of routes) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${tokenUserA}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_admin');
    }
  });

  it('2. Rejects unauthenticated request with 401 and invalid period query with 400', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/admin/analytics/overview' });
    expect(unauth.statusCode).toBe(401);

    const badPeriod = await app.inject({
      method: 'GET',
      url: '/admin/analytics/overview?period=365d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(badPeriod.statusCode).toBe(400);
  });

  // === Platform Rollup Job (3) ===

  it('3. Platform rollup aggregates yesterday users, content, chat, calls, and moderation stats', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    yesterday.setUTCHours(12, 0, 0, 0);
    const yKey = yesterday.toISOString().slice(0, 10);

    const postRes = await db.collection('posts').insertOne({
      authorId: userA,
      body: 'Yesterday post',
      likeCount: 1,
      commentCount: 1,
      deleted: false,
      createdAt: yesterday,
      updatedAt: yesterday,
    });
    await db.collection('post_likes').insertOne({ postId: postRes.insertedId, userId: userB, createdAt: yesterday });
    await db.collection('comments').insertOne({
      postId: postRes.insertedId,
      authorId: userB,
      body: 'Nice post',
      deleted: false,
      createdAt: yesterday,
    });
    await db.collection('share_events').insertOne({
      contentType: 'post',
      contentId: postRes.insertedId.toString(),
      byUserId: userB,
      at: yesterday,
    });
    await db.collection('saved_posts').insertOne({
      userId: userB,
      postId: postRes.insertedId,
      savedAt: yesterday,
    });

    await db.collection('reports').insertOne({
      reporterId: userB,
      targetType: 'post',
      targetId: postRes.insertedId.toString(),
      targetOwnerId: userA,
      reason: 'spam',
      status: 'resolved',
      resolvedBy: adminId,
      resolvedAt: new Date(yesterday.getTime() + 2 * 3_600_000),
      resolutionNote: 'Handled',
      createdAt: yesterday,
    });
    await db.collection('admin_actions').insertOne({
      adminId,
      action: 'ban_user',
      targetType: 'user',
      targetId: userC,
      details: {},
      createdAt: yesterday,
    });

    const res = await runPlatformRollup(yesterday, {
      db,
      chatUrl: mockUrl,
      voiceUrl: mockUrl,
    });
    expect(res.date).toBe(yKey);
    expect(res.errors).toEqual([]);
    expect(res.stats.users.total).toBe(4);
    expect(res.stats.users.verified).toBe(2);
    expect(res.stats.content.postsCreated).toBe(1);
    expect(res.stats.content.totalLikes).toBe(1);
    expect(res.stats.content.totalComments).toBe(1);
    expect(res.stats.content.totalShares).toBe(1);
    expect(res.stats.content.totalSaves).toBe(1);
    expect(res.stats.chat.messagesSent).toBe(125);
    expect(res.stats.chat.callsMade).toBe(28);
    expect(res.stats.chat.callMinutes).toBe(86.5);
    expect(res.stats.moderation.reportsCreated).toBe(1);
    expect(res.stats.moderation.reportsResolved).toBe(1);
    expect(res.stats.moderation.usersBanned).toBe(1);
    expect(res.stats.moderation.avgResolutionTimeHours).toBe(2);
  });

  it('4. Platform rollup is idempotent when re-run for the same UTC date', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    yesterday.setUTCHours(10, 0, 0, 0);
    const yKey = yesterday.toISOString().slice(0, 10);

    await db.collection('posts').insertOne({
      authorId: userA,
      body: 'Idempotent post',
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: yesterday,
      updatedAt: yesterday,
    });

    await runPlatformRollup(yesterday, { db, chatUrl: mockUrl, voiceUrl: mockUrl });
    await runPlatformRollup(yesterday, { db, chatUrl: mockUrl, voiceUrl: mockUrl });

    const stored = await db.collection('platform_daily_stats').find({ date: yKey }).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0].content.postsCreated).toBe(1);
  });

  it('5. Platform rollup handles empty date window and unreachable services gracefully', async () => {
    const oldDate = new Date(Date.now() - 120 * 86_400_000);
    const res = await runPlatformRollup(oldDate, {
      db,
      chatUrl: 'http://127.0.0.1:1',
      voiceUrl: 'http://127.0.0.1:1',
    });
    expect(res.upserted).toBe(true);
    expect(res.stats.content.postsCreated).toBe(0);
    expect(res.stats.chat.messagesSent).toBe(0);
    expect(res.stats.chat.callsMade).toBe(0);
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
  });

  // === Overview (3) ===

  it('6. Overview returns platform metrics across users, content, chat, moderation, timeline, and trend', async () => {
    const now = new Date();
    const pid = new ObjectId();
    await db.collection('posts').insertOne({
      _id: pid,
      authorId: userA,
      body: 'Overview post',
      likeCount: 2,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('post_likes').insertMany([
      { postId: pid, userId: userB, createdAt: now },
      { postId: pid, userId: adminId, createdAt: now },
    ]);
    await db.collection('reports').insertOne({
      reporterId: userB,
      targetType: 'post',
      targetId: pid.toString(),
      targetOwnerId: userA,
      reason: 'spam',
      status: 'pending',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: now,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/overview?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period).toBe('30d');
    expect(body.users.total).toBe(4);
    expect(body.users.banned).toBe(1);
    expect(body.users.verified).toBe(2);
    expect(body.users.active24h).toBeGreaterThanOrEqual(2);
    expect(body.content.postsCreated).toBe(1);
    expect(body.content.totalLikes).toBe(2);
    expect(body.chat.messagesSent).toBe(125);
    expect(body.chat.callsMade).toBe(28);
    expect(body.moderation.pendingBacklog).toBe(1);
    expect(body.timeline).toHaveLength(30);
    expect(typeof body.trend.users).toBe('number');
    expect(typeof body.trend.content).toBe('number');
    expect(typeof body.trend.chat).toBe('number');
  });

  it('7. Overview calculates growthRate against previous period cleanly', async () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    await db.collection('posts').insertMany([
      { authorId: userA, body: 'Prev p1', likeCount: 0, commentCount: 0, deleted: false, createdAt: tenDaysAgo, updatedAt: tenDaysAgo },
      { authorId: userA, body: 'Curr p1', likeCount: 0, commentCount: 0, deleted: false, createdAt: now, updatedAt: now },
      { authorId: userA, body: 'Curr p2', likeCount: 0, commentCount: 0, deleted: false, createdAt: now, updatedAt: now },
      { authorId: userA, body: 'Curr p3', likeCount: 0, commentCount: 0, deleted: false, createdAt: now, updatedAt: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/overview?period=7d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content.postsCreated).toBe(3);
    expect(body.content.growthRate.posts).toBe(200);
  });

  it('8. Overview degrades gracefully if chat-service returns 503', async () => {
    mockChatFail = true;
    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/overview?period=7d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chat.messagesSent).toBe(0);
    expect(body.chat.callsMade).toBe(28);
  });

  // === Users Analytics (3) ===

  it('9. Users endpoint computes D1/D7/D30 active counts and retention ratios', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/users?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(4);
    expect(body.new).toBe(2); // userB (-10d), userC (-2d)
    expect(body.active.d1).toBeGreaterThanOrEqual(2);
    expect(body.active.d7).toBeGreaterThanOrEqual(4);
    expect(body.retention.d1).toBeGreaterThan(0);
    expect(body.retention.d30).toBe(1); // both 40d-old accounts seen today
  });

  it('10. Users endpoint returns age distribution buckets, verifiedCount, privateCount, and growth array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/users?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.demographics.verifiedCount).toBe(2);
    expect(body.demographics.privateCount).toBe(1);
    const bucketMap = new Map(body.demographics.ageDistribution.map((b: any) => [b.bucket, b.count]));
    expect(bucketMap.get('18-24')).toBe(1);
    expect(bucketMap.get('35-44')).toBe(1);
    expect(bucketMap.get('unknown')).toBe(1);
    expect(body.growth).toHaveLength(30);
    expect(body.growth[body.growth.length - 1].total).toBe(4);
    expect(Array.isArray(body.cohorts)).toBe(true);
    expect(body.cohorts.length).toBeGreaterThanOrEqual(1);
  });

  // === Content Analytics (3) ===

  it('11. Content endpoint aggregates posts, reels, stories, engagement types, and topContent', async () => {
    const now = new Date();
    const postId = new ObjectId();
    const reelId = new ObjectId();
    const storyId = new ObjectId();

    await db.collection('posts').insertOne({
      _id: postId,
      authorId: userA,
      body: 'Top viral post',
      likeCount: 3,
      commentCount: 1,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('reels').insertOne({
      _id: reelId,
      authorId: userA,
      caption: 'Viral reel',
      videoKey: 'v.mp4',
      videoUrl: 'https://cdn.example.com/v.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 15,
      viewCount: 2,
      likeCount: 1,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('stories').insertOne({
      _id: storyId,
      authorId: userB,
      mediaType: 'image',
      mediaKey: 's.jpg',
      mediaUrl: 'https://cdn.example.com/s.jpg',
      thumbnailKey: null,
      duration: 5,
      caption: 'Morning story',
      viewers: [{ userId: userA, viewedAt: now }],
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
    });
    await db.collection('impressions').insertMany([
      { contentType: 'post', contentId: postId.toString(), userId: userB, source: 'feed', seenAt: now },
      { contentType: 'post', contentId: postId.toString(), userId: userC, source: 'explore', seenAt: now },
    ]);
    await db.collection('content_views').insertOne({
      userId: userB,
      contentType: 'reel',
      contentId: reelId.toString(),
      sessionId: 's1',
      startedAt: now,
      endedAt: now,
      watchedSeconds: 12,
      totalSeconds: 15,
      completed: true,
      source: 'feed',
    });
    await db.collection('post_likes').insertMany([
      { postId, userId: userB, createdAt: now },
      { postId, userId: userC, createdAt: now },
    ]);
    await db.collection('engagement_events').insertMany([
      { contentType: 'post', contentId: postId.toString(), userId: userB, event: 'like', at: now },
      { contentType: 'reel', contentId: reelId.toString(), userId: userB, event: 'view_long', at: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/content?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.posts.created).toBe(1);
    expect(body.posts.impressions).toBe(2);
    expect(body.posts.likes).toBe(2);
    expect(body.posts.avgEngagementRate).toBe(1);
    expect(body.reels.created).toBe(1);
    expect(body.reels.completionRate).toBe(1);
    expect(body.stories.created).toBe(1);
    expect(body.stories.views).toBe(1);
    expect(body.engagement.byType.viewLong).toBe(1);
    expect(body.topContent.length).toBe(3);
    expect(body.topContent[0].contentId).toBe(postId.toString());
  });

  it('12. Content analytics does NOT exclude blocked user interactions in platform totals', async () => {
    const now = new Date();
    const postId = new ObjectId();
    await db.collection('blocks').insertOne({ blockerId: adminId, blockedId: userA, createdAt: now });
    await db.collection('posts').insertOne({
      _id: postId,
      authorId: userA,
      body: 'Post from blocked user relative to admin',
      likeCount: 1,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/content?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.posts.created).toBe(1);
    expect(body.topContent.some((item: any) => item.contentId === postId.toString())).toBe(true);
  });

  // === Chat & Voice Analytics (2) ===

  it('13. Chat analytics calls chat-service and voice-service internal endpoints with INTERNAL_TOKEN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/chat?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalMessages).toBe(125);
    expect(body.totalConversations).toBe(15);
    expect(body.avgMessagesPerConversation).toBe(8.33);
    expect(body.groups.totalGroups).toBe(6);
    expect(body.groups.activeGroups).toBe(4);
    expect(body.calls.total).toBe(28);
    expect(body.calls.byType.audio).toBe(18);
    expect(body.calls.byType.video).toBe(10);
    expect(body.calls.durationHistogram).toHaveLength(5);
    expect(mockRequests.every((r) => r.token === env.INTERNAL_TOKEN)).toBe(true);
  });

  // === Moderation Analytics (2) ===

  it('14. Moderation endpoint aggregates byType, byReason, actions, resolution histogram, and topAdmins', async () => {
    const now = new Date();
    const h2Ago = new Date(now.getTime() - 2 * 3_600_000);
    const h30Ago = new Date(now.getTime() - 30 * 3_600_000);

    await db.collection('reports').insertMany([
      {
        reporterId: userA,
        targetType: 'post',
        targetId: new ObjectId().toString(),
        targetOwnerId: userB,
        reason: 'spam',
        status: 'resolved',
        resolvedBy: adminId,
        resolvedAt: now,
        resolutionNote: 'Removed',
        createdAt: h2Ago,
      },
      {
        reporterId: userB,
        targetType: 'message',
        targetId: 'conv1:msg1',
        targetOwnerId: userC,
        reason: 'harassment',
        status: 'dismissed',
        resolvedBy: adminId,
        resolvedAt: now,
        resolutionNote: 'OK',
        createdAt: h30Ago,
      },
      {
        reporterId: userA,
        targetType: 'user',
        targetId: userC,
        targetOwnerId: userC,
        reason: 'hate',
        status: 'pending',
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: now,
      },
    ]);

    await db.collection('admin_actions').insertMany([
      { adminId, action: 'delete_post', targetType: 'post', targetId: 'p1', details: {}, createdAt: now },
      { adminId, action: 'delete_comment', targetType: 'comment', targetId: 'c1', details: {}, createdAt: now },
      { adminId, action: 'delete_post', targetType: 'report', targetId: 'conv1:m1', details: { action: 'delete_message' }, createdAt: now },
      { adminId, action: 'ban_user', targetType: 'user', targetId: userC, details: {}, createdAt: now },
      { adminId, action: 'warn_user', targetType: 'user', targetId: userB, details: {}, createdAt: now },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/moderation?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reports.created).toBe(3);
    expect(body.reports.resolved).toBe(1);
    expect(body.reports.dismissed).toBe(1);
    expect(body.reports.pending).toBe(1);
    expect(body.reports.avgResolutionTimeHours).toBe(16);
    expect(body.byType.post).toBe(1);
    expect(body.byType.message).toBe(1);
    expect(body.byType.user).toBe(1);
    expect(body.byReason.spam).toBe(1);
    expect(body.byReason.harassment).toBe(1);
    expect(body.actions.deleted_posts).toBe(1);
    expect(body.actions.deleted_comments).toBe(1);
    expect(body.actions.deleted_messages).toBe(1);
    expect(body.actions.users_banned).toBe(1);
    expect(body.actions.users_warned).toBe(1);
    expect(body.topAdmins[0].adminId).toBe(adminId);
    expect(body.topAdmins[0].username).toBe('platform_admin');
    expect(body.topAdmins[0].actionsTaken).toBe(5);
    const histMap = new Map(body.resolutionTimeHistogram.map((b: any) => [b.bucket, b.count]));
    expect(histMap.get('1-6h')).toBe(1);
    expect(histMap.get('1-3d')).toBe(1);
  });

  // === Features Adoption Analytics (2) ===

  it('15. Features endpoint computes adoption rates for stories, reels, comments, reactions, calls, and spaces', async () => {
    const now = new Date();
    await db.collection('stories').insertOne({
      authorId: userA,
      mediaType: 'image',
      mediaKey: 's1.jpg',
      mediaUrl: 'https://cdn.example.com/s1.jpg',
      thumbnailKey: null,
      duration: 5,
      caption: null,
      viewers: [],
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
    });
    await db.collection('reels').insertOne({
      authorId: userA,
      caption: 'Reel 1',
      videoKey: 'r1.mp4',
      videoUrl: 'https://cdn.example.com/r1.mp4',
      thumbnailKey: null,
      thumbnailUrl: null,
      duration: 15,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    const cid = new ObjectId();
    await db.collection('comments').insertOne({
      _id: cid,
      postId: new ObjectId(),
      authorId: userB,
      body: 'Great!',
      deleted: false,
      createdAt: now,
    });
    await db.collection('comment_reactions').insertOne({
      commentId: cid,
      emoji: 'fire',
      userId: userA,
      createdAt: now,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/features?period=30d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalUsers).toBe(4);
    expect(body.stories.users).toBe(1);
    expect(body.stories.adoptionRate).toBe(0.25);
    expect(body.reels.users).toBe(1);
    expect(body.comments.users).toBe(1);
    expect(body.reactions.users).toBe(1);
    expect(body.calls.users).toBe(6);
    expect(body.spaces.spaces).toBe(5);
    expect(body.spaces.activeSpaces).toBe(3);
    expect(body.spaces.members).toBe(14);
    expect(body.adoptionSeries).toHaveLength(30);
  });

  // === Growth & Cohorts Analytics (2) ===

  it('16. Growth endpoint computes daily curve, signupSources, retentionCohorts, viralCoefficient, and projections', async () => {
    const now = new Date();
    await db.collection('share_events').insertMany([
      { contentType: 'post', contentId: 'p1', byUserId: userA, at: now },
      { contentType: 'post', contentId: 'p2', byUserId: userB, at: now },
    ]);
    await db.collection('follow_sources').insertOne({
      followerId: userB,
      followingId: userA,
      source: 'suggestion',
      at: now,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/growth?period=90d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period).toBe('90d');
    expect(body.daily).toHaveLength(90);
    expect(body.signupSources.some((s: any) => s.source === 'referral' && s.count === 1)).toBe(true);
    expect(body.retentionCohorts.length).toBeGreaterThanOrEqual(2);
    expect(body.viralCoefficient).toBe(0.75); // (2 shares + 1 suggestion follow) / 4 profiles
    expect(body.projectedGrowth['30d']).toBeGreaterThanOrEqual(4);
    expect(body.projectedGrowth['90d']).toBeGreaterThanOrEqual(body.projectedGrowth['60d']);
  });

  // === Live Counters (3) ===

  it('17. Live endpoint reads onlineUsers, activeConversations, activeCalls, messagesLastMinute, and signupsLastHour from Redis', async () => {
    const now = Date.now();
    await redis.set('live:online_users', '17');
    await redis.set('live:active_calls', '4');
    await redis.zadd('live:active_conversations', String(now), 'conv-1', String(now - 5000), 'conv-2');
    await redis.zadd('live:messages_last_minute', String(now), 'm-1', String(now - 1000), 'm-2', String(now - 2000), 'm-3');
    await redis.zadd('live:signups_last_hour', String(now), 'u-1');

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/live',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.onlineUsers).toBe(17);
    expect(body.activeCalls).toBe(4);
    expect(body.activeConversations).toBe(2);
    expect(body.messagesLastMinute).toBe(3);
    expect(body.signupsLastHour).toBe(1);
    expect(typeof body.timestamp).toBe('string');
  });

  it('18. Live endpoint prunes expired rolling sorted-set entries and clamps negative counters to 0', async () => {
    const now = Date.now();
    await redis.set('live:online_users', '-5');
    await redis.set('live:active_calls', '-2');
    await redis.zadd(
      'live:messages_last_minute',
      String(now - 120_000),
      'old-msg',
      String(now - 10_000),
      'fresh-msg'
    );
    await redis.zadd(
      'live:active_conversations',
      String(now - 600_000),
      'old-conv',
      String(now - 20_000),
      'fresh-conv'
    );
    await redis.zadd(
      'live:signups_last_hour',
      String(now - 7_200_000),
      'old-user',
      String(now - 30_000),
      'fresh-user'
    );

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/live',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.onlineUsers).toBe(0);
    expect(body.activeCalls).toBe(0);
    expect(body.messagesLastMinute).toBe(1);
    expect(body.activeConversations).toBe(1);
    expect(body.signupsLastHour).toBe(1);
  });

  // === Empty DB sanity across remaining endpoints (2) ===

  it('19. Empty collection state returns valid zeroed schemas across moderation, chat, features, and content', async () => {
    await db.collection('profiles').deleteMany({ userId: { $ne: adminId } });

    const [contentRes, modRes, featRes, growthRes] = await Promise.all([
      app.inject({ method: 'GET', url: '/admin/analytics/content', headers: { authorization: `Bearer ${tokenAdmin}` } }),
      app.inject({ method: 'GET', url: '/admin/analytics/moderation', headers: { authorization: `Bearer ${tokenAdmin}` } }),
      app.inject({ method: 'GET', url: '/admin/analytics/features', headers: { authorization: `Bearer ${tokenAdmin}` } }),
      app.inject({ method: 'GET', url: '/admin/analytics/growth', headers: { authorization: `Bearer ${tokenAdmin}` } }),
    ]);

    expect(contentRes.statusCode).toBe(200);
    expect(contentRes.json().posts.avgEngagementRate).toBe(0);
    expect(modRes.statusCode).toBe(200);
    expect(modRes.json().reports.avgResolutionTimeHours).toBe(0);
    expect(featRes.statusCode).toBe(200);
    expect(featRes.json().stories.adoptionRate).toBe(0);
    expect(growthRes.statusCode).toBe(200);
    expect(growthRes.json().viralCoefficient).toBe(0);
  });

  it('20. Overview timeline seamlessly combines rolled-up platform_daily_stats with today live data', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const yKey = yesterday.toISOString().slice(0, 10);
    const todayKey = new Date().toISOString().slice(0, 10);

    await db.collection('platform_daily_stats').insertOne({
      date: yKey,
      users: { total: 3, new: 1, dau: 12, wau: 20, mau: 30, banned: 0, verified: 1 },
      content: { postsCreated: 9, reelsCreated: 4, storiesCreated: 2, totalLikes: 15, totalComments: 3, totalShares: 1, totalSaves: 2 },
      chat: { messagesSent: 45, conversationsActive: 5, callsMade: 2, callMinutes: 8 },
      moderation: { reportsCreated: 0, reportsResolved: 0, usersBanned: 0, avgResolutionTimeHours: 0 },
      updatedAt: yesterday,
    });
    await db.collection('posts').insertOne({
      authorId: userA,
      body: 'Today live post',
      likeCount: 0,
      commentCount: 0,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/overview?period=7d',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const timeline = res.json().timeline as Array<any>;
    const yRow = timeline.find((t) => t.date === yKey);
    const todayRow = timeline.find((t) => t.date === todayKey);
    expect(yRow.users.active).toBe(12);
    expect(yRow.content.posts).toBe(9);
    expect(todayRow.content.posts).toBe(1);
  });
});
