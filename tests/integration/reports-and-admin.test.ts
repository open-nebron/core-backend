import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import * as mongoDb from '../../src/db/mongo.js';
import { getRedisClient } from '../../src/db/redis.js';
import { jwksService } from '../../src/auth/jwks.js';
import { getOrCreateTestAuthKeys, createMockAccessToken } from '../mocks/jwt.mock.js';
import { env } from '../../src/config/env.js';

describe('Reports and Admin Moderation Module', () => {
  let app: FastifyInstance;
  let client: MongoClient;
  let db: Db;
  let dbName: string;
  let redis: Redis;

  const superAdminId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const userC = crypto.randomUUID();

  let tokenSuperAdmin: string;
  let tokenAdmin: string;
  let tokenUserA: string;
  let tokenUserB: string;
  let tokenUserC: string;

  let post1Id: ObjectId;
  let comment1Id: ObjectId;

  beforeAll(async () => {
    await mongoDb.closeMongo();
    dbName = `test_reports_admin_${crypto.randomUUID().replace(/-/g, '')}`;
    const mongoUrl = `mongodb://localhost:27017/${dbName}`;
    const conn = await mongoDb.connectMongo(mongoUrl);
    client = conn.client;
    db = conn.db;

    redis = getRedisClient();
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    tokenSuperAdmin = await createMockAccessToken({ sub: superAdminId, email: 'super@nebron.io' });
    tokenAdmin = await createMockAccessToken({ sub: adminId, email: 'admin@nebron.io' });
    tokenUserA = await createMockAccessToken({ sub: userA, email: 'usera@nebron.io' });
    tokenUserB = await createMockAccessToken({ sub: userB, email: 'userb@nebron.io' });
    tokenUserC = await createMockAccessToken({ sub: userC, email: 'userc@nebron.io' });

    // Seed profiles
    const profiles = db.collection('profiles');
    await profiles.insertMany([
      {
        userId: superAdminId,
        username: 'superadmin',
        name: 'Super Admin',
        email: 'super@nebron.io',
        isAdmin: true,
        isBanned: false,
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        userId: adminId,
        username: 'regularadmin',
        name: 'Regular Admin',
        email: 'admin@nebron.io',
        isAdmin: true,
        isBanned: false,
        createdAt: new Date('2025-02-01T00:00:00Z'),
        updatedAt: new Date('2025-02-01T00:00:00Z'),
      },
      {
        userId: userA,
        username: 'alice',
        name: 'Alice Reporter',
        email: 'usera@nebron.io',
        isAdmin: false,
        isBanned: false,
        createdAt: new Date('2025-03-01T00:00:00Z'),
        updatedAt: new Date('2025-03-01T00:00:00Z'),
      },
      {
        userId: userB,
        username: 'bob',
        name: 'Bob Offender',
        email: 'userb@nebron.io',
        isAdmin: false,
        isBanned: false,
        createdAt: new Date('2025-03-02T00:00:00Z'),
        updatedAt: new Date('2025-03-02T00:00:00Z'),
      },
      {
        userId: userC,
        username: 'charlie',
        name: 'Charlie Candidate',
        email: 'userc@nebron.io',
        isAdmin: false,
        isBanned: false,
        createdAt: new Date('2025-03-03T00:00:00Z'),
        updatedAt: new Date('2025-03-03T00:00:00Z'),
      },
    ]);

    // Seed post by userB
    const posts = db.collection('posts');
    const postRes = await posts.insertOne({
      authorId: userB,
      body: 'Spam post by Bob',
      imageKey: null,
      imageUrl: null,
      likeCount: 0,
      commentCount: 1,
      deleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    post1Id = postRes.insertedId;

    // Seed comment by userB
    const comments = db.collection('comments');
    const commentRes = await comments.insertOne({
      postId: post1Id,
      authorId: userB,
      body: 'Spam comment by Bob',
      deleted: false,
      createdAt: new Date(),
    });
    comment1Id = commentRes.insertedId;

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // Clean up Redis keys
    await redis.del(`user:banned:${userA}`);
    await redis.del(`user:banned:${userB}`);
    await redis.del(`user:banned:${userC}`);
    await redis.del(`user:banned:${adminId}`);
    await redis.del(`user:banned:${superAdminId}`);

    const keys = await redis.keys('rate_limit:reports:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    await app.close();
    if (client) {
      await db.dropDatabase();
      await mongoDb.closeMongo();
    }
  });

  describe('User-facing Reports (POST /reports)', () => {
    it('rejects self-report when targetType is user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'user',
          targetId: userA,
          reason: 'spam',
          details: 'Reporting myself',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('cannot_report_self');
    });

    it('rejects self-report when reporting own post', async () => {
      // Create post by userA
      const postA = await db.collection('posts').insertOne({
        authorId: userA,
        body: 'Post by Alice',
        imageKey: null,
        imageUrl: null,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'post',
          targetId: postA.insertedId.toString(),
          reason: 'harassment',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('cannot_report_self');
    });

    it('rejects reporting non-existent post', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'post',
          targetId: new ObjectId().toString(),
          reason: 'spam',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('post_not_found');
    });

    it('successfully creates report against Bob post', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'post',
          targetId: post1Id.toString(),
          reason: 'spam',
          details: 'This is unwanted commercial spam',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.reportId).toBeDefined();
      expect(json.status).toBe('pending');

      const inDb = await db.collection('reports').findOne({ _id: new ObjectId(json.reportId) });
      expect(inDb).not.toBeNull();
      expect(inDb?.reporterId).toBe(userA);
      expect(inDb?.targetOwnerId).toBe(userB);
    });

    it('rejects duplicate report within 24h with 429 already_reported', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'post',
          targetId: post1Id.toString(),
          reason: 'harassment',
        },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('already_reported');
    });

    it('successfully creates report against Bob user and comment', async () => {
      const userReport = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'user',
          targetId: userB,
          reason: 'hate',
          details: 'Hate speech user profile',
        },
      });
      expect(userReport.statusCode).toBe(201);

      const commentReport = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
        payload: {
          targetType: 'comment',
          targetId: comment1Id.toString(),
          reason: 'harassment',
          details: 'Harassing comment',
        },
      });
      expect(commentReport.statusCode).toBe(201);
    });

    it('enforces 10 reports per day rate limit', async () => {
      const rateLimitUser = crypto.randomUUID();
      const tokenRateLimitUser = await createMockAccessToken({
        sub: rateLimitUser,
        email: 'ratelimit@nebron.io',
      });

      await db.collection('profiles').insertOne({
        userId: rateLimitUser,
        username: 'ratelimit_user',
        name: 'Rate Limit Tester',
        email: 'ratelimit@nebron.io',
        isAdmin: false,
        isBanned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      for (let i = 0; i < 10; i++) {
        const dummyUser = crypto.randomUUID();
        await db.collection('profiles').insertOne({
          userId: dummyUser,
          username: `dummy_${i}_${Date.now()}`,
          name: 'Dummy',
          isAdmin: false,
          isBanned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const r = await app.inject({
          method: 'POST',
          url: '/reports',
          headers: { authorization: `Bearer ${tokenRateLimitUser}` },
          payload: {
            targetType: 'user',
            targetId: dummyUser,
            reason: 'other',
          },
        });
        expect(r.statusCode).toBe(201);
      }

      // 11th report must fail
      const extraUser = crypto.randomUUID();
      await db.collection('profiles').insertOne({
        userId: extraUser,
        username: `extra_${Date.now()}`,
        name: 'Extra',
        isAdmin: false,
        isBanned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const blockedRes = await app.inject({
        method: 'POST',
        url: '/reports',
        headers: { authorization: `Bearer ${tokenRateLimitUser}` },
        payload: {
          targetType: 'user',
          targetId: extraUser,
          reason: 'other',
        },
      });

      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.json().error.code).toBe('rate_limit_exceeded');
    });
  });

  describe('Admin Reports Queue (GET & POST /admin/reports)', () => {
    let testReportId: string;

    it('rejects non-admin access with 403 not_admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports',
        headers: { authorization: `Bearer ${tokenUserA}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_admin');
    });

    it('admin receives list of reports enriched with reporter and targetOwner profiles', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports?limit=10',
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.reports)).toBe(true);
      expect(json.reports.length).toBeGreaterThan(0);

      const first = json.reports[0];
      expect(first.reporter).toBeDefined();
      expect(first.reporter.username).toBeDefined();
      expect(first.targetOwner).toBeDefined();

      testReportId = first.id;
    });

    it('admin filters reports by targetType and status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/reports?targetType=post&status=pending',
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      for (const r of json.reports) {
        expect(r.targetType).toBe('post');
        expect(r.status).toBe('pending');
      }
    });

    it('admin fetches single report detail with inline target content', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reports/${testReportId}`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.report.id).toBe(testReportId);
      expect(json.report.target).toBeDefined();
    });

    it('admin resolves report with dismiss action', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reports/${testReportId}/resolve`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          action: 'dismiss',
          note: 'Content does not violate policy',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.report.status).toBe('dismissed');
      expect(json.report.resolvedBy).toBe(adminId);
      expect(json.report.resolutionNote).toBe('Content does not violate policy');

      // Check admin action logged
      const actionDoc = await db.collection('admin_actions').findOne({
        action: 'dismiss_report',
        targetId: testReportId,
      });
      expect(actionDoc).not.toBeNull();
    });

    it('admin resolves report with delete_post action', async () => {
      // Find report for post1Id
      const reportPost = await db.collection('reports').findOne({
        targetType: 'post',
        targetId: post1Id.toString(),
      });
      expect(reportPost).not.toBeNull();

      const res = await app.inject({
        method: 'POST',
        url: `/admin/reports/${reportPost?._id.toString()}/resolve`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          action: 'delete_post',
          note: 'Spam post removed',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().report.status).toBe('resolved');

      // Verify post soft-deleted
      const postInDb = await db.collection('posts').findOne({ _id: post1Id });
      expect(postInDb?.deleted).toBe(true);

      // Verify admin action logged
      const actionDoc = await db.collection('admin_actions').findOne({
        action: 'delete_post',
        targetId: post1Id.toString(),
      });
      expect(actionDoc).not.toBeNull();
    });

    it('admin resolves report with delete_comment action', async () => {
      const reportComment = await db.collection('reports').findOne({
        targetType: 'comment',
        targetId: comment1Id.toString(),
      });
      expect(reportComment).not.toBeNull();

      const res = await app.inject({
        method: 'POST',
        url: `/admin/reports/${reportComment?._id.toString()}/resolve`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          action: 'delete_comment',
          note: 'Inappropriate comment removed',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().report.status).toBe('resolved');

      // Verify comment soft-deleted
      const commentInDb = await db.collection('comments').findOne({ _id: comment1Id });
      expect(commentInDb?.deleted).toBe(true);
    });
  });

  describe('User Management and Ban Enforcement', () => {
    it('admin searches users by query string', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users?q=alice',
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.users.length).toBe(1);
      expect(json.users[0].username).toBe('alice');
      expect(json.users[0].reportCount).toBeDefined();
    });

    it('admin cannot ban another administrator', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${superAdminId}/ban`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: { reason: 'Attempting to ban superadmin' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('cannot_ban_admin');
    });

    it('admin bans UserB successfully and sets ban cache', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${userB}/ban`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: { reason: 'Repeated spam violation' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const profile = await db.collection('profiles').findOne({ userId: userB });
      expect(profile?.isBanned).toBe(true);
      expect(profile?.bannedReason).toBe('Repeated spam violation');

      const cached = await redis.get(`user:banned:${userB}`);
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed.banned).toBe(true);
      expect(parsed.reason).toBe('Repeated spam violation');
    });

    it('banned UserB gets 403 account_banned on authenticated requests', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${tokenUserB}` },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.error.code).toBe('account_banned');
      expect(json.error.reason).toBe('Repeated spam violation');
    });

    it('admin unbans UserB and UserB can access endpoints again', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${userB}/unban`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const profile = await db.collection('profiles').findOne({ userId: userB });
      expect(profile?.isBanned).toBe(false);

      const cached = await redis.get(`user:banned:${userB}`);
      expect(cached).toBeNull();

      // Now UserB can access /me again
      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${tokenUserB}` },
      });
      expect(meRes.statusCode).toBe(200);
    });

    it('only super admin can promote user to admin', async () => {
      // Regular admin tries to promote userC -> fails 403
      const regularRes = await app.inject({
        method: 'POST',
        url: `/admin/users/${userC}/promote`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });
      expect(regularRes.statusCode).toBe(403);
      expect(regularRes.json().error.code).toBe('super_admin_only');

      // Super admin promotes userC -> succeeds
      const superRes = await app.inject({
        method: 'POST',
        url: `/admin/users/${userC}/promote`,
        headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      });
      expect(superRes.statusCode).toBe(200);

      const profile = await db.collection('profiles').findOne({ userId: userC });
      expect(profile?.isAdmin).toBe(true);
    });

    it('super admin can demote userC, but cannot demote themselves', async () => {
      // Super admin demotes themselves -> 400
      const selfDemote = await app.inject({
        method: 'POST',
        url: `/admin/users/${superAdminId}/demote`,
        headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      });
      expect(selfDemote.statusCode).toBe(400);

      // Super admin demotes userC -> succeeds
      const demoteRes = await app.inject({
        method: 'POST',
        url: `/admin/users/${userC}/demote`,
        headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      });
      expect(demoteRes.statusCode).toBe(200);

      const profile = await db.collection('profiles').findOne({ userId: userC });
      expect(profile?.isAdmin).toBe(false);
    });

    it('admin fetches user detail with reports, actions, and posts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/users/${userB}`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.profile.userId).toBe(userB);
      expect(Array.isArray(json.reports)).toBe(true);
      expect(Array.isArray(json.actions)).toBe(true);
      expect(Array.isArray(json.recentPosts)).toBe(true);
    });
  });

  describe('Stats & Direct Content Deletion & Ban Status', () => {
    it('admin GET /admin/stats returns aggregate platform statistics', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/stats',
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.users.total).toBeGreaterThan(0);
      expect(json.posts.total).toBeDefined();
      expect(json.reports.pending).toBeDefined();
      expect(json.messages.today).toBeDefined();
      expect(json.calls.today).toBeDefined();
    });

    it('admin DELETE /admin/posts/:id deletes post bypassing author check', async () => {
      const newPost = await db.collection('posts').insertOne({
        authorId: userA,
        body: 'Post to be deleted directly by admin',
        imageKey: null,
        imageUrl: null,
        likeCount: 0,
        commentCount: 0,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/posts/${newPost.insertedId.toString()}`,
        headers: { authorization: `Bearer ${tokenAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const postInDb = await db.collection('posts').findOne({ _id: newPost.insertedId });
      expect(postInDb?.deleted).toBe(true);
    });

    it('GET /internal/users/:userId/ban-status verifies internal token and returns ban status', async () => {
      const unauthRes = await app.inject({
        method: 'GET',
        url: `/internal/users/${userA}/ban-status`,
      });
      expect(unauthRes.statusCode).toBe(403);

      const authRes = await app.inject({
        method: 'GET',
        url: `/internal/users/${userA}/ban-status`,
        headers: { 'x-internal-token': env.INTERNAL_TOKEN },
      });
      expect(authRes.statusCode).toBe(200);
      const json = authRes.json();
      expect(json.userId).toBe(userA);
      expect(json.isBanned).toBe(false);
    });
  });
});
