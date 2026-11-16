import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { jwksService } from '../../src/auth/jwks.js';
import { profileService } from '../../src/modules/profiles/profile.service.js';
import * as mongoDb from '../../src/db/mongo.js';
import * as redisDb from '../../src/db/redis.js';
import { createMockAccessToken, getOrCreateTestAuthKeys } from '../mocks/jwt.mock.js';

describe('Profile and Health API Routes', () => {
  let app: FastifyInstance;
  let validToken: string;
  const mockUserId = 'usr_neo_123';
  const mockEmail = 'neo@matrix.org';

  beforeAll(async () => {
    // 1. Setup mock JWKS
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    // 2. Generate valid token
    validToken = await createMockAccessToken({
      sub: mockUserId,
      email: mockEmail,
      sessionId: 'sess_1',
    });

    // 3. Mock DB health checks and Redis for rate limiter
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

    // 4. Build app
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health & GET /internal/health', () => {
    it('GET /health returns 200 with all components ok', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toEqual({
        status: 'ok',
        mongo: 'ok',
        redis: 'ok',
        jwks: 'ok',
      });
    });

    it('GET /internal/health returns JWKS debug info and age', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/health',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe('ok');
      expect(json.jwks).toBeDefined();
      expect(json.jwks.isLoaded).toBe(true);
      expect(typeof json.jwks.ageSeconds).toBe('number');
      expect(json.jwks.keyCount).toBeGreaterThan(0);
    });
  });

  describe('GET /me', () => {
    it('returns 401 invalid_token when Authorization header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/me',
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe('invalid_token');
    });

    it('returns 401 when Authorization header does not start with Bearer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: {
          authorization: 'Basic dXNlcjpwYXNz',
        },
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe('invalid_token');
    });

    it('returns 404 profile_not_found when profile does not exist (event lag)', async () => {
      vi.spyOn(profileService, 'getProfileByUserId').mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe('profile_not_found');
      expect(json.error.message).toBe('Profile not found');
    });

    it('returns 200 and profile data when profile exists', async () => {
      const now = new Date('2026-01-01T00:00:00Z');
      vi.spyOn(profileService, 'getProfileByUserId').mockResolvedValueOnce({
        userId: mockUserId,
        username: 'the_one',
        name: 'Thomas Anderson',
        dateOfBirth: new Date('1990-03-11'),
        about: null,
        bio: 'There is no spoon.',
        language: 'en',
        theme: 'system',
        avatarKey: null,
        bannerKey: null,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toEqual({
        userId: mockUserId,
        username: 'the_one',
        name: 'Thomas Anderson',
        dateOfBirth: '1990-03-11',
        about: null,
        bio: 'There is no spoon.',
        language: 'en',
        theme: 'system',
        avatarUrl: null,
        bannerUrl: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    });
  });

  describe('PATCH /me', () => {
    it('returns 400 when body is empty', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('validation_error');
    });

    it('rejects dateOfBirth implying age < 13', async () => {
      const today = new Date();
      const tenYearsAgo = new Date(
        Date.UTC(today.getUTCFullYear() - 10, today.getUTCMonth(), today.getUTCDate())
      ).toISOString().split('T')[0];

      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          dateOfBirth: tenYearsAgo,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('validation_error');
      expect(json.error.message).toContain('at least 13 years old');
    });

    it('updates allowed profile fields successfully', async () => {
      const now = new Date('2026-01-01T00:00:00Z');
      vi.spyOn(profileService, 'updateProfile').mockResolvedValueOnce({
        userId: mockUserId,
        username: 'the_one',
        name: 'Neo',
        dateOfBirth: new Date('1995-05-15'),
        bio: 'I know Kung Fu.',
        profilePicUrl: null,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          name: 'Neo',
          dateOfBirth: '1995-05-15',
          bio: 'I know Kung Fu.',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.name).toBe('Neo');
      expect(json.bio).toBe('I know Kung Fu.');
      expect(json.dateOfBirth).toBe('1995-05-15');
    });
  });

  describe('GET /username/check', () => {
    it('returns available: true when username is free and valid', async () => {
      vi.spyOn(profileService, 'isUsernameTaken').mockResolvedValueOnce(false);

      const res = await app.inject({
        method: 'GET',
        url: '/username/check?username=available_user',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true });
    });

    it('returns available: false, reason: "reserved" for reserved username', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/username/check?username=admin',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: false, reason: 'reserved' });
    });

    it('returns available: false, reason: "invalid_format" for malformed username', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/username/check?username=123bad',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: false, reason: 'invalid_format' });
    });

    it('returns available: false, reason: "taken" when username already exists in DB', async () => {
      vi.spyOn(profileService, 'isUsernameTaken').mockResolvedValueOnce(true);

      const res = await app.inject({
        method: 'GET',
        url: '/username/check?username=taken_user',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: false, reason: 'taken' });
    });

    it('returns 429 rate_limit_exceeded when exceeding 20 requests per minute', async () => {
      const rateLimitPipeline = {
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 21], [null, 1]]), // count 21 > 20
      };
      const rateLimitRedis = {
        pipeline: vi.fn(() => rateLimitPipeline),
      };
      vi.spyOn(redisDb, 'getRedisClient').mockReturnValueOnce(rateLimitRedis as any);

      const res = await app.inject({
        method: 'GET',
        url: '/username/check?username=flooder',
      });

      expect(res.statusCode).toBe(429);
      const json = res.json();
      expect(json.error.code).toBe('rate_limit_exceeded');
    });
  });

  describe('PATCH /me/username', () => {
    it('returns 400 invalid_username when username format is invalid', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me/username',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          username: 'ab', // < 3 chars
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('invalid_username');
    });

    it('returns 400 invalid_username when username is reserved', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me/username',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          username: 'zenuxs',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('invalid_username');
      expect(json.error.message).toContain('reserved');
    });

    it('returns 409 username_taken when username is already taken by another user', async () => {
      vi.spyOn(profileService, 'getProfileByUsername').mockResolvedValueOnce({
        userId: 'usr_other_person',
        username: 'existing_name',
        name: null,
        dateOfBirth: null,
        bio: null,
        profilePicUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/me/username',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          username: 'existing_name',
        },
      });

      expect(res.statusCode).toBe(409);
      const json = res.json();
      expect(json.error.code).toBe('username_taken');
      expect(json.error.message).toBe('Username is already taken');
    });

    it('successfully updates username when valid and available', async () => {
      vi.spyOn(profileService, 'updateUsername').mockResolvedValueOnce({
        username: 'my_new_handle',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/me/username',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          username: 'my_new_handle',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ username: 'my_new_handle' });
    });
  });
});
