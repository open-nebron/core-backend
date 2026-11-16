import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { jwksService } from '../../src/auth/jwks.js';
import { profileService } from '../../src/modules/profiles/profile.service.js';
import * as mongoDb from '../../src/db/mongo.js';
import * as redisDb from '../../src/db/redis.js';
import * as r2Module from '../../src/lib/r2.js';
import { createMockAccessToken, getOrCreateTestAuthKeys } from '../mocks/jwt.mock.js';
import { env } from '../../src/config/env.js';

describe('Media Uploads and User Preferences API', () => {
  let app: FastifyInstance;
  let validToken: string;
  const mockUserId = 'usr_media_test_1';
  const mockEmail = 'media.user@zenuxs.io';

  const initialProfile: mongoDb.ProfileDocument = {
    userId: mockUserId,
    username: 'media_user',
    name: 'Media User',
    dateOfBirth: '1995-01-01',
    about: 'Initial about text',
    bio: 'Initial bio',
    language: 'en',
    theme: 'system',
    avatarKey: null,
    bannerKey: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeAll(async () => {
    // 1. Setup mock JWKS
    const { jwks } = await getOrCreateTestAuthKeys();
    jwksService.setLocalJwks(jwks);

    // 2. Generate token
    validToken = await createMockAccessToken({
      sub: mockUserId,
      email: mockEmail,
      sessionId: 'sess_media_1',
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
    };
    vi.spyOn(redisDb, 'getRedisClient').mockReturnValue(mockRedis as any);

    // 4. Default profile lookup
    vi.spyOn(profileService, 'getProfileByUserId').mockResolvedValue({ ...initialProfile });

    // 5. Build app
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /meta', () => {
    it('is publicly accessible without authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/meta',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.languages)).toBe(true);
      expect(json.languages.some((l: any) => l.code === 'en')).toBe(true);
      expect(json.themes).toEqual(['light', 'dark', 'system']);
      expect(json.defaultLanguage).toBe('en');
      expect(json.limits).toEqual({
        avatarMaxBytes: 5242880,
        bannerMaxBytes: 10485760,
        bioMaxChars: 300,
        aboutMaxChars: 2000,
        nameMaxChars: 80,
      });
      expect(json.acceptedImageTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
      expect(res.headers['cache-control']).toBe('public, max-age=3600');
    });
  });

  describe('POST /me/avatar/upload-url & /me/banner/upload-url', () => {
    it('returns a presigned POST slot with a key prefixed by the caller userId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/me/avatar/upload-url',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          contentType: 'image/jpeg',
          contentLength: 1024 * 500, // 500 KB
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.objectKey).toMatch(new RegExp(`^users/${mockUserId}/avatar/[a-f0-9-]+\\.jpg$`));
      expect(json.uploadUrl).toBeDefined();
      expect(json.fields).toBeDefined();
      expect(json.maxBytes).toBe(5242880);
      expect(json.expiresAt).toBeDefined();
    });

    it('returns 400 for content types outside the whitelist (e.g. image/gif)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/me/avatar/upload-url',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          contentType: 'image/gif',
          contentLength: 1024,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('validation_error');
    });

    it('returns 400 when avatar contentLength exceeds 5 MB limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/me/avatar/upload-url',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          contentType: 'image/png',
          contentLength: env.MAX_AVATAR_BYTES + 1,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.message).toContain('Content length exceeds maximum allowed avatar size');
    });

    it('returns 400 when banner contentLength exceeds 10 MB limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/me/banner/upload-url',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          contentType: 'image/png',
          contentLength: env.MAX_BANNER_BYTES + 1,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.message).toContain('Content length exceeds maximum allowed banner size');
    });
  });

  describe('POST /me/avatar/confirm & /me/banner/confirm', () => {
    it('returns 403 Forbidden when objectKey belongs to a DIFFERENT user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/me/avatar/confirm',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          objectKey: 'users/other_user_999/avatar/test.jpg',
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.error.code).toBe('forbidden');
      expect(json.error.message).toContain('does not belong to the authenticated user');
    });

    it('returns 400 when object does not exist in R2', async () => {
      vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: '/me/avatar/confirm',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          objectKey: `users/${mockUserId}/avatar/nonexistent.jpg`,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('object_not_found');
      expect(json.error.message).toBe('Object does not exist in storage');
    });

    it('saves the key and returns key + public URL on successful confirmation', async () => {
      const targetKey = `users/${mockUserId}/avatar/valid-avatar-123.jpg`;

      vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce({
        contentLength: 1024 * 200,
        contentType: 'image/jpeg',
      });

      const updatedProfile: mongoDb.ProfileDocument = {
        ...initialProfile,
        avatarKey: targetKey,
        updatedAt: new Date('2026-01-01T12:00:00Z'),
      };
      vi.spyOn(profileService, 'updateMediaKey').mockResolvedValueOnce(updatedProfile);

      const res = await app.inject({
        method: 'POST',
        url: '/me/avatar/confirm',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          objectKey: targetKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.key).toBe(targetKey);
      expect(json.url).toContain(targetKey);
    });

    it('attempts deletion of previous key when replaced', async () => {
      const oldKey = `users/${mockUserId}/avatar/old-avatar.jpg`;
      const newKey = `users/${mockUserId}/avatar/new-avatar.jpg`;

      const deleteSpy = vi.spyOn(r2Module, 'deleteObject').mockResolvedValue();

      vi.spyOn(profileService, 'getProfileByUserId').mockResolvedValueOnce({
        ...initialProfile,
        avatarKey: oldKey,
      });

      const mockCollection = {
        findOneAndUpdate: vi.fn().mockResolvedValue({
          ...initialProfile,
          avatarKey: newKey,
          updatedAt: new Date(),
        }),
      };
      vi.spyOn(mongoDb, 'getProfilesCollection').mockReturnValue(mockCollection as any);

      await profileService.updateMediaKey(mockUserId, 'avatar', newKey);
      expect(deleteSpy).toHaveBeenCalledWith(oldKey);
    });
  });

  describe('DELETE /me/avatar and /me/banner', () => {
    it('is idempotent and returns 204 even if no avatar was set', async () => {
      vi.spyOn(profileService, 'updateMediaKey').mockResolvedValueOnce({
        ...initialProfile,
        avatarKey: null,
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/me/avatar',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.payload).toBe('');
    });
  });

  describe('PATCH /me preferences and validation', () => {
    it('rejects unknown language', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          language: 'xx',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('validation_error');
      expect(json.error.message).toContain('Unsupported language');
    });

    it('accepts valid language and persists normalized', async () => {
      vi.spyOn(profileService, 'updateProfile').mockResolvedValueOnce({
        ...initialProfile,
        language: 'hi',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          language: 'hi',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().language).toBe('hi');
    });

    it('rejects unknown theme (e.g. neon)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          theme: 'neon',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('validation_error');
    });

    it('rejects about exceeding 2000 chars', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          about: 'a'.repeat(2001),
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.message).toContain('2000 characters');
    });

    it('rejects about containing HTML tags', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          about: 'Hello <script>alert(1)</script>',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.message).toContain('HTML tags are not allowed');
    });

    it('rejects bio exceeding 300 chars', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          bio: 'b'.repeat(301),
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.message).toContain('300 characters');
    });

    it('accepts valid update with about, bio, language, theme', async () => {
      const updatedDoc: mongoDb.ProfileDocument = {
        ...initialProfile,
        about: 'Valid long about description without tags.',
        bio: 'Valid bio.',
        language: 'ta',
        theme: 'dark',
      };
      vi.spyOn(profileService, 'updateProfile').mockResolvedValueOnce(updatedDoc);

      const res = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          about: 'Valid long about description without tags.',
          bio: 'Valid bio.',
          language: 'ta',
          theme: 'dark',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.about).toBe('Valid long about description without tags.');
      expect(json.bio).toBe('Valid bio.');
      expect(json.language).toBe('ta');
      expect(json.theme).toBe('dark');
    });
  });

  describe('Full Flow Integration: upload-slot -> confirm -> GET /me', () => {
    it('executes full upload, confirm, and retrieval lifecycle', async () => {
      // 1. Request slot
      const slotRes = await app.inject({
        method: 'POST',
        url: '/me/avatar/upload-url',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          contentType: 'image/png',
          contentLength: 1024 * 100,
        },
      });
      expect(slotRes.statusCode).toBe(200);
      const slot = slotRes.json();
      const generatedKey = slot.objectKey;

      // 2. Mock R2 HeadObject as if user completed multipart upload
      vi.spyOn(r2Module, 'headObject').mockResolvedValueOnce({
        contentLength: 1024 * 100,
        contentType: 'image/png',
      });

      // 3. Confirm slot
      const profileWithAvatar: mongoDb.ProfileDocument = {
        ...initialProfile,
        avatarKey: generatedKey,
        updatedAt: new Date(),
      };
      vi.spyOn(profileService, 'updateMediaKey').mockResolvedValueOnce(profileWithAvatar);

      const confirmRes = await app.inject({
        method: 'POST',
        url: '/me/avatar/confirm',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        payload: {
          objectKey: generatedKey,
        },
      });
      expect(confirmRes.statusCode).toBe(200);
      expect(confirmRes.json().key).toBe(generatedKey);

      // 4. Call GET /me and check avatarUrl
      vi.spyOn(profileService, 'getProfileByUserId').mockResolvedValueOnce(profileWithAvatar);
      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });
      expect(meRes.statusCode).toBe(200);
      const me = meRes.json();
      expect(me.avatarUrl).toContain(generatedKey);
    });
  });
});
