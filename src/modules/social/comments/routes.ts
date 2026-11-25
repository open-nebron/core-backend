import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import { createCommentRateLimiter } from '../../../plugins/rate-limit.js';
import {
  createCommentSchema,
  commentsQuerySchema,
  commentIdParamSchema,
  postIdParamSchema,
} from '../validate.js';
import { defaultCommentService } from './service.js';
import { capture } from '../../../lib/analytics.js';

interface CreateCommentBody {
  body: string;
}

interface PostIdParams {
  id: string;
}

interface CommentIdParams {
  id: string;
}

interface CommentsQuery {
  limit?: number;
  before?: string;
}

export const commentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. POST /posts/:id/comments
  app.post<{ Params: PostIdParams; Body: CreateCommentBody }>(
    '/posts/:id/comments',
    {
      preHandler: [authenticateRequest, createCommentRateLimiter],
      schema: {
        description: 'Add a comment to a post',
        tags: ['Social - Comments'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            body: { type: 'string', minLength: 1, maxLength: 300 },
          },
          required: ['body'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              postId: { type: 'string' },
              body: { type: 'string' },
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
            required: ['id', 'postId', 'body', 'createdAt', 'author'],
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: PostIdParams; Body: CreateCommentBody }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      const parsedParams = postIdParamSchema.parse(request.params);
      const parsedBody = createCommentSchema.parse(request.body);

      const comment = await defaultCommentService.createComment(
        viewerId,
        parsedParams.id,
        parsedBody.body
      );
      capture(viewerId, 'comment_created', { postId: parsedParams.id, commentId: comment.id });
      return reply.status(201).send(comment);
    }
  );

  // 2. GET /posts/:id/comments?limit=30&before=<ISO>
  app.get<{ Params: PostIdParams; Querystring: CommentsQuery }>(
    '/posts/:id/comments',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get comments on a post in chronological order',
        tags: ['Social - Comments'],
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
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                postId: { type: 'string' },
                body: { type: 'string' },
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
              required: ['id', 'postId', 'body', 'createdAt', 'author'],
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: PostIdParams; Querystring: CommentsQuery }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      const parsedParams = postIdParamSchema.parse(request.params);
      const parsedQuery = commentsQuerySchema.parse(request.query);

      const comments = await defaultCommentService.getComments(
        viewerId,
        parsedParams.id,
        parsedQuery.limit ?? 30,
        parsedQuery.before
      );
      return reply.status(200).send(comments);
    }
  );

  // 3. DELETE /comments/:id
  app.delete<{ Params: CommentIdParams }>(
    '/comments/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Delete a comment (by comment author or post author)',
        tags: ['Social - Comments'],
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
            description: 'Comment successfully soft deleted',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CommentIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedParams = commentIdParamSchema.parse(request.params);
      await defaultCommentService.deleteComment(viewerId, parsedParams.id);
      return reply.status(204).send();
    }
  );
};
