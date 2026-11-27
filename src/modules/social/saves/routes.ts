import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import { capture } from '../../../lib/analytics.js';
import { commentIdParamSchema, postIdParamSchema, savedListQuerySchema } from '../validate.js';
import { reelIdParamSchema } from '../../reels/reels.schema.js';
import type { SaveContentType } from './repository.js';
import { defaultSaveService } from './service.js';

interface IdParams {
  id: string;
}

interface SavedQuery {
  limit?: number;
  before?: string;
}

/**
 * Registers bookmark routes (save/unsave + list saved) uniformly for posts, reels, and comments.
 */
export const saveRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const registerTargetSaveRoutes = (
    prefix: 'posts' | 'reels' | 'comments',
    type: SaveContentType,
    tag: string
  ) => {
    const parseParams = (params: IdParams) => {
      if (type === 'post') return postIdParamSchema.parse(params);
      if (type === 'reel') return reelIdParamSchema.parse(params);
      return commentIdParamSchema.parse(params);
    };

    app.post<{ Params: IdParams }>(
      `/${prefix}/:id/save`,
      {
        preHandler: [authenticateRequest],
        schema: {
          description: `Save (bookmark) a ${type} (idempotent)`,
          tags: [tag],
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          response: {
            204: { type: 'null' },
          },
        },
      },
      async (request: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
        const viewerId = request.user.userId;
        const parsed = parseParams(request.params);
        await defaultSaveService.saveContent(viewerId, type, parsed.id);
        capture(viewerId, `${type}_saved`, { [`${type}Id`]: parsed.id });
        return reply.status(204).send();
      }
    );

    app.delete<{ Params: IdParams }>(
      `/${prefix}/:id/save`,
      {
        preHandler: [authenticateRequest],
        schema: {
          description: `Unsave a ${type} (idempotent)`,
          tags: [tag],
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          response: {
            204: { type: 'null' },
          },
        },
      },
      async (request: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
        const viewerId = request.user.userId;
        const parsed = parseParams(request.params);
        await defaultSaveService.unsaveContent(viewerId, type, parsed.id);
        return reply.status(204).send();
      }
    );
  };

  registerTargetSaveRoutes('posts', 'post', 'Social - Saves');
  registerTargetSaveRoutes('reels', 'reel', 'Reels');
  registerTargetSaveRoutes('comments', 'comment', 'Social - Saves');

  app.get<{ Querystring: SavedQuery }>(
    '/users/me/saved/posts',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get saved posts sorted by savedAt DESC',
        tags: ['Social - Saves'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: SavedQuery }>, reply: FastifyReply) => {
      const parsedQuery = savedListQuerySchema.parse(request.query);
      const items = await defaultSaveService.getSavedPosts(
        request.user.userId,
        parsedQuery.limit,
        parsedQuery.before
      );
      return reply.status(200).send(items);
    }
  );

  app.get<{ Querystring: SavedQuery }>(
    '/users/me/saved/reels',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get saved reels sorted by savedAt DESC',
        tags: ['Social - Saves'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: SavedQuery }>, reply: FastifyReply) => {
      const parsedQuery = savedListQuerySchema.parse(request.query);
      const items = await defaultSaveService.getSavedReels(
        request.user.userId,
        parsedQuery.limit,
        parsedQuery.before
      );
      return reply.status(200).send(items);
    }
  );

  app.get<{ Querystring: SavedQuery }>(
    '/users/me/saved/comments',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get saved comments sorted by savedAt DESC',
        tags: ['Social - Saves'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: SavedQuery }>, reply: FastifyReply) => {
      const parsedQuery = savedListQuerySchema.parse(request.query);
      const items = await defaultSaveService.getSavedComments(
        request.user.userId,
        parsedQuery.limit,
        parsedQuery.before
      );
      return reply.status(200).send(items);
    }
  );
};
