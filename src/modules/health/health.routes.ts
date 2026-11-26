import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { isMongoHealthy } from '../../db/mongo.js';
import { isRedisHealthy } from '../../db/redis.js';
import { jwksService } from '../../auth/jwks.js';
import { env } from '../../config/env.js';
import { cleanupOrphanedMedia } from '../../jobs/cleanup-orphans.js';
import { cleanupExpiredStories } from '../../jobs/story-cleanup.js';
import { UnauthorizedError } from '../../utils/errors.js';

export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Public health check for load balancer / k8s / docker compose
  app.get(
    '/health',
    {
      schema: {
        description: 'Liveness and dependency readiness check',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              mongo: { type: 'string' },
              redis: { type: 'string' },
              jwks: { type: 'string' },
            },
            required: ['status', 'mongo', 'redis', 'jwks'],
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              mongo: { type: 'string' },
              redis: { type: 'string' },
              jwks: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const [mongoOk, redisOk] = await Promise.all([
        isMongoHealthy(),
        isRedisHealthy(),
      ]);
      const jwksOk = jwksService.isHealthy();

      const allHealthy = mongoOk && redisOk && jwksOk;
      const statusCode = allHealthy ? 200 : 503;

      return reply.status(statusCode).send({
        status: allHealthy ? 'ok' : 'degraded',
        mongo: mongoOk ? 'ok' : 'down',
        redis: redisOk ? 'ok' : 'down',
        jwks: jwksOk ? 'ok' : 'down',
      });
    }
  );

  // Internal health check for debugging JWKS cache age and details
  app.get(
    '/internal/health',
    {
      schema: {
        description: 'Internal debugging endpoint exposing JWKS cache status and age',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              jwks: {
                type: 'object',
                properties: {
                  isLoaded: { type: 'boolean' },
                  ageSeconds: { type: 'number', nullable: true },
                  lastFetchedAt: { type: 'string', nullable: true },
                  keyCount: { type: 'number' },
                  jwksUrl: { type: 'string' },
                  lastError: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const jwksStatus = jwksService.getStatus();
      return reply.status(200).send({
        status: 'ok',
        jwks: jwksStatus,
      });
    }
  );

  // Internal endpoint for cron-based orphaned media cleanup
  app.post(
    '/internal/cleanup-orphans',
    {
      schema: {
        description: 'Trigger cleanup of unconfirmed orphaned media files older than 24 hours',
        tags: ['Internal'],
        headers: {
          type: 'object',
          properties: {
            'x-internal-token': { type: 'string' },
            authorization: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const tokenHeader =
        (request.headers['x-internal-token'] as string) ||
        (request.headers.authorization?.replace(/^Bearer\s+/i, '') as string);

      if (!tokenHeader || tokenHeader !== env.INTERNAL_TOKEN) {
        throw new UnauthorizedError('Invalid or missing internal authorization token');
      }

      const result = await cleanupOrphanedMedia();
      return reply.status(200).send({
        status: 'ok',
        ...result,
      });
    }
  );

  // Internal endpoint for cron-based expired story cleanup
  app.post(
    '/internal/cleanup-stories',
    {
      schema: {
        description: 'Trigger cleanup of expired stories and their R2 objects',
        tags: ['Internal'],
        headers: {
          type: 'object',
          properties: {
            'x-internal-token': { type: 'string' },
            authorization: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const tokenHeader =
        (request.headers['x-internal-token'] as string) ||
        (request.headers.authorization?.replace(/^Bearer\s+/i, '') as string);

      if (!tokenHeader || tokenHeader !== env.INTERNAL_TOKEN) {
        throw new UnauthorizedError('Invalid or missing internal authorization token');
      }

      const result = await cleanupExpiredStories();
      return reply.status(200).send({
        status: 'ok',
        ...result,
      });
    }
  );
};
