import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import { defaultPostService } from '../posts/service.js';
import {
  hashtagParamSchema,
  hashtagPostsQuerySchema,
  trendingHashtagsQuerySchema,
} from '../validate.js';

interface HashtagParams {
  tag: string;
}

interface HashtagPostsQuery {
  limit?: number;
  before?: string;
}

interface TrendingQuery {
  limit?: number;
}

export const hashtagRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Register /hashtags/trending before /hashtags/:tag/posts
  app.get<{ Querystring: TrendingQuery }>(
    '/hashtags/trending',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get trending hashtags over the last 7 days sorted by post count',
        tags: ['Social - Hashtags'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                postCount: { type: 'integer' },
              },
              required: ['tag', 'postCount'],
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: TrendingQuery }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedQuery = trendingHashtagsQuerySchema.parse(request.query);
      const trending = await defaultPostService.getTrendingHashtags(viewerId, parsedQuery.limit);
      return reply.status(200).send(trending);
    }
  );

  app.get<{ Params: HashtagParams; Querystring: HashtagPostsQuery }>(
    '/hashtags/:tag/posts',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get posts containing a given hashtag sorted DESC by createdAt',
        tags: ['Social - Hashtags'],
        params: {
          type: 'object',
          properties: {
            tag: { type: 'string', minLength: 1 },
          },
          required: ['tag'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: HashtagParams; Querystring: HashtagPostsQuery }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      const parsedParams = hashtagParamSchema.parse(request.params);
      const parsedQuery = hashtagPostsQuerySchema.parse(request.query);
      const result = await defaultPostService.getPostsByHashtag(
        viewerId,
        parsedParams.tag,
        parsedQuery.limit,
        parsedQuery.before
      );
      return reply.status(200).send(result);
    }
  );
};
