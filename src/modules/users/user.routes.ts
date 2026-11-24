import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateRequest } from '../../auth/hook.js';
import { userSearchRateLimiter, userGetRateLimiter } from '../../plugins/rate-limit.js';
import { getProfilesCollection, type ProfileDocument } from '../../db/mongo.js';
import { NotFoundError } from '../../utils/errors.js';
import { computePublicUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';

interface SearchUsersQuery {
  q?: string;
  limit?: string | number;
}

interface ByUsernameParams {
  username: string;
}

interface ByUserIdParams {
  userId: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function authenticateUserOrInternal(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const incoming = request.headers['x-internal-token'];
  if (incoming && incoming === env.INTERNAL_TOKEN) {
    return;
  }
  return authenticateRequest(request, reply);
}

export const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. GET /users/search?q=<string>&limit=20
  app.get<{ Querystring: SearchUsersQuery }>(
    '/users/search',
    {
      preHandler: [authenticateRequest, userSearchRateLimiter],
      schema: {
        description: 'Search users by username or display name prefix',
        tags: ['Users'],
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 50 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          required: ['q'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
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
            },
            required: ['users'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: SearchUsersQuery }>, reply: FastifyReply) => {
      const rawQ = request.query.q || '';
      const trimmed = rawQ.trim().toLowerCase();

      if (!trimmed || trimmed.length === 0) {
        return reply.status(200).send({ users: [] });
      }

      const rawLimit = Number(request.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;

      const escaped = escapeRegex(trimmed);
      const regex = new RegExp(`^${escaped}`, 'i');

      const collection = getProfilesCollection();
      const docs = await collection
        .find({
          $or: [
            { username: { $regex: regex } },
            { name: { $regex: regex } },
          ],
        })
        .limit(limit)
        .toArray();

      const users = docs.map((doc: ProfileDocument) => ({
        userId: doc.userId,
        username: doc.username,
        name: doc.name ?? null,
        avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
      }));

      return reply.status(200).send({ users });
    }
  );

  // 2. GET /users/by-username/:username
  app.get<{ Params: ByUsernameParams }>(
    '/users/by-username/:username',
    {
      preHandler: [authenticateRequest, userGetRateLimiter],
      schema: {
        description: 'Fetch user public profile summary by username',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            username: { type: 'string' },
          },
          required: ['username'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              username: { type: 'string' },
              name: { type: 'string', nullable: true },
              avatarUrl: { type: 'string', nullable: true },
              bannerUrl: { type: 'string', nullable: true },
              bio: { type: 'string', nullable: true },
              about: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
            required: ['userId', 'username', 'createdAt'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ByUsernameParams }>, reply: FastifyReply) => {
      const username = (request.params.username || '').trim().toLowerCase();
      const collection = getProfilesCollection();
      const doc = await collection.findOne({ username });

      if (!doc) {
        throw new NotFoundError(`User with username '${username}' not found`);
      }

      return reply.status(200).send({
        userId: doc.userId,
        username: doc.username,
        name: doc.name ?? null,
        avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
        bannerUrl: computePublicUrl(doc.bannerKey, doc.updatedAt),
        bio: doc.bio ?? null,
        about: doc.about ?? null,
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
      });
    }
  );

  // 3. GET /users/:userId
  app.get<{ Params: ByUserIdParams }>(
    '/users/:userId',
    {
      preHandler: [authenticateUserOrInternal, userGetRateLimiter],
      schema: {
        description: 'Fetch public profile by userId',
        tags: ['Users'],
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
          },
          required: ['userId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              username: { type: 'string' },
              name: { type: 'string', nullable: true },
              avatarUrl: { type: 'string', nullable: true },
              bannerUrl: { type: 'string', nullable: true },
              bio: { type: 'string', nullable: true },
              about: { type: 'string', nullable: true },
              messageRequestPolicy: { type: 'string', enum: ['everyone', 'known', 'nobody'] },
              createdAt: { type: 'string' },
            },
            required: ['userId', 'username', 'createdAt'],
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ByUserIdParams }>, reply: FastifyReply) => {
      const userId = (request.params.userId || '').trim();
      const collection = getProfilesCollection();
      const doc = await collection.findOne({ userId });

      if (!doc) {
        throw new NotFoundError(`User with ID '${userId}' not found`);
      }

      return reply.status(200).send({
        userId: doc.userId,
        username: doc.username,
        name: doc.name ?? null,
        avatarUrl: computePublicUrl(doc.avatarKey, doc.updatedAt),
        bannerUrl: computePublicUrl(doc.bannerKey, doc.updatedAt),
        bio: doc.bio ?? null,
        about: doc.about ?? null,
        messageRequestPolicy: doc.messageRequestPolicy || 'known',
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
      });
    }
  );
};
