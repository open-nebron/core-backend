import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import {
  blockRateLimiter,
  muteRateLimiter,
  getRelationshipRateLimiter,
  checkRelationshipsRateLimiter,
} from '../../plugins/rate-limit.js';
import { env } from '../../config/env.js';
import {
  InvalidInternalTokenError,
  InternalNotConfiguredError,
  InvalidUuidError,
} from '../../utils/errors.js';
import {
  isValidUserId,
  validateTargetUserId,
  validateMuteInput,
} from './validate.js';
import { defaultRelationshipService, RelationshipService } from './service.js';

export const relationshipRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const service = defaultRelationshipService;

  // 1. GET /relationships/check - Internal endpoint to batch check relationships
  app.get(
    '/relationships/check',
    {
      preHandler: [checkRelationshipsRateLimiter],
      schema: {
        description: 'Internal endpoint to batch-check block and mute state against multiple user IDs',
        tags: ['Relationships'],
        querystring: {
          type: 'object',
          properties: {
            userIds: {
              type: 'string',
              description: 'Comma-separated target user IDs',
            },
            fromUserId: {
              type: 'string',
              description: 'Optional requesting user ID',
            },
          },
        },
        headers: {
          type: 'object',
          properties: {
            'x-internal-token': {
              type: 'string',
              description: 'Internal service token matching INTERNAL_TOKEN env',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    blocked: { type: 'boolean' },
                    muted: {
                      type: 'object',
                      properties: {
                        calls: { type: 'boolean' },
                        messages: { type: 'boolean' },
                      },
                      required: ['calls', 'messages'],
                    },
                  },
                  required: ['blocked', 'muted'],
                },
              },
            },
            required: ['data'],
          },
        },
      },
    },
    async (request, reply) => {
      const internalToken = env.INTERNAL_TOKEN;
      if (!internalToken) {
        throw new InternalNotConfiguredError('Internal service token not configured');
      }

      const incomingToken = request.headers['x-internal-token'];
      if (!incomingToken || incomingToken !== internalToken) {
        throw new InvalidInternalTokenError('Invalid or missing internal token');
      }

      const query = request.query as { userIds?: string; fromUserId?: string; userId?: string };
      const userIdsParam = query.userIds || '';
      const userIds = userIdsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const fromUserId = query.fromUserId || query.userId || null;
      const data = await service.checkRelationships(fromUserId, userIds);

      reply.header('Cache-Control', 'private, max-age=60');
      return reply.status(200).send({ data });
    }
  );

  // 2. POST /relationships/:userId/block
  app.post(
    '/relationships/:userId/block',
    {
      preHandler: [authenticateRequest, blockRateLimiter],
      schema: {
        description: 'Block a user. Rejects self-block.',
        tags: ['Relationships'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Target user ID to block' },
          },
          required: ['userId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'User blocked successfully',
          },
        },
      },
    },
    async (request, reply) => {
      const callerUserId = request.user.userId;
      const { userId: targetUserId } = request.params as { userId: string };

      validateTargetUserId(callerUserId, targetUserId);
      await service.blockUser(callerUserId, targetUserId);

      return reply.status(204).send();
    }
  );

  // 3. DELETE /relationships/:userId/block
  app.delete(
    '/relationships/:userId/block',
    {
      preHandler: [authenticateRequest, blockRateLimiter],
      schema: {
        description: 'Unblock a previously blocked user.',
        tags: ['Relationships'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Target user ID to unblock' },
          },
          required: ['userId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'User unblocked successfully',
          },
        },
      },
    },
    async (request, reply) => {
      const callerUserId = request.user.userId;
      const { userId: targetUserId } = request.params as { userId: string };

      validateTargetUserId(callerUserId, targetUserId);
      await service.unblockUser(callerUserId, targetUserId);

      return reply.status(204).send();
    }
  );

  // 4. POST /relationships/:userId/mute
  app.post(
    '/relationships/:userId/mute',
    {
      preHandler: [authenticateRequest, muteRateLimiter],
      schema: {
        description: 'Mute calls and/or messages from a user, optionally until a timestamp.',
        tags: ['Relationships'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Target user ID to mute' },
          },
          required: ['userId'],
        },
        body: {
          type: 'object',
          properties: {
            calls: { type: 'boolean' },
            messages: { type: 'boolean' },
            until: { type: ['string', 'null'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              calls: { type: 'boolean' },
              messages: { type: 'boolean' },
              until: { type: ['string', 'null'] },
            },
            required: ['calls', 'messages', 'until'],
          },
        },
      },
    },
    async (request, reply) => {
      const callerUserId = request.user.userId;
      const { userId: targetUserId } = request.params as { userId: string };

      validateTargetUserId(callerUserId, targetUserId);
      const muteInput = validateMuteInput(request.body);

      const result = await service.muteUser(callerUserId, targetUserId, muteInput);
      return reply.status(200).send(result);
    }
  );

  // 5. DELETE /relationships/:userId/mute
  app.delete(
    '/relationships/:userId/mute',
    {
      preHandler: [authenticateRequest, muteRateLimiter],
      schema: {
        description: 'Unmute calls and messages from a user.',
        tags: ['Relationships'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Target user ID to unmute' },
          },
          required: ['userId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'User unmuted successfully',
          },
        },
      },
    },
    async (request, reply) => {
      const callerUserId = request.user.userId;
      const { userId: targetUserId } = request.params as { userId: string };

      validateTargetUserId(callerUserId, targetUserId);
      await service.unmuteUser(callerUserId, targetUserId);

      return reply.status(204).send();
    }
  );

  // 6. GET /relationships/:userId
  app.get(
    '/relationships/:userId',
    {
      preHandler: [authenticateRequest, getRelationshipRateLimiter],
      schema: {
        description: 'Get relationship state with a user (blocked, mute state).',
        tags: ['Relationships'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Target user ID' },
          },
          required: ['userId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              blocked: { type: 'boolean' },
              mute: {
                type: 'object',
                properties: {
                  calls: { type: 'boolean' },
                  messages: { type: 'boolean' },
                  until: { type: ['string', 'null'] },
                },
                required: ['calls', 'messages', 'until'],
              },
            },
            required: ['blocked', 'mute'],
          },
        },
      },
    },
    async (request, reply) => {
      const callerUserId = request.user.userId;
      const { userId: targetUserId } = request.params as { userId: string };

      if (!isValidUserId(targetUserId)) {
        throw new InvalidUuidError('Invalid user ID format');
      }

      const result = await service.getRelationship(callerUserId, targetUserId);
      return reply.status(200).send(result);
    }
  );
};
