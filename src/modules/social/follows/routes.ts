import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import {
  userIdParamSchema,
  followersQuerySchema,
  suggestionsQuerySchema,
} from '../validate.js';
import { defaultFollowService } from './service.js';

interface UserIdParams {
  userId: string;
}

interface PaginationQuery {
  limit?: number;
  before?: string;
}

export const followRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Static route MUST come before dynamic /users/:userId/*
  // 1. GET /users/me/suggestions?limit=10
  app.get<{ Querystring: { limit?: number } }>(
    '/users/me/suggestions',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get user follow suggestions',
        tags: ['Social - Follows'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { limit?: number } }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsed = suggestionsQuerySchema.parse(request.query);
      const suggestions = await defaultFollowService.getSuggestions(viewerId, parsed.limit);
      return reply.status(200).send(suggestions);
    }
  );

  // 2. POST /users/:userId/follow
  app.post<{ Params: UserIdParams }>(
    '/users/:userId/follow',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Follow a user',
        tags: ['Social - Follows'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
          required: ['userId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'Successfully followed or already following',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: UserIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      userIdParamSchema.parse(request.params);
      const targetUserId = request.params.userId;

      await defaultFollowService.followUser(viewerId, targetUserId);
      return reply.status(204).send();
    }
  );

  // 3. DELETE /users/:userId/follow
  app.delete<{ Params: UserIdParams }>(
    '/users/:userId/follow',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Unfollow a user',
        tags: ['Social - Follows'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
          required: ['userId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'Successfully unfollowed or not following',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: UserIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      userIdParamSchema.parse(request.params);
      const targetUserId = request.params.userId;

      await defaultFollowService.unfollowUser(viewerId, targetUserId);
      return reply.status(204).send();
    }
  );

  // 4. GET /users/:userId/followers?limit=30&before=<ISO>
  app.get<{ Params: UserIdParams; Querystring: PaginationQuery }>(
    '/users/:userId/followers',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get followers of a user',
        tags: ['Social - Follows'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
          required: ['userId'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 30 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: UserIdParams; Querystring: PaginationQuery }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      userIdParamSchema.parse(request.params);
      const parsedQuery = followersQuerySchema.parse(request.query);
      const targetUserId = request.params.userId;

      const followers = await defaultFollowService.getFollowers(
        viewerId,
        targetUserId,
        parsedQuery.limit,
        parsedQuery.before
      );

      return reply.status(200).send(followers);
    }
  );

  // 5. GET /users/:userId/following?limit=30&before=<ISO>
  app.get<{ Params: UserIdParams; Querystring: PaginationQuery }>(
    '/users/:userId/following',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get users followed by a user',
        tags: ['Social - Follows'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
          required: ['userId'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 30 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: UserIdParams; Querystring: PaginationQuery }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      userIdParamSchema.parse(request.params);
      const parsedQuery = followersQuerySchema.parse(request.query);
      const targetUserId = request.params.userId;

      const following = await defaultFollowService.getFollowing(
        viewerId,
        targetUserId,
        parsedQuery.limit,
        parsedQuery.before
      );

      return reply.status(200).send(following);
    }
  );
};
