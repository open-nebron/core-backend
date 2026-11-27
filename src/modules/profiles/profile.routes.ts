import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import {
  checkUsernameRateLimiter,
  confirmUploadRateLimiter,
  deleteMediaRateLimiter,
  patchMeRateLimiter,
  uploadUrlRateLimiter,
} from '../../plugins/rate-limit.js';
import {
  checkUsernameQuerySchema,
  confirmUploadSchema,
  patchMeSchema,
  patchUsernameSchema,
  uploadUrlSchema,
  patchPrivacySchema,
  type CheckUsernameQuery,
  type ConfirmUploadInput,
  type PatchMeInput,
  type PatchUsernameInput,
  type UploadUrlInput,
  type PatchPrivacyInput,
} from './profile.schema.js';
import { formatProfileResponse, profileService } from './profile.service.js';
import { validateUsername } from './username.rules.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import {
  ACCEPTED_IMAGE_TYPES,
  computePublicUrl,
  createPresignedUpload,
  headObject,
  isValidUserKey,
} from '../../lib/r2.js';
import { env, getSupportedLanguages } from '../../config/env.js';
import { capture } from '../../lib/analytics.js';

export const profileRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // GET /meta - Public configuration and limits metadata
  app.get(
    '/meta',
    {
      schema: {
        description: 'Public metadata: supported languages, themes, and media upload limits',
        tags: ['Meta'],
        response: {
          200: {
            type: 'object',
            properties: {
              languages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
              themes: { type: 'array', items: { type: 'string' } },
              defaultLanguage: { type: 'string' },
              limits: {
                type: 'object',
                properties: {
                  avatarMaxBytes: { type: 'number' },
                  bannerMaxBytes: { type: 'number' },
                  bioMaxChars: { type: 'number' },
                  aboutMaxChars: { type: 'number' },
                  nameMaxChars: { type: 'number' },
                },
              },
              acceptedImageTypes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'public, max-age=3600');

      let displayNames: Intl.DisplayNames | null = null;
      try {
        displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
      } catch {
        // Fallback safely if locale data is unavailable
      }

      const languages = getSupportedLanguages().map((code) => {
        let name = code.toUpperCase();
        if (displayNames) {
          try {
            name = displayNames.of(code) || name;
          } catch {
            // Keep uppercase fallback
          }
        }
        return { code, name };
      });

      return reply.status(200).send({
        languages,
        themes: ['light', 'dark', 'system'],
        defaultLanguage: env.DEFAULT_LANGUAGE,
        limits: {
          avatarMaxBytes: env.MAX_AVATAR_BYTES,
          bannerMaxBytes: env.MAX_BANNER_BYTES,
          bioMaxChars: 300,
          aboutMaxChars: 2000,
          nameMaxChars: 80,
        },
        acceptedImageTypes: [...ACCEPTED_IMAGE_TYPES],
      });
    }
  );

  // GET /me - Authenticated user profile
  app.get(
    '/me',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get current user profile',
        tags: ['Profile'],
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              username: { type: 'string' },
              name: { type: 'string', nullable: true },
              dateOfBirth: { type: 'string', nullable: true },
              about: { type: 'string', nullable: true },
              bio: { type: 'string', nullable: true },
              language: { type: 'string' },
              theme: { type: 'string' },
              messageRequestPolicy: { type: 'string', enum: ['everyone', 'known', 'nobody'] },
              avatarUrl: { type: 'string', nullable: true },
              bannerUrl: { type: 'string', nullable: true },
              followerCount: { type: 'integer' },
              followingCount: { type: 'integer' },
              postCount: { type: 'integer' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string', nullable: true },
            },
            required: ['userId', 'username', 'language', 'theme', 'messageRequestPolicy', 'createdAt'],
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user;
      const profile = await profileService.getProfileByUserId(userId);

      if (!profile) {
        request.log.warn({ userId }, 'Profile not found - indicates event consumer lag');
        throw new NotFoundError('Profile not found', 'profile_not_found');
      }

      return reply.status(200).send(formatProfileResponse(profile));
    }
  );

  // PATCH /me - Update current user profile fields & preferences
  app.patch<{ Body: PatchMeInput }>(
    '/me',
    {
      preHandler: [authenticateRequest, patchMeRateLimiter],
      schema: {
        description: 'Update current user profile information and preferences',
        tags: ['Profile'],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            dateOfBirth: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            about: { type: 'string', maxLength: 2000 },
            bio: { type: 'string', maxLength: 300 },
            language: { type: 'string' },
            theme: { type: 'string', enum: ['light', 'dark', 'system'] },
            messageRequestPolicy: { type: 'string', enum: ['everyone', 'known', 'nobody'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const parsedBody = patchMeSchema.parse(request.body);
      const { userId } = request.user;

      const updated = await profileService.updateProfile(userId, parsedBody);
      capture(userId, 'profile_updated');
      return reply.status(200).send(formatProfileResponse(updated));
    }
  );

  // GET /me/privacy - Get current user privacy settings
  app.get(
    '/me/privacy',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get current user privacy settings',
        tags: ['Profile'],
        response: {
          200: {
            type: 'object',
            properties: {
              showOnlineStatus: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
              showLastSeen: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
              sendReadReceipts: { type: 'boolean' },
            },
            required: ['showOnlineStatus', 'showLastSeen', 'sendReadReceipts'],
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user;
      const privacy = await profileService.getPrivacy(userId);
      return reply.status(200).send(privacy);
    }
  );

  // PATCH /me/privacy - Update current user privacy settings
  app.patch<{ Body: PatchPrivacyInput }>(
    '/me/privacy',
    {
      preHandler: [authenticateRequest, patchMeRateLimiter],
      schema: {
        description: 'Update current user privacy settings',
        tags: ['Profile'],
        body: {
          type: 'object',
          properties: {
            showOnlineStatus: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
            showLastSeen: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
            sendReadReceipts: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              showOnlineStatus: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
              showLastSeen: { type: 'string', enum: ['everyone', 'contacts', 'nobody'] },
              sendReadReceipts: { type: 'boolean' },
            },
            required: ['showOnlineStatus', 'showLastSeen', 'sendReadReceipts'],
          },
        },
      },
    },
    async (request, reply) => {
      const parsedBody = patchPrivacySchema.parse(request.body);
      const { userId } = request.user;
      const updated = await profileService.updatePrivacy(userId, parsedBody);
      return reply.status(200).send(updated);
    }
  );

  // POST /me/avatar/upload-url - Presigned upload slot for avatar
  app.post<{ Body: UploadUrlInput }>(
    '/me/avatar/upload-url',
    {
      preHandler: [authenticateRequest, uploadUrlRateLimiter],
      schema: {
        description: 'Request a presigned POST slot for avatar upload',
        tags: ['Media'],
        body: {
          type: 'object',
          required: ['contentType', 'contentLength'],
          properties: {
            contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
            contentLength: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const { contentType, contentLength } = uploadUrlSchema.parse(request.body);

      if (contentLength > env.MAX_AVATAR_BYTES) {
        throw new BadRequestError(
          `Content length exceeds maximum allowed avatar size of ${env.MAX_AVATAR_BYTES} bytes`
        );
      }

      const slot = await createPresignedUpload(
        request.user.userId,
        'avatar',
        contentType,
        contentLength
      );
      return reply.status(200).send(slot);
    }
  );

  // POST /me/avatar/confirm - Confirm avatar upload
  app.post<{ Body: ConfirmUploadInput }>(
    '/me/avatar/confirm',
    {
      preHandler: [authenticateRequest, confirmUploadRateLimiter],
      schema: {
        description: 'Confirm avatar upload and update user profile',
        tags: ['Media'],
        body: {
          type: 'object',
          required: ['objectKey'],
          properties: {
            objectKey: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { objectKey } = confirmUploadSchema.parse(request.body);
      const { userId } = request.user;

      // Ensure key belongs to caller
      if (!isValidUserKey(userId, 'avatar', objectKey)) {
        throw new ForbiddenError(
          'Object key does not belong to the authenticated user',
          'forbidden'
        );
      }

      // Verify object exists in R2 and complies with limits
      const meta = await headObject(objectKey);
      if (!meta) {
        throw new BadRequestError('Object does not exist in storage', 'object_not_found');
      }

      if (meta.contentLength > env.MAX_AVATAR_BYTES) {
        throw new BadRequestError(
          `Uploaded object exceeds maximum allowed avatar size (${env.MAX_AVATAR_BYTES} bytes)`
        );
      }

      if (!ACCEPTED_IMAGE_TYPES.includes(meta.contentType as any)) {
        throw new BadRequestError(
          `Uploaded object has unsupported content type: ${meta.contentType}`
        );
      }

      const updated = await profileService.updateMediaKey(userId, 'avatar', objectKey);
      capture(userId, 'avatar_uploaded');
      return reply.status(200).send({
        key: objectKey,
        url: computePublicUrl(objectKey, updated.updatedAt),
      });
    }
  );

  // DELETE /me/avatar - Remove avatar (idempotent)
  app.delete(
    '/me/avatar',
    {
      preHandler: [authenticateRequest, deleteMediaRateLimiter],
      schema: {
        description: 'Remove user avatar and delete file from storage',
        tags: ['Media'],
      },
    },
    async (request, reply) => {
      const { userId } = request.user;
      await profileService.updateMediaKey(userId, 'avatar', null);
      return reply.status(204).send();
    }
  );

  // POST /me/banner/upload-url - Presigned upload slot for banner
  app.post<{ Body: UploadUrlInput }>(
    '/me/banner/upload-url',
    {
      preHandler: [authenticateRequest, uploadUrlRateLimiter],
      schema: {
        description: 'Request a presigned POST slot for banner upload',
        tags: ['Media'],
        body: {
          type: 'object',
          required: ['contentType', 'contentLength'],
          properties: {
            contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
            contentLength: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const { contentType, contentLength } = uploadUrlSchema.parse(request.body);

      if (contentLength > env.MAX_BANNER_BYTES) {
        throw new BadRequestError(
          `Content length exceeds maximum allowed banner size of ${env.MAX_BANNER_BYTES} bytes`
        );
      }

      const slot = await createPresignedUpload(
        request.user.userId,
        'banner',
        contentType,
        contentLength
      );
      return reply.status(200).send(slot);
    }
  );

  // POST /me/banner/confirm - Confirm banner upload
  app.post<{ Body: ConfirmUploadInput }>(
    '/me/banner/confirm',
    {
      preHandler: [authenticateRequest, confirmUploadRateLimiter],
      schema: {
        description: 'Confirm banner upload and update user profile',
        tags: ['Media'],
        body: {
          type: 'object',
          required: ['objectKey'],
          properties: {
            objectKey: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { objectKey } = confirmUploadSchema.parse(request.body);
      const { userId } = request.user;

      // Ensure key belongs to caller
      if (!isValidUserKey(userId, 'banner', objectKey)) {
        throw new ForbiddenError(
          'Object key does not belong to the authenticated user',
          'forbidden'
        );
      }

      // Verify object exists in R2 and complies with limits
      const meta = await headObject(objectKey);
      if (!meta) {
        throw new BadRequestError('Object does not exist in storage', 'object_not_found');
      }

      if (meta.contentLength > env.MAX_BANNER_BYTES) {
        throw new BadRequestError(
          `Uploaded object exceeds maximum allowed banner size (${env.MAX_BANNER_BYTES} bytes)`
        );
      }

      if (!ACCEPTED_IMAGE_TYPES.includes(meta.contentType as any)) {
        throw new BadRequestError(
          `Uploaded object has unsupported content type: ${meta.contentType}`
        );
      }

      const updated = await profileService.updateMediaKey(userId, 'banner', objectKey);
      capture(userId, 'banner_uploaded');
      return reply.status(200).send({
        key: objectKey,
        url: computePublicUrl(objectKey, updated.updatedAt),
      });
    }
  );

  // DELETE /me/banner - Remove banner (idempotent)
  app.delete(
    '/me/banner',
    {
      preHandler: [authenticateRequest, deleteMediaRateLimiter],
      schema: {
        description: 'Remove user banner and delete file from storage',
        tags: ['Media'],
      },
    },
    async (request, reply) => {
      const { userId } = request.user;
      await profileService.updateMediaKey(userId, 'banner', null);
      return reply.status(204).send();
    }
  );

  // GET /username/check - Public check for username availability
  app.get<{ Querystring: CheckUsernameQuery }>(
    '/username/check',
    {
      preHandler: [checkUsernameRateLimiter],
      schema: {
        description: 'Public check if a username is available',
        tags: ['Profile'],
        querystring: {
          type: 'object',
          properties: {
            username: { type: 'string' },
          },
          required: ['username'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              available: { type: 'boolean' },
              reason: { type: 'string', enum: ['taken', 'reserved', 'invalid_format'] },
            },
            required: ['available'],
          },
        },
      },
    },
    async (request, reply) => {
      const parsedQuery = checkUsernameQuerySchema.parse(request.query);
      const validation = validateUsername(parsedQuery.username);

      if (!validation.ok) {
        const reason = validation.reason === 'reserved' ? 'reserved' : 'invalid_format';
        return reply.status(200).send({ available: false, reason });
      }

      const isTaken = await profileService.isUsernameTaken(validation.normalized);
      if (isTaken) {
        return reply.status(200).send({ available: false, reason: 'taken' });
      }

      return reply.status(200).send({ available: true });
    }
  );

  // PATCH /me/username - Claim / change username
  app.patch<{ Body: PatchUsernameInput }>(
    '/me/username',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Claim or change username for the authenticated user',
        tags: ['Profile'],
        body: {
          type: 'object',
          properties: {
            username: { type: 'string' },
          },
          required: ['username'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              username: { type: 'string' },
            },
            required: ['username'],
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = patchUsernameSchema.parse(request.body);
      const { userId } = request.user;

      const result = await profileService.updateUsername(userId, parsed.username);
      return reply.status(200).send(result);
    }
  );
};
