import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import {
  confirmUploadRateLimiter,
  createCommentRateLimiter,
  createReelRateLimiter,
  reelUploadUrlRateLimiter,
} from '../../plugins/rate-limit.js';
import { capture } from '../../lib/analytics.js';
import { createCommentSchema } from '../social/validate.js';
import { defaultCommentService } from '../social/comments/service.js';
import {
  reelCommentsQuerySchema,
  reelConfirmSchema,
  reelIdParamSchema,
  reelLikesQuerySchema,
  reelsFeedQuerySchema,
  reelThumbnailUploadUrlSchema,
  reelUploadUrlSchema,
  reelUserIdParamSchema,
} from './reels.schema.js';
import { defaultReelsService } from './reels.service.js';

export const reelRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. POST /reels/upload-url
  app.post(
    '/reels/upload-url',
    {
      preHandler: [authenticateRequest, reelUploadUrlRateLimiter],
      schema: {
        description: 'Request a presigned POST slot for reel MP4 video upload (max 50MB)',
        tags: ['Reels'],
        body: {
          type: 'object',
          required: ['contentType', 'contentLength'],
          properties: {
            contentType: { type: 'string', enum: ['video/mp4'] },
            contentLength: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = reelUploadUrlSchema.parse(request.body);
      const slot = await defaultReelsService.createVideoUploadUrl(
        request.user.userId,
        parsed.contentType,
        parsed.contentLength
      );
      return reply.status(200).send(slot);
    }
  );

  // 1b. POST /reels/thumbnail/upload-url
  app.post(
    '/reels/thumbnail/upload-url',
    {
      preHandler: [authenticateRequest, reelUploadUrlRateLimiter],
      schema: {
        description: 'Request a presigned POST slot for optional reel thumbnail image upload (max 5MB)',
        tags: ['Reels'],
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
      const parsed = reelThumbnailUploadUrlSchema.parse(request.body);
      const slot = await defaultReelsService.createThumbnailUploadUrl(
        request.user.userId,
        parsed.contentType,
        parsed.contentLength
      );
      return reply.status(200).send(slot);
    }
  );

  // 2. POST /reels/confirm
  app.post(
    '/reels/confirm',
    {
      preHandler: [authenticateRequest, confirmUploadRateLimiter, createReelRateLimiter],
      schema: {
        description: 'Confirm uploaded MP4 video in R2 and publish a Reel',
        tags: ['Reels'],
        body: {
          type: 'object',
          required: ['videoKey', 'duration'],
          properties: {
            videoKey: { type: 'string' },
            thumbnailKey: { type: 'string', nullable: true },
            caption: { type: 'string', nullable: true, maxLength: 300 },
            duration: { type: 'number', minimum: 5, maximum: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = reelConfirmSchema.parse(request.body);
      const reel = await defaultReelsService.confirmReel(request.user.userId, parsed);
      capture(request.user.userId, 'reel_created', {
        reelId: reel.id,
        duration: reel.duration,
        hasCaption: Boolean(reel.caption),
      });
      return reply.status(201).send(reel);
    }
  );

  // 3. GET /reels?cursor=&limit=10
  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/reels',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get chronological reels feed from followed users and self',
        tags: ['Reels'],
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = reelsFeedQuerySchema.parse(request.query);
      const result = await defaultReelsService.getFeedReels(
        request.user.userId,
        query.cursor,
        query.limit
      );
      return reply.status(200).send(result);
    }
  );

  // 4. GET /users/me/reels
  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/users/me/reels',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: "Get current user's own reels grid",
        tags: ['Reels'],
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = reelsFeedQuerySchema.parse(request.query);
      const result = await defaultReelsService.getUserReels(
        request.user.userId,
        request.user.userId,
        query.cursor,
        query.limit
      );
      return reply.status(200).send(result);
    }
  );

  // 5. GET /users/:userId/reels
  app.get<{ Params: { userId: string }; Querystring: { cursor?: string; limit?: number } }>(
    '/users/:userId/reels',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: "Get a user's reels grid",
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelUserIdParamSchema.parse(request.params);
      const query = reelsFeedQuerySchema.parse(request.query);
      const result = await defaultReelsService.getUserReels(
        request.user.userId,
        params.userId,
        query.cursor,
        query.limit
      );
      return reply.status(200).send(result);
    }
  );

  // 6. GET /reels/:id
  app.get<{ Params: { id: string } }>(
    '/reels/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get single reel by ID',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      const reel = await defaultReelsService.getReelById(request.user.userId, params.id);
      return reply.status(200).send(reel);
    }
  );

  // 7. POST /reels/:id/view
  app.post<{ Params: { id: string } }>(
    '/reels/:id/view',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Record a reel view in the Redis write-behind buffer',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      await defaultReelsService.recordView(request.user.userId, params.id);
      capture(request.user.userId, 'reel_viewed', { reelId: params.id });
      return reply.status(200).send({ status: 'ok' });
    }
  );

  // 8. POST /reels/:id/like
  app.post<{ Params: { id: string } }>(
    '/reels/:id/like',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Like a reel (idempotent)',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      const res = await defaultReelsService.likeReel(request.user.userId, params.id);
      capture(request.user.userId, 'reel_liked', { reelId: params.id });
      return reply.status(200).send(res);
    }
  );

  // 9. DELETE /reels/:id/like
  app.delete<{ Params: { id: string } }>(
    '/reels/:id/like',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Unlike a reel (idempotent)',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      const res = await defaultReelsService.unlikeReel(request.user.userId, params.id);
      return reply.status(200).send(res);
    }
  );

  // 10. GET /reels/:id/likes
  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    '/reels/:id/likes',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get list of users who liked a reel',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
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
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      const query = reelLikesQuerySchema.parse(request.query);
      const likers = await defaultReelsService.getReelLikes(
        request.user.userId,
        params.id,
        query.limit,
        query.before
      );
      return reply.status(200).send(likers);
    }
  );

  // 11. POST /reels/:id/comments
  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/reels/:id/comments',
    {
      preHandler: [authenticateRequest, createCommentRateLimiter],
      schema: {
        description: 'Add a comment to a reel',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['body'],
          properties: {
            body: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      const body = createCommentSchema.parse(request.body);
      const comment = await defaultCommentService.createReelComment(
        request.user.userId,
        params.id,
        body.body
      );
      capture(request.user.userId, 'reel_comment_created', {
        reelId: params.id,
        commentId: comment.id,
      });
      return reply.status(201).send(comment);
    }
  );

  // 12. GET /reels/:id/comments
  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    '/reels/:id/comments',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get comments on a reel in chronological order',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
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
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      const query = reelCommentsQuerySchema.parse(request.query);
      const comments = await defaultCommentService.getReelComments(
        request.user.userId,
        params.id,
        query.limit,
        query.before
      );
      return reply.status(200).send(comments);
    }
  );

  // 13. DELETE /reels/:id
  app.delete<{ Params: { id: string } }>(
    '/reels/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Soft delete a reel (owner only); queues R2 object cleanup',
        tags: ['Reels'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const params = reelIdParamSchema.parse(request.params);
      await defaultReelsService.deleteReel(request.user.userId, params.id);
      return reply.status(204).send();
    }
  );
};
