import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateRequest } from '../../auth/hook.js';
import { defaultExploreService } from './explore.service.js';

const trendingQuerySchema = z.object({
  type: z.enum(['posts', 'reels']).default('posts'),
  period: z.enum(['24h', '7d']).default('7d'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const suggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const exploreRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get(
    '/explore/trending',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get trending posts or reels ranked by engagement velocity',
        tags: ['Explore'],
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['posts', 'reels'], default: 'posts' },
            period: { type: 'string', enum: ['24h', '7d'], default: '7d' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { type, period, limit } = trendingQuerySchema.parse(request.query);
      const data = await defaultExploreService.getTrending(
        request.user.userId,
        type,
        period,
        limit
      );
      return reply.status(200).send(data);
    }
  );

  app.get(
    '/explore/suggestions',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get friend-of-friend, similar interest, and popular creator suggestions',
        tags: ['Explore'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { limit } = suggestionsQuerySchema.parse(request.query);
      const items = await defaultExploreService.getSuggestions(request.user.userId, limit);
      return reply.status(200).send(items);
    }
  );
};
