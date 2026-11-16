import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import { checkUsernameRateLimiter } from '../../plugins/rate-limit.js';
import {
  checkUsernameQuerySchema,
  patchMeSchema,
  patchUsernameSchema,
  type CheckUsernameQuery,
  type PatchMeInput,
  type PatchUsernameInput,
} from './profile.schema.js';
import { formatProfileResponse, profileService } from './profile.service.js';
import { validateUsername } from './username.rules.js';
import { NotFoundError } from '../../utils/errors.js';

export const profileRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
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
              bio: { type: 'string', nullable: true },
              profilePicUrl: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
            required: ['userId', 'username', 'createdAt'],
          },
          401: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
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

  // PATCH /me - Update current user profile fields
  app.patch<{ Body: PatchMeInput }>(
    '/me',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Update current user profile information',
        tags: ['Profile'],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            dateOfBirth: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            bio: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const parsedBody = patchMeSchema.parse(request.body);
      const { userId } = request.user;

      const updated = await profileService.updateProfile(userId, parsedBody);
      return reply.status(200).send(formatProfileResponse(updated));
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
