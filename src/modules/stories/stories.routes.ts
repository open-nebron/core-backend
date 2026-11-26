import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import {
  confirmUploadRateLimiter,
  createStoryRateLimiter,
  storyUploadUrlRateLimiter,
} from '../../plugins/rate-limit.js';
import { capture } from '../../lib/analytics.js';
import {
  storyConfirmSchema,
  storyIdParamSchema,
  storyUploadUrlSchema,
  storyUserIdParamSchema,
} from './stories.schema.js';
import { defaultStoriesService } from './stories.service.js';

export const storyRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. POST /stories/upload-url
  app.post(
    '/stories/upload-url',
    {
      preHandler: [authenticateRequest, storyUploadUrlRateLimiter],
      schema: {
        description: 'Request a presigned POST slot for story image or video upload',
        tags: ['Stories'],
        body: {
          type: 'object',
          required: ['contentType', 'contentLength'],
          properties: {
            contentType: {
              type: 'string',
              enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
            },
            contentLength: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = storyUploadUrlSchema.parse(request.body);
      const slot = await defaultStoriesService.createUploadUrl(
        request.user.userId,
        parsed.contentType,
        parsed.contentLength
      );
      return reply.status(200).send(slot);
    }
  );

  // 2. POST /stories/confirm
  app.post(
    '/stories/confirm',
    {
      preHandler: [authenticateRequest, confirmUploadRateLimiter, createStoryRateLimiter],
      schema: {
        description: 'Confirm uploaded story media and create a 24h ephemeral story',
        tags: ['Stories'],
        body: {
          type: 'object',
          required: ['objectKey', 'mediaType'],
          properties: {
            objectKey: { type: 'string' },
            mediaType: { type: 'string', enum: ['image', 'video'] },
            duration: { type: 'integer', minimum: 1, maximum: 15 },
            caption: { type: 'string', nullable: true, maxLength: 200 },
            thumbnailKey: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = storyConfirmSchema.parse(request.body);
      const story = await defaultStoriesService.confirmStory(request.user.userId, parsed);
      capture(request.user.userId, 'story_created', {
        storyId: story.id,
        mediaType: story.mediaType,
        duration: story.duration,
      });
      return reply.status(201).send(story);
    }
  );

  // 3. GET /stories
  app.get(
    '/stories',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get grouped 24h stories for followed users and current user',
        tags: ['Stories'],
      },
    },
    async (request, reply) => {
      const result = await defaultStoriesService.getFeedStories(request.user.userId);
      return reply.status(200).send(result);
    }
  );

  // 4. GET /stories/:userId
  app.get<{ Params: { userId: string } }>(
    '/stories/:userId',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get active story group for a specific user',
        tags: ['Stories'],
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = storyUserIdParamSchema.parse(request.params);
      const group = await defaultStoriesService.getUserStories(request.user.userId, userId);
      return reply.status(200).send(group);
    }
  );

  // 5. POST /stories/:id/view
  app.post<{ Params: { id: string } }>(
    '/stories/:id/view',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Record a view on a story (idempotent)',
        tags: ['Stories'],
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
      const { id } = storyIdParamSchema.parse(request.params);
      await defaultStoriesService.viewStory(request.user.userId, id);
      return reply.status(204).send();
    }
  );

  // 6. DELETE /stories/:id
  app.delete<{ Params: { id: string } }>(
    '/stories/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Delete own story immediately from R2 and MongoDB',
        tags: ['Stories'],
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
      const { id } = storyIdParamSchema.parse(request.params);
      await defaultStoriesService.deleteStory(request.user.userId, id);
      return reply.status(204).send();
    }
  );

  // 7. GET /stories/:id/viewers
  app.get<{ Params: { id: string } }>(
    '/stories/:id/viewers',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get viewers list for own story (author only, capped at 100)',
        tags: ['Stories'],
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
      const { id } = storyIdParamSchema.parse(request.params);
      const res = await defaultStoriesService.getStoryViewers(request.user.userId, id);
      return reply.status(200).send(res);
    }
  );
};
