import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import { createCommentRateLimiter } from '../../../plugins/rate-limit.js';
import {
  createCommentSchema,
  editCommentSchema,
  commentsQuerySchema,
  commentRepliesQuerySchema,
  commentIdParamSchema,
  postIdParamSchema,
  pinCommentParamSchema,
} from '../validate.js';
import { defaultCommentService } from './service.js';
import { capture } from '../../../lib/analytics.js';

interface CreateCommentBody {
  body: string;
  parentCommentId?: string | null;
}

interface EditCommentBody {
  body: string;
}

interface PostIdParams {
  id: string;
}

interface CommentIdParams {
  id: string;
}

interface PinCommentParams {
  id: string;
  commentId: string;
}

interface CommentsQuery {
  limit?: number;
  before?: string;
  sort?: 'top' | 'new';
}

interface RepliesQuery {
  limit?: number;
  before?: string;
}

const authorSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    username: { type: 'string' },
    name: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true },
  },
  required: ['userId', 'username'],
};

const replyToUserSchema = {
  type: 'object',
  nullable: true,
  properties: {
    userId: { type: 'string' },
    username: { type: 'string' },
  },
  required: ['userId', 'username'],
};

const commentItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    postId: { type: 'string' },
    reelId: { type: 'string' },
    targetType: { type: 'string' },
    parentCommentId: { type: 'string', nullable: true },
    replyToUserId: { type: 'string', nullable: true },
    replyToUser: replyToUserSchema,
    body: { type: 'string' },
    likeCount: { type: 'integer' },
    replyCount: { type: 'integer' },
    saveCount: { type: 'integer' },
    shareCount: { type: 'integer' },
    likedByViewer: { type: 'boolean' },
    savedByViewer: { type: 'boolean' },
    pinned: { type: 'boolean' },
    pinnedAt: { type: 'string', nullable: true },
    editedAt: { type: 'string', nullable: true },
    mentions: { type: 'array', items: { type: 'string' } },
    hashtags: { type: 'array', items: { type: 'string' } },
    deleted: { type: 'boolean' },
    createdAt: { type: 'string' },
    author: authorSchema,
  },
  required: ['id', 'body', 'likeCount', 'replyCount', 'likedByViewer', 'createdAt', 'author'],
};

export const commentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. POST /posts/:id/comments
  app.post<{ Params: PostIdParams; Body: CreateCommentBody }>(
    '/posts/:id/comments',
    {
      preHandler: [authenticateRequest, createCommentRateLimiter],
      schema: {
        description: 'Add a top-level comment or reply to a post',
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
            parentCommentId: { type: 'string', nullable: true },
          },
          required: ['body'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              ...commentItemSchema.properties,
              topReplies: {
                type: 'array',
                items: commentItemSchema,
              },
              parent: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  body: { type: 'string' },
                  createdAt: { type: 'string' },
                  author: authorSchema,
                },
                required: ['id', 'body', 'createdAt', 'author'],
              },
            },
            required: ['id', 'postId', 'body', 'likeCount', 'replyCount', 'likedByViewer', 'createdAt', 'author'],
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
        parsedBody.body,
        parsedBody.parentCommentId
      );
      capture(viewerId, 'comment_created', {
        postId: parsedParams.id,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId ?? null,
      });
      return reply.status(201).send(comment);
    }
  );

  // 2. GET /posts/:id/comments?limit=20&before=<ISO>&sort=top|new
  app.get<{ Params: PostIdParams; Querystring: CommentsQuery }>(
    '/posts/:id/comments',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get top-level comments on a post with topReplies preview',
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
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
            sort: { type: 'string', enum: ['top', 'new'], default: 'top' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ...commentItemSchema.properties,
                topReplies: {
                  type: 'array',
                  items: commentItemSchema,
                },
              },
              required: ['id', 'postId', 'body', 'likeCount', 'replyCount', 'likedByViewer', 'createdAt', 'author', 'topReplies'],
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
        parsedQuery.limit ?? 20,
        parsedQuery.before,
        parsedQuery.sort ?? 'top'
      );
      return reply.status(200).send(comments);
    }
  );

  // 3. GET /comments/:id/replies?limit=20&before=<ISO>
  app.get<{ Params: CommentIdParams; Querystring: RepliesQuery }>(
    '/comments/:id/replies',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get replies to a top-level comment',
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
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: commentItemSchema,
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CommentIdParams; Querystring: RepliesQuery }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      const parsedParams = commentIdParamSchema.parse(request.params);
      const parsedQuery = commentRepliesQuerySchema.parse(request.query);

      const replies = await defaultCommentService.getCommentReplies(
        viewerId,
        parsedParams.id,
        parsedQuery.limit ?? 20,
        parsedQuery.before
      );
      return reply.status(200).send(replies);
    }
  );

  // 4. POST /comments/:id/like
  app.post<{ Params: CommentIdParams }>(
    '/comments/:id/like',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Like a comment (idempotent)',
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
            description: 'Comment liked',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CommentIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedParams = commentIdParamSchema.parse(request.params);
      await defaultCommentService.likeComment(viewerId, parsedParams.id);
      capture(viewerId, 'comment_liked', { commentId: parsedParams.id });
      return reply.status(204).send();
    }
  );

  // 5. DELETE /comments/:id/like
  app.delete<{ Params: CommentIdParams }>(
    '/comments/:id/like',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Unlike a comment (idempotent)',
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
            description: 'Comment unliked',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CommentIdParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedParams = commentIdParamSchema.parse(request.params);
      await defaultCommentService.unlikeComment(viewerId, parsedParams.id);
      return reply.status(204).send();
    }
  );

  // 6. PATCH /comments/:id
  app.patch<{ Params: CommentIdParams; Body: EditCommentBody }>(
    '/comments/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Edit a comment (author only, not deleted)',
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
          200: commentItemSchema,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CommentIdParams; Body: EditCommentBody }>,
      reply: FastifyReply
    ) => {
      const viewerId = request.user.userId;
      const parsedParams = commentIdParamSchema.parse(request.params);
      const parsedBody = editCommentSchema.parse(request.body);
      const updated = await defaultCommentService.editComment(
        viewerId,
        parsedParams.id,
        parsedBody.body
      );
      return reply.status(200).send(updated);
    }
  );

  // 7. POST /posts/:id/comments/:commentId/pin
  app.post<{ Params: PinCommentParams }>(
    '/posts/:id/comments/:commentId/pin',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Pin a comment to the top of a post (post author only, max 3)',
        tags: ['Social - Comments'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            commentId: { type: 'string' },
          },
          required: ['id', 'commentId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'Comment pinned',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PinCommentParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedParams = pinCommentParamSchema.parse(request.params);
      await defaultCommentService.pinComment(
        viewerId,
        parsedParams.id,
        parsedParams.commentId
      );
      return reply.status(204).send();
    }
  );

  // 8. DELETE /posts/:id/comments/:commentId/pin
  app.delete<{ Params: PinCommentParams }>(
    '/posts/:id/comments/:commentId/pin',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Unpin a comment from a post (post author only)',
        tags: ['Social - Comments'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            commentId: { type: 'string' },
          },
          required: ['id', 'commentId'],
        },
        response: {
          204: {
            type: 'null',
            description: 'Comment unpinned',
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PinCommentParams }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedParams = pinCommentParamSchema.parse(request.params);
      await defaultCommentService.unpinComment(
        viewerId,
        parsedParams.id,
        parsedParams.commentId
      );
      return reply.status(204).send();
    }
  );

  // 9. DELETE /comments/:id
  app.delete<{ Params: CommentIdParams }>(
    '/comments/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Delete a comment (preserves thread placeholder if it has replies)',
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
            description: 'Comment deleted',
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
