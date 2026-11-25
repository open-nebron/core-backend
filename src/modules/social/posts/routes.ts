import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../../auth/hook.js';
import {
  createPostRateLimiter,
  feedRateLimiter,
  uploadUrlRateLimiter,
  confirmUploadRateLimiter,
  deleteMediaRateLimiter,
} from '../../../plugins/rate-limit.js';
import {
  createPresignedUpload,
  headObject,
  deleteObject,
  computePublicUrl,
  isValidUserKey,
  ACCEPTED_IMAGE_TYPES,
  type AcceptedImageType,
} from '../../../lib/r2.js';
import { env } from '../../../config/env.js';
import { BadRequestError, ForbiddenError } from '../../../utils/errors.js';
import {
  createPostSchema,
  editPostSchema,
  userIdParamSchema,
  postIdParamSchema,
  postsQuerySchema,
  likesQuerySchema,
  popularPostsQuerySchema,
  userLikesQuerySchema,
} from '../validate.js';
import { defaultPostService } from './service.js';
import { defaultPostLikeService } from '../likes/service.js';

interface CreatePostBody {
  body: string;
  imageKey?: string | null;
}

interface UploadUrlBody {
  contentType: string;
  contentLength: number;
}

interface ConfirmUploadBody {
  objectKey: string;
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
  // Image upload endpoints
  // POST /posts/image/upload-url
  app.post<{ Body: UploadUrlBody }>(
    '/posts/image/upload-url',
    {
      preHandler: [authenticateRequest, uploadUrlRateLimiter],
      schema: {
        description: 'Request a presigned POST slot for post image upload',
        tags: ['Social - Media'],
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
      const { contentType, contentLength } = request.body;
      if (!ACCEPTED_IMAGE_TYPES.includes(contentType as any)) {
        throw new BadRequestError('Unsupported image content type', 'unsupported_media_type');
      }
      if (contentLength > env.MAX_POST_IMAGE_BYTES) {
        throw new BadRequestError(
          `Content length exceeds maximum allowed post image size of ${env.MAX_POST_IMAGE_BYTES} bytes`,
          'file_too_large'
        );
      }

      const slot = await createPresignedUpload(
        request.user.userId,
        'post',
        contentType as AcceptedImageType,
        contentLength
      );
      return reply.status(200).send(slot);
    }
  );

  // POST /posts/image/confirm
  app.post<{ Body: ConfirmUploadBody }>(
    '/posts/image/confirm',
    {
      preHandler: [authenticateRequest, confirmUploadRateLimiter],
      schema: {
        description: 'Confirm post image exists in storage before attaching to post',
        tags: ['Social - Media'],
        body: {
          type: 'object',
          required: ['objectKey'],
          properties: {
            objectKey: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { objectKey } = request.body;
      const { userId } = request.user;

      if (!isValidUserKey(userId, 'post', objectKey)) {
        throw new ForbiddenError(
          'Object key does not belong to the authenticated user',
          'forbidden'
        );
      }

      const meta = await headObject(objectKey);
      if (!meta) {
        throw new BadRequestError('Object does not exist in storage', 'object_not_found');
      }

      if (meta.contentLength > env.MAX_POST_IMAGE_BYTES) {
        throw new BadRequestError(
          `Uploaded object exceeds maximum allowed post image size (${env.MAX_POST_IMAGE_BYTES} bytes)`,
          'file_too_large'
        );
      }

      if (!ACCEPTED_IMAGE_TYPES.includes(meta.contentType as any)) {
        throw new BadRequestError(
          `Uploaded object has unsupported content type: ${meta.contentType}`,
          'unsupported_media_type'
        );
      }

      return reply.status(200).send({
        key: objectKey,
        url: computePublicUrl(objectKey),
      });
    }
  );

  // DELETE /posts/image/*
  app.delete(
    '/posts/image/*',
    {
      preHandler: [authenticateRequest, deleteMediaRateLimiter],
      schema: {
        description: 'Delete orphan post image from storage',
        tags: ['Social - Media'],
      },
    },
    async (request, reply) => {
      const { userId } = request.user;
      const rawKey = (request.params as any)['*'] || (request.params as any).key;
      const objectKey = decodeURIComponent(rawKey);

      if (!isValidUserKey(userId, 'post', objectKey)) {
        throw new ForbiddenError(
          'Object key does not belong to the authenticated user',
          'forbidden'
        );
      }

      await deleteObject(objectKey);
      return reply.status(204).send();
    }
  );

  // 0. GET /feed?limit=20&before=<ISO>
  app.get<{ Querystring: PaginationQuery }>(
    '/feed',
    {
      preHandler: [authenticateRequest, feedRateLimiter],
      schema: {
        description: 'Get personalized feed of followed users',
        tags: ['Social - Feed'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
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
              hasMore: { type: 'boolean' },
            },
            required: ['data', 'hasMore'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: PaginationQuery }>, reply: FastifyReply) => {
      const viewerId = request.user.userId;
      const parsedQuery = postsQuerySchema.parse(request.query);
      const res = await defaultPostService.getFeed(
        viewerId,
        parsedQuery.limit ?? 20,
        parsedQuery.before
      );
      return reply.status(200).send(res);
    }
  );

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
      const post = await defaultPostService.createPost(
        viewerId,
        parsedBody.body,
        parsedBody.imageKey
      );
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

  // 8. PATCH /posts/:id
  app.patch<{ Params: PostIdParams; Body: { body?: string; removeImage?: boolean } }>(
    '/posts/:id',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Edit own post body or remove image',
        tags: ['Social - Posts'],
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
            body: { type: 'string', minLength: 1, maxLength: 500 },
            removeImage: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const viewerId = request.user.userId;
      postIdParamSchema.parse(request.params);
      const parsedBody = editPostSchema.parse(request.body);
      const updated = await defaultPostService.editPost(viewerId, request.params.id, parsedBody);
      return reply.status(200).send(updated);
    }
  );

  // 9. GET /posts/popular?limit=20
  app.get<{ Querystring: { limit?: number } }>(
    '/posts/popular',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get top posts from the last 7 days sorted by likeCount DESC',
        tags: ['Social - Posts'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const viewerId = request.user.userId;
      const parsedQuery = popularPostsQuerySchema.parse(request.query);
      const posts = await defaultPostService.getPopular(viewerId, parsedQuery.limit);
      return reply.status(200).send(posts);
    }
  );

  // 10. GET /users/me/likes?limit=20&before=<ISO>
  app.get<{ Querystring: PaginationQuery }>(
    '/users/me/likes',
    {
      preHandler: [authenticateRequest],
      schema: {
        description: 'Get posts liked by current user',
        tags: ['Social - Posts'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            before: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const viewerId = request.user.userId;
      const parsedQuery = userLikesQuerySchema.parse(request.query);
      const posts = await defaultPostService.getViewerLikedPosts(
        viewerId,
        parsedQuery.limit,
        parsedQuery.before
      );
      return reply.status(200).send(posts);
    }
  );
};
