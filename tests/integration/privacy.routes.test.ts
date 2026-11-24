import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { jwksService } from '../../src/auth/jwks.js';
import * as mongoDb from '../../src/db/mongo.js';
import * as redisDb from '../../src/db/redis.js';
import { createMockAccessToken, getOrCreateTestAuthKeys } from '../mocks/jwt.mock.js';

describe('Privacy Settings and Visibility API Routes', () => {
  let app: FastifyInstance;
  let user1Token: string;
  let user2Token: string;
  const user1Id = 'usr_privacy_1';
  const user2Id = 'usr_privacy_2';

  // In-memory profiles store for fast, reliable unit testing
  const profilesStore: Record<string, any> = {
    [user1Id]: {
      userId: user1Id,
      username: 'privacy_user1',
      name: 'Privacy User 1',
      dateOfBirth: null,
      about: null,
      bio: null,
      language: 'en',
      theme: 'system',
      avatarKey: null,
      bannerKey: null,
      online: true,
      lastSeenAt: new Date('2026-11-24T12:00:00Z'),
      privacy: {
        showOnlineStatus: 'everyone',
        showLastSeen: 'contacts',
        sendReadReceipts: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    [user2Id]: {
      userId: user2Id,
      username: 'privacy_user2',
      name: 'Privacy User 2',
      dateOfBirth: null,
      about: null,
      bio: null,
      language: 'en',
      theme: 'system',
      avatarKey: null,
      bannerKey: null,
      online: true,
      lastSeenAt: new Date('2026-11-24T12:00:00Z'),
      privacy: {
        showOnlineStatus: 'everyone',
        showLastSeen: 'contacts',
        sendReadReceipts: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };

  beforeAll(async () => {
    // 1. Setup mock JWKS
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    // 2. Generate valid tokens
    user1Token = await createMockAccessToken({
      sub: user1Id,
      email: 'user1@nebron.test',
      sessionId: 'sess_1',
    });

    user2Token = await createMockAccessToken({
      sub: user2Id,
      email: 'user2@nebron.test',
      sessionId: 'sess_2',
    });

    // 3. Mock DB and Redis
    vi.spyOn(mongoDb, 'isMongoHealthy').mockResolvedValue(true);
    vi.spyOn(redisDb, 'isRedisHealthy').mockResolvedValue(true);

    const mockPipeline = {
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 1], [null, 1]]),
    };
    const mockRedis = {
      pipeline: vi.fn(() => mockPipeline),
      del: vi.fn().mockResolvedValue(1),
    };
    vi.spyOn(redisDb, 'getRedisClient').mockReturnValue(mockRedis as any);

    const mockCollection = {
      findOne: vi.fn(async (query: any) => {
        if (query.userId) {
          const doc = profilesStore[query.userId];
          return doc ? { ...doc } : null;
        }
        return null;
      }),
      updateOne: vi.fn(async (filter: any, update: any) => {
        const userId = filter.userId;
        if (profilesStore[userId] && update.$set) {
          Object.assign(profilesStore[userId], update.$set);
        }
        return { modifiedCount: 1 };
      }),
    };
    vi.spyOn(mongoDb, 'getProfilesCollection').mockReturnValue(mockCollection as any);

    // 4. Build app
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Read privacy
  it('GET /me/privacy returns current user privacy settings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/privacy',
      headers: {
        authorization: `Bearer ${user1Token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      showOnlineStatus: 'everyone',
      showLastSeen: 'contacts',
      sendReadReceipts: true,
    });
  });

  // 2. Update privacy persists
  it('PATCH /me/privacy persists updated privacy settings', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/me/privacy',
      headers: {
        authorization: `Bearer ${user1Token}`,
        'content-type': 'application/json',
      },
      payload: {
        showOnlineStatus: 'nobody',
        showLastSeen: 'nobody',
        sendReadReceipts: false,
      },
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual({
      showOnlineStatus: 'nobody',
      showLastSeen: 'nobody',
      sendReadReceipts: false,
    });

    // Verify persisted via GET /me/privacy
    const getRes = await app.inject({
      method: 'GET',
      url: '/me/privacy',
      headers: {
        authorization: `Bearer ${user1Token}`,
      },
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({
      showOnlineStatus: 'nobody',
      showLastSeen: 'nobody',
      sendReadReceipts: false,
    });
  });

  // 3. GET /users/:id respects showOnlineStatus = 'nobody'
  it('GET /users/:id respects showOnlineStatus = "nobody" by omitting online', async () => {
    // user2 views user1 (who has showOnlineStatus = 'nobody')
    const res = await app.inject({
      method: 'GET',
      url: `/users/${user1Id}`,
      headers: {
        authorization: `Bearer ${user2Token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(user1Id);
    expect(body.online).toBeUndefined();
  });

  // 4. GET /users/:id respects showLastSeen = 'nobody'
  it('GET /users/:id respects showLastSeen = "nobody" by omitting lastSeenAt', async () => {
    // user2 views user1 (who has showLastSeen = 'nobody')
    const res = await app.inject({
      method: 'GET',
      url: `/users/${user1Id}`,
      headers: {
        authorization: `Bearer ${user2Token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(user1Id);
    expect(body.lastSeenAt).toBeUndefined();
  });

  // 5. 'contacts' treated as 'everyone' for now (documented TODO)
  it('GET /users/:id treats "contacts" as "everyone" for now and includes online/lastSeenAt', async () => {
    // Update user1 privacy to 'contacts' for both
    await app.inject({
      method: 'PATCH',
      url: '/me/privacy',
      headers: {
        authorization: `Bearer ${user1Token}`,
        'content-type': 'application/json',
      },
      payload: {
        showOnlineStatus: 'contacts',
        showLastSeen: 'contacts',
      },
    });

    // user2 views user1 -> treated as everyone for now -> online and lastSeenAt are included
    const res = await app.inject({
      method: 'GET',
      url: `/users/${user1Id}`,
      headers: {
        authorization: `Bearer ${user2Token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(user1Id);
    expect(body.online).toBe(true);
    expect(body.lastSeenAt).toBe('2026-11-24T12:00:00.000Z');
  });
});
