import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { isMongoHealthy } from '../../db/mongo.js';
import { isRedisHealthy } from '../../db/redis.js';
import { jwksService } from '../../auth/jwks.js';

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
};
