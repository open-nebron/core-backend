import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import { createPostRateLimiter } from '../../../plugins/rate-limit.js';
import {
  createPostSchema,
  userIdParamSchema,
  postIdParamSchema,
  postsQuerySchema,
  likesQuerySchema,
} from '../validate.js';
import { defaultPostService } from './service.js';
import { defaultPostLikeService } from '../likes/service.js';

interface CreatePostBody {
  body: string;
}

interface PostIdParams {
  id: string;
}

interface UserIdParams {
  userId: string;
}

interface PaginationQuery {
  limit?: number;
  before?: string;
}

export const postRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. POST /posts
  app.post<{ Body: CreatePostBody }>(
    '/posts',
    {
      preHandler: [authenticateRequest, createPostRateLimiter],
      schema: {
        description: 'Create a new post',
        tags: ['Social - Posts'],
        body: {
          type: 'object',
          properties: {
            body: { type: 'string', minLength: 1, maxLength: 500 },
          },
          required: ['body'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              body: { type: 'string' },
              imageKey: { type: 'string', nullable: true },
              imageUrl: { type: 'string', nullable: true },
              likeCount: { type: 'integer' },
              commentCount: { type: 'integer' },
              likedByViewer: { type: 'boolean' },
              createdAt: { type: 'string' },
              author: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  username: { type: 'string' },
                  name: { type: 'string', nullable: true },
                  avatarUrl: { type: 'string', nullable: true },
                },
                required: ['userId', 'username'],
              },
            },
            required: ['id', 'body', 'likeCount', 'commentCount', 'likedByViewer', 'createdAt', 'author'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreatePostBody }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedBody = createPostSchema.parse(request.body);
      const post = await defaultPostService.createPost(viewerId, parsedBody.body);
      return reply.status(201).send(post);
    }
  );

  // 2. GET /users/:userId/posts?limit=20&before=<ISO>
  app.get<{ Params: UserIdParams; Querystring: PaginationQuery }>(
    '/users/:userId/posts',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get posts by a specific user',
        tags: ['Social - Posts'],
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
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
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
      const parsedQuery = postsQuerySchema.parse(request.query);
      const targetUserId = request.params.userId;

      const posts = await defaultPostService.getUserPosts(
        viewerId,
        targetUserId,
        parsedQuery.limit,
        parsedQuery.before
      );

      return reply.status(200).send(posts);
    }
  );

  // 3. GET /posts/:id
  app.get<{ Params: PostIdParams }>(
    '/posts/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get single post details',
        tags: ['Social - Posts'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    async (request: FastifyRequest<{ Params: PostIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      postIdParamSchema.parse(request.params);
      const post = await defaultPostService.getPost(viewerId, request.params.id);
      return reply.status(200).send(post);
    }
  );

  // 4. DELETE /posts/:id
  app.delete<{ Params: PostIdParams }>(
    '/posts/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Delete own post (soft delete)',
        tags: ['Social - Posts'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          204: {
            type: 'null',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PostIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      postIdParamSchema.parse(request.params);
      await defaultPostService.deletePost(viewerId, request.params.id);
      return reply.status(204).send();
    }
  );

  // 5. POST /posts/:id/like
  app.post<{ Params: PostIdParams }>(
    '/posts/:id/like',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Like a post (idempotent)',
        tags: ['Social - Likes'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          204: {
            type: 'null',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PostIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      postIdParamSchema.parse(request.params);
      await defaultPostLikeService.likePost(viewerId, request.params.id);
      return reply.status(204).send();
    }
  );

  // 6. DELETE /posts/:id/like
  app.delete<{ Params: PostIdParams }>(
    '/posts/:id/like',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Unlike a post (idempotent)',
        tags: ['Social - Likes'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        response: {
          204: {
            type: 'null',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PostIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      postIdParamSchema.parse(request.params);
      await defaultPostLikeService.unlikePost(viewerId, request.params.id);
      return reply.status(204).send();
    }
  );

  // 7. GET /posts/:id/likes?limit=30&before=<ISO>
  app.get<{ Params: PostIdParams; Querystring: PaginationQuery }>(
    '/posts/:id/likes',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get list of users who liked a post',
        tags: ['Social - Likes'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
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
      request: FastifyRequest<{ Params: PostIdParams; Querystring: PaginationQuery }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      postIdParamSchema.parse(request.params);
      const parsedQuery = likesQuerySchema.parse(request.query);
      const likers = await defaultPostLikeService.getPostLikes(
        viewerId,
        request.params.id,
        parsedQuery.limit,
        parsedQuery.before
      );
      return reply.status(200).send(likers);
    }
  );
};
