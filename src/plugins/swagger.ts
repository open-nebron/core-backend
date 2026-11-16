import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Zenuxs Core API',
        description: 'Production-grade Core API service for Zenuxs microservice platform',
        version: '1.1.0',
      },
      servers: [
        {
          url: '/',
          description: 'Current environment',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'RS256 JWT issued by auth-service with audience "core"',
          },
        },
      },
      tags: [
        { name: 'Profile', description: 'User profile management' },
        { name: 'Media', description: 'Avatar and banner media uploads via Cloudflare R2' },
        { name: 'Meta', description: 'Public metadata and configuration limits' },
        { name: 'Health', description: 'System health and readiness checks' },
        { name: 'Internal', description: 'Internal operations and maintenance' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });
}
