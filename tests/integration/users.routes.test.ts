import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { jwksService } from '../../src/auth/jwks.js';
import * as mongoDb from '../../src/db/mongo.js';
import * as redisDb from '../../src/db/redis.js';
import { createMockAccessToken, getOrCreateTestAuthKeys } from '../mocks/jwt.mock.js';

describe('Users API Routes (/users)', () => {
  let app: FastifyInstance;
  let validToken: string;
  const mockCallerId = 'usr_caller_1';
  const mockEmail = 'caller@nebron.com';

  const mockUsers = [
    {
      userId: 'usr_target_1',
      username: 'alice',
      name: 'Alice Springs',
      avatarKey: 'users/usr_target_1/avatar/a.jpg',
      bannerKey: 'users/usr_target_1/banner/b.jpg',
      bio: 'Alice bio',
      about: 'About Alice',
      followerCount: 9,
      followingCount: 4,
      postCount: 3,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      userId: 'usr_target_2',
      username: 'alicia',
      name: 'Bob Alicia',
      avatarKey: null,
      bannerKey: null,
      bio: null,
      about: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    },
  ];

  beforeAll(async () => {
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    validToken = await createMockAccessToken({
      sub: mockCallerId,
      email: mockEmail,
      sessionId: 'sess_user_1',
    });

    vi.spyOn(mongoDb, 'isMongoHealthy').mockResolvedValue(true);
    vi.spyOn(redisDb, 'isRedisHealthy').mockResolvedValue(true);

    const mockPipeline = {
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 1], [null, 1]]),
    };
    const mockRedis = {
      pipeline: vi.fn(() => mockPipeline),
    };
    vi.spyOn(redisDb, 'getRedisClient').mockReturnValue(mockRedis as any);

    const mockCollection = {
      find: vi.fn((query: any) => {
        const regex: RegExp = query?.$or?.[0]?.username?.$regex;
        const filtered = mockUsers.filter(
          (u) => (regex && regex.test(u.username)) || (regex && regex.test(u.name))
        );
        return {
          limit: vi.fn((_n: number) => ({
            toArray: vi.fn().mockResolvedValue(filtered),
          })),
        };
      }),
      findOne: vi.fn((query: any) => {
        if (query.username) {
          const user = mockUsers.find((u) => u.username === query.username);
          return Promise.resolve(user || null);
        }
        if (query.userId) {
          const user = mockUsers.find((u) => u.userId === query.userId);
          return Promise.resolve(user || null);
        }
        return Promise.resolve(null);
      }),
    };
    vi.spyOn(mongoDb, 'getProfilesCollection').mockReturnValue(mockCollection as any);

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /users/search', () => {
    it('returns 401 when token is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/search?q=al',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns matched users by username/name prefix', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/search?q=al&limit=10',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.users)).toBe(true);
      expect(json.users.length).toBe(2);
      expect(json.users[0].username).toBe('alice');
      expect(json.users[0].userId).toBe('usr_target_1');
      expect(json.users[0]).not.toHaveProperty('email');
      expect(json.users[0]).not.toHaveProperty('bio');
    });

    it('matches substring in user name or username', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/search?q=springs&limit=10',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.users.length).toBe(1);
      expect(json.users[0].username).toBe('alice');
    });

    it('returns 400 when q is missing or invalid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/search',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /users/by-username/:username', () => {
    it('returns public summary when user exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/by-username/alice',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.userId).toBe('usr_target_1');
      expect(json.username).toBe('alice');
      expect(json.name).toBe('Alice Springs');
      expect(json.bio).toBe('Alice bio');
      expect(json.followerCount).toBe(9);
      expect(json.followingCount).toBe(4);
      expect(json.postCount).toBe(3);
      expect(json).not.toHaveProperty('email');
    });

    it('returns 404 when username does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/by-username/nonexistent_user',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /users/:userId', () => {
    it('returns public profile when userId exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/usr_target_1',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.userId).toBe('usr_target_1');
      expect(json.username).toBe('alice');
      expect(json.bio).toBe('Alice bio');
      expect(json.about).toBe('About Alice');
      expect(json.followerCount).toBe(9);
      expect(json.followingCount).toBe(4);
      expect(json.postCount).toBe(3);
      expect(json.createdAt).toBeDefined();
      expect(json.messageRequestPolicy).toBe('known');
      expect(json).not.toHaveProperty('email');
      expect(json).not.toHaveProperty('dateOfBirth');
    });

    it('returns public profile when authenticated via x-internal-token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/usr_target_1',
        headers: { 'x-internal-token': 'dev-internal-token' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.userId).toBe('usr_target_1');
      expect(json.messageRequestPolicy).toBe('known');
    });

    it('returns 404 when userId does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/users/usr_missing',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
