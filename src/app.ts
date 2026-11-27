import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env, getAllowedOrigins } from './config/env.js';
import { fastifyErrorHandler } from './utils/errors.js';
import { registerSwagger } from './plugins/swagger.js';
import { profileRoutes } from './modules/profiles/profile.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { relationshipRoutes } from './modules/relationships/routes.js';
import { followRoutes } from './modules/social/follows/routes.js';
import { postRoutes } from './modules/social/posts/routes.js';
import { commentRoutes } from './modules/social/comments/routes.js';
import { hashtagRoutes } from './modules/social/hashtags/routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { storyRoutes } from './modules/stories/stories.routes.js';
import { reelRoutes } from './modules/reels/reels.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const isDev = env.NODE_ENV === 'development';

  const app = fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
    bodyLimit: 32768, // 32kb body limit as required
    trustProxy: true,
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // Allows Swagger UI to render correctly
  });

  // CORS configuration
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) {
        cb(null, true);
        return;
      }
      const allowedOrigins = getAllowedOrigins();
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });

  // Register OpenAPI Documentation
  await registerSwagger(app);

  // Set unified error handler
  app.setErrorHandler(fastifyErrorHandler);

  // Set 404 not found handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    });
  });

  // Register modules
  await app.register(healthRoutes);
  await app.register(profileRoutes);
  await app.register(relationshipRoutes);
  await app.register(followRoutes);
  await app.register(postRoutes);
  await app.register(commentRoutes);
  await app.register(hashtagRoutes);
  await app.register(userRoutes);
  await app.register(reportRoutes);
  await app.register(storyRoutes);
  await app.register(reelRoutes);

  return app;
}
